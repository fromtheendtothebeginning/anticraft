# features/campus_open.py — 校园服务开放接口（/api/campus-open/*）：供 App 等站外客户端调用
# 与站内 /api/campus/*（anticraft JWT 鉴权、凭据存 campus_creds 表）平行的一层：
# 调用方用校园学号+密码换 API token（内存态、30 天滑动续期），服务器负责连 VPN（EasyConnect
# 容器）、AI 自动过验证码并返回结构化数据。复用 campus_service 的会话/客户端单例与识图链路。
#
# 路由前缀不能用 /api/open/*（已被开放平台 account_binding 占用）。
# 学校侧约束：同一出口 IP 同时只能维持一条 VPN 隧道——隧道类接口多账号并发会互踢；
# 校园码/电费走校付宝公网直连，不占隧道。
# token 只存内存：服务重启后失效，客户端重新登录即可（VPN 会话同样随进程消亡）。

import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as OrmSession

import aisettings
from campus.dekt import DektError
from campus.ecard import EcardClient
from database import get_db
from deps import _client_ip, _log, _mask_sid
from models import CampusCred

import features.campus_service as cs
from campus import activities as act
from features.campus_ecard import _qr_png_base64
from features.electricity import _save_record

router = APIRouter()

TOKEN_TTL = 30 * 24 * 3600       # token 有效期 30 天，每次成功调用自动滑动续期
CONNECT_WAIT_SECONDS = 40        # 数据接口内等待 VPN 隧道建立的上限（nginx 60s 代理超时内留余量）
RETRY_AFTER = 5                  # vpn_connecting（202）时建议客户端的重试间隔（秒）
LOGIN_RATE_WINDOW = 300          # 登录接口限流窗口（秒）
LOGIN_RATE_MAX = 10              # 窗口内每 IP 最大登录尝试次数
OPEN_KEY_LOW = 100000            # 开放接口会话 key 保留段（避开真实 user_id 与会话池 900000 段，
OPEN_KEY_HIGH = 900000           #  这样会话池把开放会话当「用户会话」主动让位， borrowing 也不会误伤）
OPEN_SESSION_CAP = 5             # 开放接口最多同时维持的 VPN 会话数（防 token 撞库刷容器）

_tokens = {}                     # token -> rec；重启即空
_lock = threading.Lock()
_login_hits = {}                 # ip -> [登录尝试时间戳]
_open_key_seq = OPEN_KEY_LOW


class _Connecting(Exception):
    """VPN 隧道在等待窗口内未就绪（连接是异步的）：各数据接口转成 202 让客户端稍后重试"""


def _connecting():
    return JSONResponse(status_code=202,
                        content={"vpn_connecting": True, "retry_after": RETRY_AFTER})


# ============================================================
# token 管理
# ============================================================

def _open_token(request: Request) -> dict:
    """鉴权依赖：Authorization: Bearer <token>；成功即滑动续期"""
    auth = request.headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少 Bearer token，请先调用 /api/campus-open/auth")
    token = auth[7:].strip()
    with _lock:
        rec = _tokens.get(token)
        if rec is None:
            raise HTTPException(status_code=401, detail="token 无效或已失效（服务重启会清空），请重新登录")
        rec["expires"] = time.time() + TOKEN_TTL
    return rec


def _store_token(token, rec):
    with _lock:
        if len(_tokens) > 200:   # 惰性清理过期 token
            now = time.time()
            for t in [t for t, r in _tokens.items() if r["expires"] < now]:
                _tokens.pop(t, None)
        _tokens[token] = rec


def _throttle_login(request: Request):
    ip = _client_ip(request)
    now = time.time()
    with _lock:
        hits = [t for t in _login_hits.get(ip, []) if now - t < LOGIN_RATE_WINDOW]
        if len(hits) >= LOGIN_RATE_MAX:
            raise HTTPException(status_code=429, detail="登录尝试过于频繁，请稍后再试")
        hits.append(now)
        _login_hits[ip] = hits


# ============================================================
# VPN 会话（连接等待 + 开放会话 key 分配）
# ============================================================

def _alloc_open_key() -> int:
    global _open_key_seq
    with _lock:
        key = _open_key_seq
        _open_key_seq += 1
        if _open_key_seq >= OPEN_KEY_HIGH:
            _open_key_seq = OPEN_KEY_LOW
    return key


