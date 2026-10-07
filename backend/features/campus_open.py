# features/campus_open.py — 校园服务开放接口（/api/campus-open/*）：供 App 等站外客户端调用
# 鉴权与站内完全同源：anticraft 账号 POST /api/login 换 30 天 JWT（Bearer，/api/refresh 滑动续期），
# 校园数据一律取自该账号在「我的 → 校园服务」配置的凭据（campus_creds），API 本身不经手校园密码。
# 相比站内 /api/campus/* 的 App 友好差异：VPN 连接在请求内等待 ≤40s（未就绪回 202 让客户端稍后
# 重试），学工/教务验证码先 AI 自动识别（需账号开启 auto_captcha + 配置识图模型），走不通时
# 返回 need_captcha 让 App 弹手动输入框（提交 /api/campus-open/captcha，换一张 GET 同路径）。
# 复用 campus_service 的会话/客户端单例，会话 key=user_id 与站内完全一致（App 与网页共享同一条隧道）。
# 学校侧约束：同一出口 IP 同时只有一条 VPN 隧道，隧道类接口多账号并发会互踢；
# 校园码/电费走校付宝公网直连，不占隧道。

import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as OrmSession

from campus.dekt import DektError
from campus.ecard import EcardClient
from database import get_db
from deps import _log, _mask_sid, get_current_user_obj
from models import CampusCred, User

import features.campus_service as cs
from campus import activities as act
from features.campus_ecard import _qr_png_base64
from features.campus_ecard import _secrets as _ecard_secrets
from features.electricity import (
    _cred_and_secrets, _is_network_error, _own_connected_session, _save_record,
)
from features.electricity import electricity_history as _web_electricity_history

router = APIRouter()

CONNECT_WAIT_SECONDS = 40        # 数据接口内等待 VPN 隧道建立的上限（nginx 60s 代理超时内留余量）
RETRY_AFTER = 5                  # vpn_connecting（202）时建议客户端的重试间隔（秒）


class _Connecting(Exception):
    """VPN 隧道在等待窗口内未就绪（连接是异步的）：各数据接口转成 202 让客户端稍后重试"""


def _need_captcha_payload(e):
    """need_captcha 的统一应答：取一张新验证码交回客户端弹手动输入框（与网站站内流程同款）"""
    return JSONResponse(status_code=200,
                        content={"need_captcha": True, "mode": e.mode,
                                 "captcha_base64": cs._b64(e.captcha)})


class _NeedCaptcha(Exception):
    """登录需要验证码但无法自动识别（未开 AI 识码 / 未配识图模型 / 识图失败）：
    各数据接口转成 need_captcha 让客户端手动输入，提交走 POST /api/campus-open/captcha"""

    def __init__(self, mode, captcha):
        self.mode = mode
        self.captcha = captcha  # 验证码图片 bytes


def _connecting():
    return JSONResponse(status_code=202,
                        content={"vpn_connecting": True, "retry_after": RETRY_AFTER})


# ============================================================
# 会话与自动登录（anticraft 用户维度，key=user_id 与站内一致，天然复用同一条隧道）
# ============================================================

def _ensure_connected(m, user_id, sid, vpn_pwd):
    """确保该用户 VPN 隧道已建立（站内同款会话），等待至多 CONNECT_WAIT_SECONDS。

    连接是异步的（数十秒）：等待窗口内未就绪抛 _Connecting（→202）；
    登录失败（密码错误等）按错误内容转 401/502。
    """
    sess = m["sessions"].get(user_id)
    if not sess or sess.status == "failed":
        try:
            m["sessions"].create(user_id, sid, vpn_pwd)
        except (ValueError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail="VPN 会话创建失败：" + str(e))
    deadline = time.time() + CONNECT_WAIT_SECONDS
    while True:
        sess = m["sessions"].get(user_id)
        if sess and sess.status == "connected" and m["docker"].tun_routes(sess) > 0:
            return sess
        if sess and sess.status == "failed":
            err = sess.error or "VPN 登录失败"
            raise HTTPException(status_code=401 if ("密码" in err or "账号" in err) else 502, detail=err)
        if time.time() >= deadline:
            raise _Connecting()
        time.sleep(1.5)


