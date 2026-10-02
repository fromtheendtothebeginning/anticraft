# features/electricity.py — 电费查询/充值路由（校付宝 epeortal 公网 API）
#
# 客户端选路：查询默认直连（公网可达，无需 VPN）；仅当出现网络类失败
# 且当前用户自己的 VPN 会话已连接时，借道该用户自己的 socks 隧道重试一次。
# 充值只走直连，且只调用一次、绝不重试（避免重复扣款）。
# 自动采集（auto_query_electricity）只用直连，不依赖 VPN。
#
# ⚠ 路由不能用 /api/campus/query/electricity：模块按字母序挂载，
#   campus_service 的通配路由 POST /api/campus/query/{kind} 先注册会把它拦走。

import json

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session as OrmSession

import aisettings
from database import get_db
from deps import _log, get_current_user_obj
from models import CampusCred, ElectricityRecord, User

router = APIRouter()


# ============================================================
# 凭据与记录
# ============================================================

def _cred_and_secrets(current_user, db):
    """加载凭据并解密支付密码，返回 (cred, dorm, real_name, pay_pwd)；缺项抛 400"""
    from features.campus_service import _decrypt_or_400, _load_cred
    cred = _load_cred(current_user, db)
    dorm = (cred.dorm or "").strip()
    if not dorm:
        raise HTTPException(status_code=400, detail="尚未填写默认寝室，请到「我的 → 校园服务」填写")
    if not cred.pay_password_enc:
        raise HTTPException(status_code=400, detail="尚未设置支付密码")
    return cred, dorm, (cred.real_name or "").strip(), _decrypt_or_400(cred.pay_password_enc)


def _save_record(db, user_id, dorm, balance, remain, raw, recharge_amount=None):
    """写一条电费历史记录（raw 截断存储，调试用）；recharge_amount 仅充值记录有值"""
    db.add(ElectricityRecord(
        user_id=user_id,
        dorm=dorm,
        balance=balance,
        remain=remain,
        recharge_amount=recharge_amount,
        raw_json=json.dumps(raw, ensure_ascii=False)[:2000] if raw else None,
    ))
    db.commit()


# ============================================================
# 客户端选路
# ============================================================

def _is_network_error(e: Exception) -> bool:
    """是否网络类失败（超时/连不上）—— 只有这类才值得借道隧道重试"""
    if isinstance(e, requests.exceptions.RequestException):
        return True
    cause = e.__cause__ or e.__context__
    if isinstance(cause, requests.exceptions.RequestException):
        return True
    msg = str(e)
    return any(k in msg for k in ("超时", "timed out", "timeout", "连接", "Connection"))


def _own_connected_session(user_id):
    """当前用户自己已连接的 VPN 会话；未连接/校园服务未就绪时返回 None"""
    from features.campus_service import _get_managers
    try:
        m = _get_managers()
        if "error" in m:
            return None
        sess = m["sessions"].get(user_id)
        return sess if sess and sess.status == "connected" else None
    except Exception:
        return None


# ============================================================
# 查询 / 历史 / 充值
# ============================================================

@router.post("/api/campus/electricity/query", tags=["校园服务"])
def electricity_query(current_user: User = Depends(get_current_user_obj),
                      db: OrmSession = Depends(get_db)):
    """查询宿舍电费余额（直连；网络失败且本人 VPN 已连接时借道自己的隧道重试一次）"""
    from campus.electricity import ElectricityClient

    cred, dorm, real_name, pay_pwd = _cred_and_secrets(current_user, db)
    try:
        result = ElectricityClient().query(cred.student_id, real_name, pay_pwd, dorm)
    except Exception as e:
        sess = _own_connected_session(current_user.id) if _is_network_error(e) else None
        if sess is None:
            raise HTTPException(status_code=400, detail=f"电费查询失败：{e}")
        try:
            # 容器端口发布在后端主机上，走本机回环（sess.proxy_host 只是对外展示地址）
            result = ElectricityClient(proxy_host="127.0.0.1", socks_port=sess.socks_port).query(
                cred.student_id, real_name, pay_pwd, dorm)
        except Exception as e2:
            raise HTTPException(status_code=400, detail=f"电费查询失败：{e2}")

    _save_record(db, current_user.id, dorm, result.get("balance"), result.get("remain"), result.get("raw"))
    return {
        "ok": True,
        "data": {
            "balance": result.get("balance"),
            "card_balance": result.get("card_balance"),
            "remain": result.get("remain"),
            # 返回本次查询用的完整寝室串（result["dorm_info"] 只是接口回显的局部串）
            "dorm": dorm,
        },
    }