def _open_session_count(m) -> int:
    return sum(1 for k in m["sessions"].sessions if OPEN_KEY_LOW <= k < OPEN_KEY_HIGH)


def _create_session(m, key, sid, pwd):
    if OPEN_KEY_LOW <= key < OPEN_KEY_HIGH and _open_session_count(m) >= OPEN_SESSION_CAP:
        raise HTTPException(status_code=503, detail="开放接口 VPN 会话数已达上限，请稍后重试")
    try:
        m["sessions"].create(key, sid, pwd, ports=m["docker"].allocate_ports())
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=502, detail="VPN 会话创建失败：" + str(e))


def _ensure_session(m, rec):
    """确保该账号的 VPN 隧道已建立，等待至多 CONNECT_WAIT_SECONDS 秒；返回会话对象。

    连接是异步的（数十秒）：等待窗口内未就绪抛 _Connecting（→202）；
    登录失败（密码错误等）按错误内容转 401/502。
    """
    key, sid, pwd = rec["key"], rec["student_id"], rec["password"]
    sess = m["sessions"].get(key)
    if not sess or sess.status == "failed":
        _create_session(m, key, sid, pwd)
    deadline = time.time() + CONNECT_WAIT_SECONDS
    while True:
        sess = m["sessions"].get(key)
        if sess and sess.status == "connected" and m["docker"].tun_routes(sess) > 0:
            return sess
        if sess and sess.status == "failed":
            err = sess.error or "VPN 登录失败"
            code = 401 if ("密码" in err or "账号" in err) else 502
            raise HTTPException(status_code=code, detail=err)
        if time.time() >= deadline:
            raise _Connecting()
        time.sleep(1.5)


def _preconnect(rec):
    """登录时后台预热隧道（仅限已通过站内凭据校验的账号，防止撞库刷容器）；失败静默。"""
    try:
        m = cs._get_managers()
        if "error" in m:
            return
        sess = m["sessions"].get(rec["key"])
        if not sess or sess.status == "failed":
            _create_session(m, rec["key"], rec["student_id"], rec["password"])
    except Exception as e:
        _log(f"campus-open preconnect: {str(e)[:150]}")


# ============================================================
# 学工（CAS）/教务自动登录：AI 识码，与会话池同一套识图模型
# ============================================================

def _vision(db):
    from features.campus_pool import resolve_pool_vision
    return resolve_pool_vision()


def _ensure_xg(m, rec, db):
    """确保学工（统一身份认证）已登录，返回 DektClient。"""
    sess = _ensure_session(m, rec)
    client = m["dekt"].get(rec["key"], sess)
    if client.session is not None:
        return client
    vision = _vision(db)
    if not vision:
        raise HTTPException(status_code=503, detail="服务器未配置识图模型，无法自动完成登录，请联系站长")
    for _ in range(3):
        try:
            pending = client.prepare_login(rec["student_id"], rec["password"])
        except DektError as e:
            raise HTTPException(status_code=400, detail=str(e))
        if pending is None:
            return client
        if not pending.captcha:
            raise HTTPException(status_code=502, detail="登录验证码获取失败，请稍后重试")
        text = cs._ai_solve_captcha(cs._b64(pending.captcha), vision)
        if not text:
            raise HTTPException(status_code=502, detail="验证码识别失败，请稍后重试")
        try:
            client.complete_login(rec["student_id"], text)
            return client
        except DektError as e:
            _log(f"campus-open CAS 登录重试: {str(e)[:120]}")
    raise HTTPException(status_code=502, detail="统一身份认证自动登录未成功，请稍后重试")


def _ensure_jwxt(m, rec, db):
    """确保教务系统已登录，返回 DektClient。"""
    sess = _ensure_session(m, rec)
    client = m["dekt"].get(rec["key"], sess)
    if client.jwxt_session is not None:
        return client
    vision = _vision(db)
    if not vision:
        raise HTTPException(status_code=503, detail="服务器未配置识图模型，无法自动完成登录，请联系站长")
    for _ in range(3):
        try:
            pending = client.prepare_jwxt_login(rec["student_id"], rec["password"])
        except DektError as e:
            raise HTTPException(status_code=400, detail=str(e))
        if pending is None:
            return client
        if not pending.captcha:
            raise HTTPException(status_code=502, detail="登录验证码获取失败，请稍后重试")
        text = cs._ai_solve_captcha(cs._b64(pending.captcha), vision)
        if not text:
            raise HTTPException(status_code=502, detail="验证码识别失败，请稍后重试")
        try:
            client.complete_jwxt_login(rec["student_id"], text)
            return client
        except DektError as e:
            _log(f"campus-open 教务登录重试: {str(e)[:120]}")
    raise HTTPException(status_code=502, detail="教务系统自动登录未成功，请稍后重试")