def _auto_login(client, sess, cred, user_id, db, mode):
    """确保学工(CAS)/教务已登录：先尝试 AI 识码（需账号开启 auto_captcha + 配置识图模型），
    走不通（未开/未配/识图失败/3 轮识别全错）退回手动——抛 _NeedCaptcha 让客户端弹验证码框，
    与网站站内 need_captcha 流程一致，不再给死路 400。

    mode: "xg"=学工统一身份认证（分数/活动），"jwxt"=教务系统（成绩/课表/考试）。
    """
    if (client.session if mode == "xg" else client.jwxt_session) is not None:
        return client
    prepare = client.prepare_login if mode == "xg" else client.prepare_jwxt_login
    complete = client.complete_login if mode == "xg" else client.complete_jwxt_login
    name = "统一身份认证" if mode == "xg" else "教务系统"
    if cred.auto_captcha:
        vision = cs._resolve_vision_model(user_id, db)
        if vision:
            for _ in range(3):
                try:
                    pending = prepare(sess.student_id, sess.password)
                except DektError as e:
                    raise HTTPException(status_code=400, detail=str(e))
                if pending is None:
                    return client
                if not pending.captcha:
                    raise HTTPException(status_code=502, detail="登录验证码获取失败，请稍后重试")
                text = cs._ai_solve_captcha(cs._b64(pending.captcha), vision)
                if not text:
                    break  # 识图失败 → 降级手动
                try:
                    complete(sess.student_id, text)
                    return client
                except DektError as e:
                    _log(f"campus-open {name}登录重试: {str(e)[:120]}")
    # 手动兜底：被登录尝试消耗过的验证码不能退回，取一张全新的交回客户端
    try:
        pending = prepare(sess.student_id, sess.password)
    except DektError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if pending is None:
        return client
    if not pending.captcha:
        raise HTTPException(status_code=502, detail="登录验证码获取失败，请稍后重试")
    raise _NeedCaptcha(mode, pending.captcha)


def _tunnel_client(current_user, db, mode):
    """隧道类接口公共前奏：加载凭据 → 确保隧道 → 确保登录，返回 (client, cred)。

    凭据缺失 400 先于 Docker 检查（未配置账号拿到的是引导信息而非基础设施报错）。
    """
    cred = cs._load_cred(current_user, db)
    vpn_pwd = cs._decrypt_or_400(cred.vpn_password_enc)
    m = cs._mgrs()
    sess = _ensure_connected(m, current_user.id, cred.student_id, vpn_pwd)
    client = m["dekt"].get(current_user.id, sess)
    return _auto_login(client, sess, cred, current_user.id, db, mode), cred


def _manual_client(current_user, db, mode):
    """验证码提交/换一张用的前奏：确保隧道与客户端，但不触发 _auto_login（否则又弹 need_captcha）。"""
    if mode not in ("xg", "jwxt"):
        raise HTTPException(status_code=400, detail="mode 须为 xg（统一身份认证）或 jwxt（教务系统）")
    m = cs._get_managers()
    if "error" in m:
        raise HTTPException(status_code=503, detail="校园基础设施不可用：" + m["error"])
    cred = cs._load_cred(current_user, db)
    vpn_pwd = cs._decrypt_or_400(cred.vpn_password_enc)
    sess = _ensure_connected(m, current_user.id, cred.student_id, vpn_pwd)
    return m["dekt"].get(current_user.id, sess), sess


class OpenCaptchaRequest(BaseModel):
    mode: str = Field(..., description="xg=统一身份认证，jwxt=教务系统")
    captcha: str = Field(..., min_length=1, max_length=10, description="用户输入的验证码")


@router.post("/api/campus-open/captcha", tags=["校园开放接口"])
def open_captcha_submit(req: OpenCaptchaRequest,
                        current_user: User = Depends(get_current_user_obj),
                        db: OrmSession = Depends(get_db)):
    """提交手动验证码完成登录（配合数据接口的 need_captcha 响应）。
    成功后重试原数据请求即可；验证码错误回 400 detail（含「验证码」→ 换一张重输，其他直接提示）。"""
    client, _sess = _manual_client(current_user, db, req.mode)
    name = "统一身份认证" if req.mode == "xg" else "教务系统"
    try:
        if req.mode == "jwxt":
            client.complete_jwxt_login(client.student_id, req.captcha.strip())
        else:
            client.complete_login(client.student_id, req.captcha.strip())
    except DektError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _log(f"campus-open {name} 手动验证码登录成功 user={current_user.id}")
    return {"ok": True}


@router.get("/api/campus-open/captcha", tags=["校园开放接口"])
def open_captcha_refresh(mode: str = "xg",
                         current_user: User = Depends(get_current_user_obj),
                         db: OrmSession = Depends(get_db)):
    """换一张验证码（need_captcha 之后用户点「换一张」）：重新 prepare 取新验证码图。
    会话期间已被其他途径登录成功时返回 logged_in=true，客户端直接重试原请求。"""
    client, sess = _manual_client(current_user, db, mode)
    prepare = client.prepare_jwxt_login if mode == "jwxt" else client.prepare_login
    try:
        pending = prepare(sess.student_id, sess.password)
    except DektError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if pending is None:
        return {"ok": True, "logged_in": True}
    if not pending.captcha:
        raise HTTPException(status_code=502, detail="登录验证码获取失败，请稍后重试")
    return {"ok": True, "logged_in": False, "captcha_base64": cs._b64(pending.captcha)}


