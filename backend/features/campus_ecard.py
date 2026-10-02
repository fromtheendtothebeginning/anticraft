# features/campus_ecard.py — 校园码（校付宝付款码）路由：公网直连，无需校园网/VPN
#
# 数据来源与电费同一套校付宝 epeortal 公网接口（ecard.sit.edu.cn/openservice），
# 所以不占 VPN 会话、不弹验证码，未连接校园网也能取码。
#
# ⚠ 路由不能用 /api/campus/query/{kind}：模块按字母序挂载，
#   campus_service 的通配路由 POST /api/campus/query/{kind} 先注册会把它拦走。

import base64
import io

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session as OrmSession

from database import get_db
from deps import get_current_user_obj
from models import User

router = APIRouter()

# 学校未公开码有效期，沿用旧版动态码的 55 秒自动刷新节奏
REFRESH_SECONDS = 55


def _secrets(current_user, db):
    """学号 + 姓名 + 校付宝支付密码（解密）；缺项抛 400"""
    from features.campus_service import _decrypt_or_400, _load_cred
    cred = _load_cred(current_user, db)
    if not cred.pay_password_enc:
        raise HTTPException(status_code=400, detail="尚未设置支付密码")
    return cred.student_id, (cred.real_name or "").strip(), _decrypt_or_400(cred.pay_password_enc)


def _qr_png_base64(text):
    """码值渲染成二维码 PNG；qrcode 库缺失时返回 None（前端退回显示码值文本）"""
    try:
        import qrcode as _qr
        buf = io.BytesIO()
        _qr.make(text).save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None


@router.post("/api/campus/ecard/qrcode", tags=["校园服务"])
def ecard_qrcode(current_user: User = Depends(get_current_user_obj),
                 db: OrmSession = Depends(get_db)):
    """获取校园码（付款码）+ 校园卡余额：直连校付宝公网接口，不依赖 VPN"""
    from campus.ecard import EcardClient

    student_id, real_name, pay_pwd = _secrets(current_user, db)
    try:
        result = EcardClient().qrcode_and_balance(student_id, real_name, pay_pwd)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"校园码获取失败：{e}")
    code = result["code"]
    return {
        "ok": True,
        "data": {
            "image": _qr_png_base64(code),
            "type": "image/png",
            "code": code,
            "card_balance": result.get("balance"),
            "refresh": REFRESH_SECONDS,
        },
    }