# ============================================================
# 认证 / 会话管理
# ============================================================

class OpenAuthRequest(BaseModel):
    student_id: str = Field(..., description="学号")
    password: str = Field(..., description="校园统一身份认证密码（VPN/教务/学工同源）")
    real_name: str = ""
    pay_password: str = Field("", description="校付宝支付密码（校园码/电费用；学号已在网站配置过可省略）")
    dorm: str = Field("", description="寝室号（电费查询用；学号已在网站配置过可省略）")


@router.post("/api/campus-open/auth", tags=["校园开放接口"])
def open_auth(req: OpenAuthRequest, request: Request, db: OrmSession = Depends(get_db)):
    """账号密码换 API token。学号已在网站配置过校园凭据时：密码必须与已存 VPN 密码一致
    （不一致直接 401，不碰 VPN），支付密码/寝室/姓名缺省自动复用已存值。"""
    sid = (req.student_id or "").strip()
    pwd = req.password or ""
    if not sid or not pwd:
        raise HTTPException(status_code=400, detail="student_id 和 password 不能为空")
    _throttle_login(request)

    real_name = (req.real_name or "").strip()
    pay_password = req.pay_password or ""
    dorm = (req.dorm or "").strip()
    reuse_user_id = None
    cred = db.query(CampusCred).filter(CampusCred.student_id == sid).first()
    if cred is not None:
        stored = aisettings.decrypt_secret(cred.vpn_password_enc) if cred.vpn_password_enc else ""
        if stored != pwd:
            raise HTTPException(status_code=401, detail="账号或密码错误")
        reuse_user_id = cred.user_id   # 复用该用户的 VPN 会话，避免同账号双容器互踢
        real_name = real_name or (cred.real_name or "").strip()
        if not pay_password and cred.pay_password_enc:
            pay_password = aisettings.decrypt_secret(cred.pay_password_enc) or ""
        dorm = dorm or (cred.dorm or "").strip()

    token = secrets.token_urlsafe(32)
    rec = {"token": token, "student_id": sid, "password": pwd, "real_name": real_name,
           "pay_password": pay_password, "dorm": dorm,
           "key": reuse_user_id if reuse_user_id is not None else _alloc_open_key(),
           "expires": time.time() + TOKEN_TTL}
    _store_token(token, rec)
    if reuse_user_id is not None:
        threading.Thread(target=_preconnect, args=(rec,), daemon=True).start()

    m = cs._get_managers()
    session_payload = (cs._session_payload(m["sessions"].get(rec["key"]), m["docker"])
                       if "error" not in m else
                       {"connected": False, "status": "unavailable", "error": m["error"]})
    return {
        "ok": True,
        "token": token,
        "token_type": "Bearer",
        "expires_in": TOKEN_TTL,
        "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=TOKEN_TTL)).isoformat(),
        "student_id_masked": _mask_sid(sid),
        "real_name": real_name,
        "dorm": dorm,
        "has_pay_password": bool(pay_password),
        "session": session_payload,
    }


@router.get("/api/campus-open/status", tags=["校园开放接口"])
def open_status(rec: dict = Depends(_open_token)):
    """当前 token 账号的会话状态（隧道 + 学工/教务登录态）"""
    m = cs._get_managers()
    if "error" in m:
        return {"ok": True, "student_id_masked": _mask_sid(rec["student_id"]),
                "session": {"connected": False, "status": "unavailable", "error": m["error"]},
                "cas_ready": False, "jwxt_ready": False}
    sess = m["sessions"].get(rec["key"])
    client = m["dekt"].clients.get(rec["key"])
    return {"ok": True, "student_id_masked": _mask_sid(rec["student_id"]),
            "session": cs._session_payload(sess, m["docker"]),
            "cas_ready": bool(client and client.session is not None),
            "jwxt_ready": bool(client and client.jwxt_session is not None)}