# ============================================================
# 会话状态 / 断开
# ============================================================

@router.get("/api/campus-open/status", tags=["校园开放接口"])
def open_status(current_user: User = Depends(get_current_user_obj), db: OrmSession = Depends(get_db)):
    """当前账号的校园服务配置与 VPN 会话状态（App 据此引导用户去网站配置缺项）"""
    c = db.query(CampusCred).filter(CampusCred.user_id == current_user.id).first()
    configured = bool(c and c.student_id)
    m = cs._get_managers()
    if "error" in m:
        session = {"connected": False, "status": "unavailable", "error": m["error"]}
        client = None
    else:
        sess = m["sessions"].get(current_user.id)
        session = cs._session_payload(sess, m["docker"])
        client = m["dekt"].clients.get(current_user.id)
    return {"ok": True, "configured": configured,
            "student_id_masked": _mask_sid(c.student_id) if configured else None,
            "has_pay_password": bool(c and c.pay_password_enc),
            "has_dorm": bool(c and (c.dorm or "").strip()),
            "auto_captcha": bool(c and c.auto_captcha),
            "session": session,
            "cas_ready": bool(client and client.session is not None),
            "jwxt_ready": bool(client and client.jwxt_session is not None)}


@router.post("/api/campus-open/disconnect", tags=["校园开放接口"])
def open_disconnect(current_user: User = Depends(get_current_user_obj)):
    """断开当前账号的 VPN 会话（释放隧道；下次数据调用会自动重连）"""
    m = cs._get_managers()
    if "error" not in m:
        m["sessions"].disconnect(current_user.id)
        m["dekt"].drop(current_user.id)
    return {"ok": True}


# ============================================================
# 隧道类数据接口（学工/教务，依赖 VPN；未就绪返回 202）
# ============================================================

@router.get("/api/campus-open/score", tags=["校园开放接口"])
def open_score(current_user: User = Depends(get_current_user_obj), db: OrmSession = Depends(get_db)):
    """第二课堂达标分数（德智体美劳细分）"""
    try:
        client, cred = _tunnel_client(current_user, db, "xg")
        return {"ok": True, "data": client.fetch_score(cred.student_id)}
    except _Connecting:
        return _connecting()
    except _NeedCaptcha as e:
        return _need_captcha_payload(e)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/campus-open/grades", tags=["校园开放接口"])
def open_grades(request: Request, xnm: str = "", xqm: str = "",
                current_user: User = Depends(get_current_user_obj),
                db: OrmSession = Depends(get_db)):
    """成绩单（含绩点）。xnm=学年（如 2025），xqm=学期码（第一学期 3 / 第二学期 12）；
    都不传=全部学期，并在 data.terms 里返回可选学期列表。"""
    try:
        client, cred = _tunnel_client(current_user, db, "jwxt")
        return {"ok": True, "data": client.fetch_grades(cred.student_id, xnm=xnm, xqm=xqm)}
    except _Connecting:
        return _connecting()
    except _NeedCaptcha as e:
        return _need_captcha_payload(e)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/campus-open/activities", tags=["校园开放接口"])
def open_activities(current_user: User = Depends(get_current_user_obj), db: OrmSession = Depends(get_db)):
    """第二课堂活动列表（结构化看板视图）"""
    try:
        client, _cred = _tunnel_client(current_user, db, "xg")
        return {"ok": True, "data": act.activities_payload(client)}
    except _Connecting:
        return _connecting()
    except _NeedCaptcha as e:
        return _need_captcha_payload(e)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/campus-open/activities/{aid}", tags=["校园开放接口"])
def open_activity_detail(aid: str, current_user: User = Depends(get_current_user_obj),
                         db: OrmSession = Depends(get_db)):
    """单个活动详情（hdms 活动说明全文 + 名额/报名线索）"""
    try:
        client, _cred = _tunnel_client(current_user, db, "xg")
        data = client.fetch_activity_detail(aid)
    except _Connecting:
        return _connecting()
    except _NeedCaptcha as e:
        return _need_captcha_payload(e)
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
def open_timetable_week(req: OpenWeekRequest, current_user: User = Depends(get_current_user_obj),
                        db: OrmSession = Depends(get_db)):
    """课表单周查询（教务移动端接口）：courses + 该周日期安排 + 学期名/年级"""
    try:
        client, cred = _tunnel_client(current_user, db, "jwxt")
        data = client.fetch_kbcx(cred.student_id, xnm=req.xnm, xqm=req.xqm, zs=req.zs)
    except _Connecting:
        return _connecting()
    except _NeedCaptcha as e:
        return _need_captcha_payload(e)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "zs": req.zs, **data}


class OpenExamRequest(BaseModel):
    xnm: str = ""
    xqm: str = ""


