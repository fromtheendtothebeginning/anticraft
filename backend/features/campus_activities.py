# features/campus_activities.py — 第二课堂活动查询（学工「活动报名」引导页看板）
# 适配自 Second_Class_Notification：列表 getHdgcHdList.zf + 详情 details.zf(hdms 活动说明)。
# 会话选路：自己已连接的会话 → 借道其他成员已登录学工的会话 → 有凭据自动连自己。
# 活动是公开数据，现场有其他成员在线时零凭据也可借道查看；
# 个人数据（分数/成绩/校园卡）永远只走用户自己的会话。
# 路由不用 /api/campus/query/activities：campus_service 的通配路由 POST /api/campus/query/{kind}
# 按字母序先注册会把它拦走。

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as OrmSession

from campus import activities as act
from database import get_db
from deps import get_current_user_obj
from models import User

router = APIRouter()


def _query_captcha_flow(m, sess, client, current_user, db):
    """自己会话未登录学工时：auto_captcha 开启走 AI 识码，否则发验证码给前端。"""
    import features.campus_service as cs

    cred = cs._load_cred(current_user, db)
    if client.session is None:
        prepare = lambda: client.prepare_login(sess.student_id, sess.password)
        if cred.auto_captcha:
            r, pending = cs._auto_captcha_flow(client, sess, current_user.id, db,
                                               "activities", prepare, cs.QueryRequest())
            if r is not None:
                return r
        else:
            pending = cs._safe_prepare(client, prepare)
        if pending is not None:
            return {"need_captcha": True, "kind": "activities",
                    "captcha_base64": cs._b64(pending.captcha)}
    return None


def _borrow_client(m):
    """借一个其他成员已连接且已登录学工的会话客户端查公开数据（活动）。

    只要现场有任何人连着 VPN 且登录过学工，活动列表就应可查
    ——活动是公开数据，谁的会话取回来都一样；绝不借用个人会话查个人数据。
    """
    sessions, dekt = m["sessions"], m["dekt"]
    for uid in list(dekt.clients):
        sess = sessions.get(uid)
        if sess is None or sess.status != "connected":
            continue
        client = dekt.get(uid, sess)   # 端口已变时自动重建（新客户端 session 为 None）
        if client.session is not None:
            return client
    return None


_NO_CRED_DETAIL = "尚未填写校园服务凭据：请到「我的 → 校园服务」填写学号与 VPN 密码后查询活动"


@router.post("/api/campus/activities", tags=["校园服务"])
def campus_activities(current_user: User = Depends(get_current_user_obj),
                      db: OrmSession = Depends(get_db)):
    """第二课堂活动列表；VPN 未连接返回 vpn_connecting，首次学工登录走验证码流程"""
    import features.campus_service as cs
    from campus.dekt import DektError

    m = cs._mgrs()

    # 1) 自己已连接的会话优先
    sess = m["sessions"].get(current_user.id)
    if sess and sess.status == "connected":
        client = m["dekt"].get(current_user.id, sess)
        r = _query_captcha_flow(m, sess, client, current_user, db)
        if r is not None:
            return r
        try:
            return {"ok": True, "data": act.activities_payload(client)}
        except DektError as e:
            raise HTTPException(status_code=400, detail=str(e))

    # 2) 借道其他成员已登录学工的会话（活动是公开数据，谁的会话取回都一样）
    client = _borrow_client(m)
    if client is not None:
        try:
            return {"ok": True, "data": act.activities_payload(client), "via_pool": True}
        except DektError:
            pass   # 该客户端登录态也失效，继续回退

    # 3) 有凭据才自动连接自己的会话
    try:
        cs._load_cred(current_user, db)
    except HTTPException:
        raise HTTPException(
            status_code=400,
            detail=_NO_CRED_DETAIL)
    try:
        sess, client, cred = cs._connected_client(current_user, db)
    except cs._VpnConnecting:
        return {"vpn_connecting": True}
    r = _query_captcha_flow(m, sess, client, current_user, db)
    if r is not None:
        return r
    try:
        return {"ok": True, "data": act.activities_payload(client)}
    except DektError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/campus/activities/{aid}/detail", tags=["校园服务"])
