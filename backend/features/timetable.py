# 课程表云端存储 —— 每用户一份 JSON（多学期结构），前端以数据内的 updatedAt 做最后写入胜合并

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy.orm import Session as OrmSession

from database import get_db
from deps import get_current_user_obj
from models import User, UserTimetable

router = APIRouter()

MAX_DATA_BYTES = 512 * 1024  # 多学期课表（每学期含原始周数据）大小上限，防滥用


class TimetablePayload(BaseModel):
    data: dict = Field(..., description="课程表数据对象（学期信息 + courses 数组）")


@router.get("/api/timetable", tags=["课程表"])
def get_timetable(current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    row = db.query(UserTimetable).filter(UserTimetable.user_id == current_user.id).first()
    return {"data": row.data if row else None, "updated_at": row.updated_at if row else None}


@router.put("/api/timetable", tags=["课程表"])
def put_timetable(payload: TimetablePayload, current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    raw = json.dumps(payload.data, ensure_ascii=False)
    if len(raw.encode("utf-8")) > MAX_DATA_BYTES:
        raise HTTPException(status_code=413, detail="课程表数据过大")
    row = db.query(UserTimetable).filter(UserTimetable.user_id == current_user.id).first()
    if row is None:
        row = UserTimetable(user_id=current_user.id, data=payload.data)
        db.add(row)
    else:
        row.data = payload.data
    db.commit()
    return {"ok": True, "updated_at": row.updated_at}


# ============================================================
# 课程表导入：走教务系统移动端课表接口（按周），前端逐周遍历
# ============================================================

from features.campus_service import (  # noqa: E402  复用校园服务的会话/借道/AI识码机制
    _VpnConnecting, _connected_client, _safe_prepare, _b64,
    _load_cred, _resolve_vision_model, _ai_solve_captcha, _log,
)
from campus.dekt import DektError


class TtImportRequest(BaseModel):
    xnm: str = ""
    xqm: str = ""
    zs: int = Field(1, ge=1, le=40)
    captcha: str = ""  # 手动输入的教务验证码（完成登录用）


def _import_week(client, sess, xnm, xqm, zs):
    try:
        data = client.fetch_kbcx(sess.student_id, xnm=xnm, xqm=xqm, zs=zs)
    except DektError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "zs": zs, **data}


def _auto_captcha_jwxt(client, sess, user_id, db, prepare, fetch, attempts=2):
    """开启 auto_captcha 时：AI 识码登录教务系统后执行 fetch，最多两轮。
    返回 (成功结果 | None, 待手动验证码 | None)。"""
    vision = _resolve_vision_model(user_id, db)
    pending = None
    for _ in range(max(1, attempts)):
        pending = _safe_prepare(client, prepare)
        if pending is None:
            return fetch(), None  # 已登录
        if not vision or not pending.captcha:
            break
        text = _ai_solve_captcha(_b64(pending.captcha), vision)
        if not text:
            break
        try:
            client.complete_jwxt_login(sess.student_id, text)
        except DektError as e:
            _log(f"timetable auto captcha rejected: {str(e)[:120]}")
            continue  # 验证码被拒 → 换一张新码再试
        except Exception as e:
            _log(f"timetable auto captcha login failed: {str(e)[:150]}")
            continue
        return fetch(), None
    return None, pending


@router.post("/api/timetable/import", tags=["课程表"])
def timetable_import(req: TtImportRequest, current_user: User = Depends(get_current_user_obj),
                     db: OrmSession = Depends(get_db)):
    try:
        sess, client, cred = _connected_client(current_user, db)
    except _VpnConnecting:
        return {"vpn_connecting": True}

    # 教务登录失效/未登录：验证码回填 → 完成登录并顺带完成本次导入
    if client.jwxt_session is None and (req.captcha or "").strip():
        try:
            client.complete_jwxt_login(sess.student_id, req.captcha.strip())
        except DektError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return _import_week(client, sess, req.xnm, req.xqm, req.zs)

    if client.jwxt_session is None:
        prepare = lambda: client.prepare_jwxt_login(sess.student_id, sess.password)
        if cred.auto_captcha:
            result, pending = _auto_captcha_jwxt(client, sess, current_user.id, db, prepare,
                                                 lambda: _import_week(client, sess, req.xnm, req.xqm, req.zs))
            if result is not None:
                return result
        else:
            pending = _safe_prepare(client, prepare)
        if pending is not None:
            return {"need_captcha": True, "captcha_base64": _b64(pending.captcha), "zs": req.zs}

    return _import_week(client, sess, req.xnm, req.xqm, req.zs)


# ============================================================
# 考试安排导入：教务系统考试查询（kwgl N358105），前端转为日程事件
# 学期由前端按所选学期精确指定（正方学期码：第一学期 3 / 第二学期 12）
# ============================================================

class TtExamImportRequest(BaseModel):
    xnm: str = ""
    xqm: str = ""
    captcha: str = ""  # 手动输入的教务验证码（完成登录用）


def _import_exams(client, xnm, xqm):
    try:
        return {"ok": True, "exams": client.fetch_exams(xnm=xnm, xqm=xqm)}
    except DektError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/timetable/exams/import", tags=["课程表"])
def timetable_exams_import(req: TtExamImportRequest, current_user: User = Depends(get_current_user_obj),
                           db: OrmSession = Depends(get_db)):
    try:
        sess, client, cred = _connected_client(current_user, db)
    except _VpnConnecting:
        return {"vpn_connecting": True}

    # 教务登录失效/未登录：验证码回填 → 完成登录并顺带完成本次查询
    if client.jwxt_session is None and (req.captcha or "").strip():
        try:
            client.complete_jwxt_login(sess.student_id, req.captcha.strip())
        except DektError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return _import_exams(client, req.xnm, req.xqm)

    if client.jwxt_session is None:
        prepare = lambda: client.prepare_jwxt_login(sess.student_id, sess.password)
        if cred.auto_captcha:
            result, pending = _auto_captcha_jwxt(client, sess, current_user.id, db, prepare,
                                                 lambda: _import_exams(client, req.xnm, req.xqm))
            if result is not None:
                return result
        else:
            pending = _safe_prepare(client, prepare)
        if pending is not None:
            return {"need_captcha": True, "captcha_base64": _b64(pending.captcha)}

    return _import_exams(client, req.xnm, req.xqm)