@router.post("/api/campus-open/logout", tags=["校园开放接口"])
def open_logout(request: Request):
    """注销：token 立即失效，并断开该账号的 VPN 会话"""
    rec = _open_token(request)
    with _lock:
        _tokens.pop(rec.get("token"), None)
    m = cs._get_managers()
    if "error" not in m:
        m["sessions"].disconnect(rec["key"])
        m["dekt"].drop(rec["key"])
    return {"ok": True}


# ============================================================
# 隧道类数据接口（学工/教务，依赖 VPN；未就绪返回 202）
# ============================================================

@router.get("/api/campus-open/score", tags=["校园开放接口"])
def open_score(request: Request, db: OrmSession = Depends(get_db)):
    """第二课堂达标分数（德智体美劳细分）"""
    rec = _open_token(request)
    m = cs._mgrs()
    try:
        client = _ensure_xg(m, rec, db)
        return {"ok": True, "data": client.fetch_score(rec["student_id"])}
    except _Connecting:
        return _connecting()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/campus-open/grades", tags=["校园开放接口"])
def open_grades(request: Request, xnm: str = "", xqm: str = "",
                db: OrmSession = Depends(get_db)):
    """成绩单（含绩点）。xnm=学年（如 2025），xqm=学期码（第一学期 3 / 第二学期 12）；
    都不传=全部学期，并在 data.terms 里返回可选学期列表。"""
    rec = _open_token(request)
    m = cs._mgrs()
    try:
        client = _ensure_jwxt(m, rec, db)
        return {"ok": True, "data": client.fetch_grades(rec["student_id"], xnm=xnm, xqm=xqm)}
    except _Connecting:
        return _connecting()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/campus-open/activities", tags=["校园开放接口"])
def open_activities(request: Request, db: OrmSession = Depends(get_db)):
    """第二课堂活动列表（结构化看板视图）"""
    rec = _open_token(request)
    m = cs._mgrs()
    try:
        client = _ensure_xg(m, rec, db)
        return {"ok": True, "data": act.activities_payload(client)}
    except _Connecting:
        return _connecting()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/campus-open/activities/{aid}", tags=["校园开放接口"])
def open_activity_detail(aid: str, request: Request, db: OrmSession = Depends(get_db)):
    """单个活动详情（hdms 活动说明全文 + 名额/报名线索）"""
    rec = _open_token(request)
    m = cs._mgrs()
    try:
        client = _ensure_xg(m, rec, db)
        data = client.fetch_activity_detail(aid)
    except _Connecting:
        return _connecting()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    hdms = str(data.get("hdms") or "")
    return {"ok": True, "data": {"id": aid, "hdms": hdms,
                                 "quota": act.extract_quota(hdms),
                                 "signup": act.extract_signup(hdms)}}


class OpenWeekRequest(BaseModel):
    xnm: str = ""
    xqm: str = ""
    zs: int = Field(1, ge=1, le=40, description="周次（第几周，1 起）")


@router.post("/api/campus-open/timetable/week", tags=["校园开放接口"])
def open_timetable_week(req: OpenWeekRequest, request: Request,
                        db: OrmSession = Depends(get_db)):
    """课表单周查询（教务移动端接口）：courses + 该周日期安排 + 学期名/年级"""
    rec = _open_token(request)
    m = cs._mgrs()
    try:
        client = _ensure_jwxt(m, rec, db)
        data = client.fetch_kbcx(rec["student_id"], xnm=req.xnm, xqm=req.xqm, zs=req.zs)
    except _Connecting:
        return _connecting()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "zs": req.zs, **data}


class OpenExamRequest(BaseModel):
    xnm: str = ""
    xqm: str = ""


@router.post("/api/campus-open/timetable/exams", tags=["校园开放接口"])
def open_timetable_exams(req: OpenExamRequest, request: Request,
                         db: OrmSession = Depends(get_db)):
    """考试安排查询（教务考试查询）：结构化考试列表"""
    rec = _open_token(request)
    m = cs._mgrs()
    try:
        client = _ensure_jwxt(m, rec, db)
        return {"ok": True, "exams": client.fetch_exams(xnm=req.xnm, xqm=req.xqm)}
    except _Connecting:
        return _connecting()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ============================================================