@router.get("/api/campus/electricity/history", tags=["校园服务"])
def electricity_history(days: int = 90,
                        current_user: User = Depends(get_current_user_obj),
                        db: OrmSession = Depends(get_db)):
    """电费历史记录（最近 N 天，1~365），按时间升序 → 折线图"""
    from datetime import datetime, timedelta
    since = datetime.utcnow() - timedelta(days=min(max(days, 1), 365))
    records = (
        db.query(ElectricityRecord)
        .filter(ElectricityRecord.user_id == current_user.id)
        .filter(ElectricityRecord.queried_at >= since)
        .order_by(ElectricityRecord.queried_at.asc())
        .all()
    )
    return {
        "ok": True,
        "records": [
            {
                "balance": r.balance,
                "remain": r.remain,
                "dorm": r.dorm,
                "time": r.queried_at.strftime("%Y-%m-%d %H:%M:%S") if r.queried_at else None,
                "recharge": r.recharge_amount or 0,
            }
            for r in records
        ],
    }


class RechargeRequest(BaseModel):
    amount: float


@router.post("/api/campus/electricity/recharge", tags=["校园服务"])
def electricity_recharge(req: RechargeRequest,
                         current_user: User = Depends(get_current_user_obj),
                         db: OrmSession = Depends(get_db)):
    """缴纳电费：直连，只调用一次、绝不重试（避免重复扣款）"""
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
    # 复查最新余额，失败/返回空时重试一次；仍失败则 balance/remain 记 NULL，不影响充值结果
    new_balance = new_remain = query_raw = None
    for _ in range(2):
        try:
            q = ElectricityClient().query(cred.student_id, real_name, pay_pwd, dorm)
            new_balance, new_remain, query_raw = q.get("balance"), q.get("remain"), q.get("raw")
            if new_balance is not None:
                break
        except Exception:
            pass
    _save_record(db, current_user.id, dorm, new_balance, new_remain,
                 {"recharge": result.get("raw"), "query_after": query_raw},
                 recharge_amount=result.get("amount"))

    return {
        "ok": True,
        "message": result.get("message") or "充值成功",
        "data": {
            "balance": new_balance,
            "card_balance": result.get("balance"),  # 支付后校园卡余额
            "amount": result.get("amount"),
        },
    }


# ============================================================
# 自动采集（供 nightly 定时任务调用）
# ============================================================

def auto_query_electricity():
    """为所有已填寝室的用户自动查询电费并记录（直连，不依赖 VPN）；永不抛异常。"""
    from campus.electricity import ElectricityClient
    from database import SessionLocal

    db = SessionLocal()
    total = ok = 0
    try:
        creds = db.query(CampusCred).filter(
            CampusCred.dorm != "",
            CampusCred.dorm.isnot(None),
        ).all()
        total = len(creds)
        for cred in creds:
            try:
                pay_pwd = aisettings.decrypt_secret(cred.pay_password_enc) if cred.pay_password_enc else ""
                if not pay_pwd:
                    _log(f"auto electricity query skip: user={cred.user_id} 无支付密码")
                    continue
                dorm = (cred.dorm or "").strip()
                result = ElectricityClient().query(
                    cred.student_id, (cred.real_name or "").strip(), pay_pwd, dorm)
                _save_record(db, cred.user_id, dorm,
                             result.get("balance"), result.get("remain"), result.get("raw"))
                ok += 1
            except Exception as e:
                db.rollback()
                _log(f"auto electricity query failed: user={cred.user_id} err={str(e)[:150]}")
    except Exception as e:
        _log(f"auto electricity query error: {str(e)[:200]}")
    finally:
        db.close()
    _log(f"auto electricity query: {total} users, {ok} ok")