def campus_activity_detail(aid: str, current_user: User = Depends(get_current_user_obj),
                           db: OrmSession = Depends(get_db)):
    """单个活动详情（hdms 活动说明全文 + 名额/报名线索解析）"""
    import features.campus_service as cs
    from campus.dekt import DektError

    m = cs._mgrs()

    sess = m["sessions"].get(current_user.id)
    if sess and sess.status == "connected":
        client = m["dekt"].get(current_user.id, sess)
        if client.session is None:
            raise HTTPException(status_code=400, detail="学工登录已失效，请重新查询活动列表")
        try:
            data = client.fetch_activity_detail(aid)
        except DektError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return _detail_payload(aid, data)

    client = _borrow_client(m)
    if client is not None:
        try:
            return _detail_payload(aid, client.fetch_activity_detail(aid), own=False)
        except DektError:
            pass   # 该客户端登录态也失效，继续回退

    try:
        cs._load_cred(current_user, db)
    except HTTPException:
        raise HTTPException(status_code=400, detail=_NO_CRED_DETAIL)
    try:
        sess, client, cred = cs._connected_client(current_user, db)
    except cs._VpnConnecting:
        return {"vpn_connecting": True}
    if client.session is None:
        raise HTTPException(status_code=400, detail="学工登录已失效，请重新查询活动列表")
    try:
        data = client.fetch_activity_detail(aid)
    except DektError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _detail_payload(aid, data)


def _detail_payload(aid, data, own=True):
    """own=False 表示数据来自共享池/借道会话：bm（本人是否已报名）是个人字段，
    别人的会话取回的不可信，不透传（前端仅在 signed===true 时标记）。"""
    hdms = str(data.get("hdms") or "")
    signed = (str(data.get("bm")) == "1") if own else None
    return {"ok": True, "data": {"id": aid, "hdms": hdms,
                                 "signed": signed,
                                 "quota": act.extract_quota(hdms),
                                 "signup": act.extract_signup(hdms)}}


class ActivitySignupRequest(BaseModel):
    grjs: str = Field("", max_length=200)
    grgzjl: str = Field("", max_length=500)
    hjry: str = Field("", max_length=200)
    bmyy: str = Field("", max_length=500)
    zyjn: str = Field("", max_length=200)


@router.post("/api/campus/activities/{aid}/signup", tags=["校园服务"])
def campus_activity_signup(aid: str, req: ActivitySignupRequest,
                           current_user: User = Depends(get_current_user_obj),
                           db: OrmSession = Depends(get_db)):
    """第二课堂活动报名（学工工作流 hdsq.zf）。个人写操作：只用自己的会话/凭据，
    绝不走共享池或借道（池只能查公开数据，替不了报名）；提交一次、绝不重试。"""
    import features.campus_service as cs
    from campus.dekt import DektError

    m = cs._mgrs()
    extras = {"grjs": req.grjs, "grgzjl": req.grgzjl, "hjry": req.hjry,
              "bmyy": req.bmyy, "zyjn": req.zyjn}

    def _run(client):
        try:
            return {"ok": True, "data": client.signup_activity(aid, extras)}
        except DektError as e:
            raise HTTPException(status_code=400, detail=str(e))

    sess = m["sessions"].get(current_user.id)
    if sess and sess.status == "connected":
        client = m["dekt"].get(current_user.id, sess)
        r = _query_captcha_flow(m, sess, client, current_user, db)
        if r is not None:
            return r
        return _run(client)

    # 未连接：有凭据才自动连；无凭据直接引导配置（共享池帮不了报名）
    try:
        cs._load_cred(current_user, db)
    except HTTPException:
        raise HTTPException(
            status_code=400,
            detail="报名需要使用你自己的校园账号，请先到「我的 → 校园服务」配置学号与 VPN 密码")
    try:
        sess, client, cred = cs._connected_client(current_user, db)
    except cs._VpnConnecting:
        return {"vpn_connecting": True}
    r = _query_captcha_flow(m, sess, client, current_user, db)
    if r is not None:
        return r
    return _run(client)