# 校付宝直连接口（校园码/电费，不占 VPN 隧道；需要支付密码）
# ============================================================

def _require_pay(rec):
    if not rec["pay_password"]:
        raise HTTPException(status_code=400,
                            detail="缺少校付宝支付密码：登录时传 pay_password（或先在网站配置校园凭据）")
    return rec["student_id"], rec["real_name"], rec["pay_password"]


@router.get("/api/campus-open/ecard", tags=["校园开放接口"])
def open_ecard(request: Request):
    """校园码（付款码）+ 校园卡余额；code 55 秒刷新"""
    rec = _open_token(request)
    student_id, real_name, pay_pwd = _require_pay(rec)
    try:
        result = EcardClient().qrcode_and_balance(student_id, real_name, pay_pwd)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"校园码获取失败：{e}")
    code = result["code"]
    return {"ok": True, "data": {"image": _qr_png_base64(code), "type": "image/png",
                                 "code": code, "card_balance": result.get("balance"),
                                 "refresh": 55}}


@router.post("/api/campus-open/electricity/query", tags=["校园开放接口"])
def open_electricity_query(request: Request, db: OrmSession = Depends(get_db)):
    """宿舍电费余额查询（公网直连）。能对上站内用户时顺带落电费历史记录（与站内手动查询同口径）。"""
    rec = _open_token(request)
    student_id, real_name, pay_pwd = _require_pay(rec)
    dorm = (rec["dorm"] or "").strip()
    if not dorm:
        raise HTTPException(status_code=400, detail="缺少寝室号：登录时传 dorm")
    from campus.electricity import ElectricityClient

    try:
        result = ElectricityClient().query(student_id, real_name, pay_pwd, dorm)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"电费查询失败：{e}")
    cred = db.query(CampusCred).filter(CampusCred.student_id == student_id).first()
    if cred and (cred.dorm or "").strip() == dorm:
        _save_record(db, cred.user_id, dorm, result.get("balance"),
                     result.get("remain"), result.get("raw"))
    return {"ok": True, "data": {"balance": result.get("balance"),
                                 "card_balance": result.get("card_balance"),
                                 "remain": result.get("remain"), "dorm": dorm}}


class OpenRechargeRequest(BaseModel):
    amount: float = Field(..., description="充值金额（元），0.01 - 500")


@router.post("/api/campus-open/electricity/recharge", tags=["校园开放接口"])
def open_electricity_recharge(req: OpenRechargeRequest, request: Request,
                              db: OrmSession = Depends(get_db)):
    """缴纳电费（公网直连，只调用一次、绝不重试——避免重复扣款，客户端勿自行重试本接口）"""
    if not (0 < req.amount <= 500):
        raise HTTPException(status_code=400, detail="金额须在 0.01 - 500 元之间")
    rec = _open_token(request)
    student_id, real_name, pay_pwd = _require_pay(rec)
    dorm = (rec["dorm"] or "").strip()
    if not dorm:
        raise HTTPException(status_code=400, detail="缺少寝室号：登录时传 dorm")
    from campus.electricity import ElectricityClient

    try:
        result = ElectricityClient().recharge(student_id, real_name, pay_pwd, dorm, req.amount)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"充值失败：{e}")
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("message") or "充值失败")

    # 支付成功：无论复查是否成功都必须落一条记录（否则充值金额丢失）
    new_balance = new_remain = query_raw = None
    try:
        q = ElectricityClient().query(student_id, real_name, pay_pwd, dorm)
        new_balance, new_remain, query_raw = q.get("balance"), q.get("remain"), q.get("raw")
    except Exception:
        pass
    cred = db.query(CampusCred).filter(CampusCred.student_id == student_id).first()
    if cred and (cred.dorm or "").strip() == dorm:
        _save_record(db, cred.user_id, dorm, new_balance, new_remain,
                     {"recharge": result.get("raw"), "query_after": query_raw},
                     recharge_amount=result.get("amount"))
    return {"ok": True, "message": result.get("message") or "充值成功",
            "data": {"balance": new_balance, "card_balance": result.get("balance"),
                     "amount": result.get("amount")}}