@router.post("/api/campus-open/timetable/exams", tags=["校园开放接口"])
def open_timetable_exams(req: OpenExamRequest, current_user: User = Depends(get_current_user_obj),
                         db: OrmSession = Depends(get_db)):
    """考试安排查询（教务考试查询）：结构化考试列表"""
    try:
        client, _cred = _tunnel_client(current_user, db, "jwxt")
        return {"ok": True, "exams": client.fetch_exams(xnm=req.xnm, xqm=req.xqm)}
    except _Connecting:
        return _connecting()
    except _NeedCaptcha as e:
        return _need_captcha_payload(e)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ============================================================
# 校付宝直连接口（校园码/电费，不占 VPN 隧道；凭据取网站配置）
# ============================================================

@router.get("/api/campus-open/ecard", tags=["校园开放接口"])
def open_ecard(current_user: User = Depends(get_current_user_obj), db: OrmSession = Depends(get_db)):
    """校园码（付款码）+ 校园卡余额（校付宝公网直连）；code 55 秒刷新"""
    student_id, real_name, pay_pwd = _ecard_secrets(current_user, db)
    try:
        result = EcardClient().qrcode_and_balance(student_id, real_name, pay_pwd)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"校园码获取失败：{e}")
    code = result["code"]
    return {"ok": True, "data": {"image": _qr_png_base64(code), "type": "image/png",
                                 "code": code, "card_balance": result.get("balance"),
                                 "refresh": 55}}


@router.post("/api/campus-open/electricity/query", tags=["校园开放接口"])
def open_electricity_query(current_user: User = Depends(get_current_user_obj),
                           db: OrmSession = Depends(get_db)):
    """宿舍电费余额（校付宝直连；网络类失败且本人 VPN 已连接时借道本人隧道重试一次），
    结果写入站内电费历史（与网站折线图同口径）"""
    from campus.electricity import ElectricityClient

    cred, dorm, real_name, pay_pwd = _cred_and_secrets(current_user, db)
    try:
        result = ElectricityClient().query(cred.student_id, real_name, pay_pwd, dorm)
    except Exception as e:
        sess = _own_connected_session(current_user.id) if _is_network_error(e) else None
        if sess is None:
            raise HTTPException(status_code=400, detail=f"电费查询失败：{e}")
        try:
            result = ElectricityClient(proxy_host="127.0.0.1", socks_port=sess.socks_port).query(
                cred.student_id, real_name, pay_pwd, dorm)
        except Exception as e2:
            raise HTTPException(status_code=400, detail=f"电费查询失败：{e2}")
    _save_record(db, current_user.id, dorm, result.get("balance"),
                 result.get("remain"), result.get("raw"))
    return {"ok": True, "data": {"balance": result.get("balance"),
                                 "card_balance": result.get("card_balance"),
                                 "remain": result.get("remain"), "dorm": dorm}}


@router.get("/api/campus-open/electricity/history", tags=["校园开放接口"])
def open_electricity_history(days: int = 90, current_user: User = Depends(get_current_user_obj),
                             db: OrmSession = Depends(get_db)):
    """电费历史记录（最近 N 天 1~365，时间升序）——网站折线图同源数据"""
    return _web_electricity_history(days=days, current_user=current_user, db=db)


class OpenRechargeRequest(BaseModel):
    amount: float = Field(..., description="充值金额（元），0.01 - 500")


@router.post("/api/campus-open/electricity/recharge", tags=["校园开放接口"])
def open_electricity_recharge(req: OpenRechargeRequest,
                              current_user: User = Depends(get_current_user_obj),
                              db: OrmSession = Depends(get_db)):
    """缴纳电费（直连，只调用一次、绝不重试——避免重复扣款，客户端勿自行重试本接口）"""
    if not (0 < req.amount <= 500):
        raise HTTPException(status_code=400, detail="金额须在 0.01 - 500 元之间")
    from campus.electricity import ElectricityClient

    cred, dorm, real_name, pay_pwd = _cred_and_secrets(current_user, db)
    try:
        result = ElectricityClient().recharge(cred.student_id, real_name, pay_pwd, dorm, req.amount)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"充值失败：{e}")
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("message") or "充值失败")

    # 支付成功：无论复查是否成功都必须落一条记录（否则充值金额丢失）
    new_balance = new_remain = query_raw = None
    try:
        q = ElectricityClient().query(cred.student_id, real_name, pay_pwd, dorm)
        new_balance, new_remain, query_raw = q.get("balance"), q.get("remain"), q.get("raw")
    except Exception:
        pass
    _save_record(db, current_user.id, dorm, new_balance, new_remain,
                 {"recharge": result.get("raw"), "query_after": query_raw},
                 recharge_amount=result.get("amount"))
    return {"ok": True, "message": result.get("message") or "充值成功",
            "data": {"balance": new_balance, "card_balance": result.get("balance"),
                     "amount": result.get("amount")}}
