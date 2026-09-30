# features/account_binding.py — 开放平台：第三方项目绑定 anticraft 账号
#
# 流程为 OAuth 2.0 授权码模式的精简实现：
#   1. 第三方项目把用户浏览器送到 https://anticraft.top/bind?client_id=..&redirect_uri=..&state=..
#   2. 用户在本站确认授权（未登录则先登录）→ 浏览器被带回 redirect_uri?code=..&state=..
#   3. 第三方服务端拿 client_id + client_secret + code 调 /api/open/token 换访问令牌
#   4. 第三方用 Bearer 令牌调 /api/open/userinfo 读取用户基础资料
#
# 白名单：只有管理员在「管理员后台 → 绑定应用」登记且启用的应用（bind_apps）才能发起绑定；
# 回调地址必须与登记值**精确匹配**（不支持通配/前缀），密钥只在创建/重置时明文返回一次。
#
# 令牌不签发 JWT —— JWT 会被本站鉴权体系同样接受，等于把用户在本站的登录态交出去；
# 这里用随机不透明串（act_ 前缀），库里只存 sha256，且仅对 /api/open/userinfo 有效。
#
# 表结构（bind_apps / bind_codes / bind_tokens）随模块导入注册进 Base.metadata，
# 由启动时的 init_db() 自动建出，无需改 database.py。
# 对接文档见 docs/account-binding-api.md。

import hashlib
import hmac
import json
import secrets
import urllib.parse
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func,
)
from sqlalchemy.orm import Session

from database import Base, get_db
from constants import OPEN_SCOPE_DEFAULT, OPEN_SCOPES
from deps import _client_ip, get_current_user_obj, require_admin
from models import User
from ratelimit import SlidingWindow

router = APIRouter()

# ── 开放平台常量 ──
SCOPE = "profile"              # 当前只开放「账号基础资料」一种权限
CODE_TTL_MINUTES = 5           # 授权码有效期
TOKEN_TTL_DAYS = 30            # 访问令牌有效期
MAX_REDIRECT_URIS = 10         # 单应用最多登记的回调地址数

token_ip = SlidingWindow(30, 60)  # 同一 IP 每分钟最多 30 次令牌交换（含失败尝试，防密钥爆破）
revoke_ip = SlidingWindow(30, 60)  # 同一 IP 每分钟最多 30 次解绑请求（与令牌交换同档）


# ============================================
# 数据表
# ============================================

class BindApp(Base):
    """绑定白名单应用 —— 管理员登记，只有这里的应用能发起绑定"""
    __tablename__ = "bind_apps"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(50), nullable=False, comment="应用名（授权页展示）")
    client_id = Column(String(64), unique=True, nullable=False, index=True, comment="公开的应用标识")
    client_secret_hash = Column(String(64), nullable=False, comment="应用密钥 sha256（不回传明文）")
    redirect_uris = Column(Text, nullable=False, comment="JSON 数组：允许的回调地址（精确匹配）")
    description = Column(String(200), nullable=True, comment="应用简介（授权页展示）")
    homepage = Column(String(500), nullable=True, comment="应用主页")
    is_active = Column(Boolean, nullable=False, default=True, server_default="1", comment="是否启用")
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, comment="登记人")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="创建时间")
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间")


class BindCode(Base):
    """授权码 —— 一次性、5 分钟过期；库中只存 sha256"""
    __tablename__ = "bind_codes"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    code_hash = Column(String(64), unique=True, nullable=False, index=True, comment="授权码 sha256")
    app_id = Column(Integer, ForeignKey("bind_apps.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    redirect_uri = Column(String(500), nullable=False, comment="授权时确定的回调地址")
    scope = Column(String(50), nullable=False, default=OPEN_SCOPE_DEFAULT, server_default=OPEN_SCOPE_DEFAULT, comment="授权范围（空格分隔，profile 恒含）")
    used = Column(Boolean, nullable=False, default=False, comment="是否已换取令牌")
    expires_at = Column(DateTime(timezone=True), nullable=False, comment="过期时间")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="创建时间")


class BindToken(Base):
    """绑定关系 —— 每用户每应用一条，解绑/重新授权即轮换令牌"""
    __tablename__ = "bind_tokens"
    __table_args__ = (UniqueConstraint("app_id", "user_id", name="uq_bind_token_app_user"),)

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    app_id = Column(Integer, ForeignKey("bind_apps.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(64), unique=True, nullable=False, index=True, comment="访问令牌 sha256")
    scope = Column(String(50), nullable=False, default=SCOPE, server_default=SCOPE, comment="授权范围")
    revoked = Column(Boolean, nullable=False, default=False, server_default="0", comment="是否已解绑")
    expires_at = Column(DateTime(timezone=True), nullable=False, comment="令牌过期时间")
    last_used_at = Column(DateTime(timezone=True), nullable=True, comment="最近调用时间")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="绑定时间")


# ============================================
# 助手
# ============================================

def _hash(value: str) -> str:
    """令牌/密钥一律 sha256 后入库"""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _now() -> datetime:
    """当前时间：与库中 func.now() 同一时钟（同机 MySQL），便于过期比较"""
    return datetime.now()


def _app_payload(app: BindApp) -> dict:
    return {
        "id": app.id,
        "name": app.name,
        "description": app.description,
        "homepage": app.homepage,
        "client_id": app.client_id,
        "redirect_uris": _parse_uris(app.redirect_uris),
        "is_active": bool(app.is_active),
        "created_at": app.created_at,
    }


def _user_payload(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "nickname": user.nickname,
        "avatar_url": user.avatar_url,
        "created_at": user.created_at,
    }


def _parse_uris(raw: str) -> list:
    try:
        uris = json.loads(raw or "[]")
        return [u for u in uris if isinstance(u, str)]
    except (TypeError, ValueError):
        return []


def _validate_redirect_uri(uri: str) -> str:
    """回调地址校验：http(s) 绝对地址、带 host、不含片段与通配符（本地开发地址放行）"""
    uri = (uri or "").strip()
    parsed = urllib.parse.urlsplit(uri)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="回调地址必须是 http(s) 开头的完整地址")
    if parsed.fragment or "*" in uri:
        raise HTTPException(status_code=400, detail="回调地址不能包含 # 片段或通配符")
    if len(uri) > 500:
        raise HTTPException(status_code=400, detail="回调地址过长")
    return uri


def _normalize_uris(uris: list) -> str:
    """去重、去空行后存 JSON"""
    cleaned = []
    for uri in uris or []:
        uri = _validate_redirect_uri(uri)
        if uri not in cleaned:
            cleaned.append(uri)
    if not cleaned:
        raise HTTPException(status_code=400, detail="至少登记一个回调地址")
    if len(cleaned) > MAX_REDIRECT_URIS:
        raise HTTPException(status_code=400, detail=f"最多登记 {MAX_REDIRECT_URIS} 个回调地址")
    return json.dumps(cleaned, ensure_ascii=False)


def _get_active_app(db: Session, client_id: str) -> BindApp:
    app = (
        db.query(BindApp)
        .filter(BindApp.client_id == client_id, BindApp.is_active.is_(True))
        .first()
    )
    if not app:
        raise HTTPException(status_code=404, detail="应用不存在或已停用（不在白名单内）")
    return app


def _check_redirect(app: BindApp, redirect_uri: str) -> None:
    if not redirect_uri or redirect_uri not in _parse_uris(app.redirect_uris):
        raise HTTPException(status_code=400, detail="回调地址与登记值不一致")


def _append_query(url: str, params: dict) -> str:
    """在回调地址上追加参数（保留第三方自己的查询串），片段部分丢弃"""
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    query += [(k, v) for k, v in params.items() if v]
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(query), "")
    )


def _validate_scope(raw: str) -> str:
    """校验并规范化 scope 请求串：空格/+ 分隔，未知范围报 400，profile 恒包含；返回空格分隔串"""
    requested = [s for s in (raw or "").replace("+", " ").split() if s]
    if len(requested) > len(OPEN_SCOPES):
        raise HTTPException(status_code=400, detail="scope 数量超过可用范围")
    for s in requested:
        if s not in OPEN_SCOPES:
            raise HTTPException(status_code=400, detail=f"scope 无效或不受支持：{s}")
    scopes = [OPEN_SCOPE_DEFAULT] + [s for s in requested if s != OPEN_SCOPE_DEFAULT]
    return " ".join(scopes)


def _scope_payload(scope: str) -> list:
    """授权页展示用：申请到的范围及其中文说明（按 OPEN_SCOPES 固定顺序）"""
    granted = set((scope or "").split())
    return [
        {"key": key, "description": desc}
        for key, desc in OPEN_SCOPES.items()
        if key in granted
    ]


def _new_client_id(db: Session) -> str:
    while True:
        candidate = "ac_" + secrets.token_urlsafe(12)
        if not db.query(BindApp.id).filter(BindApp.client_id == candidate).first():
            return candidate


# ============================================
# 开放接口（第三方项目调用）
# ============================================

@router.get("/api/open/apps/{client_id}", tags=["开放接口"])
def open_app_info(client_id: str, db: Session = Depends(get_db)):
    """应用公开信息（无需鉴权）：授权页与第三方展示用"""
    app = _get_active_app(db, client_id)
    return {
        "client_id": app.client_id,
        "name": app.name,
        "description": app.description,
        "homepage": app.homepage,
        "scope": SCOPE,
    }


class TokenRequest(BaseModel):
    client_id: str = Field(..., max_length=64, description="应用标识")
    client_secret: str = Field(..., max_length=128, description="应用密钥")
    code: str = Field("", max_length=128, description="授权码（grant_type=authorization_code 时必填）")
    grant_type: str = Field("authorization_code", max_length=20, description="authorization_code（默认）或 refresh_token")
    refresh_token: Optional[str] = Field(None, max_length=128, description="刷新令牌（grant_type=refresh_token 时必填）")


@router.post("/api/open/token", tags=["开放接口"])
def open_token(req: TokenRequest, request: Request, db: Session = Depends(get_db)):
    """换访问令牌（第三方服务端调用）：授权码模式（v1 兼容）或 refresh_token 轮换（v2）"""
    if not token_ip.allow(_client_ip(request)):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="请求过于频繁，请稍后再试"
        )
    app = (
        db.query(BindApp)
        .filter(BindApp.client_id == req.client_id, BindApp.is_active.is_(True))
        .first()
    )
    if not app or not hmac.compare_digest(_hash(req.client_secret), app.client_secret_hash):
        raise HTTPException(status_code=400, detail="client_id 或 client_secret 无效")

    if req.grant_type == "refresh_token":
        # v2：刷新令牌轮换（实现在 open_platform，避免循环导入延迟导入）
        from features.open_platform import refresh_grant
        return refresh_grant(db, app, req.refresh_token)
    if req.grant_type != "authorization_code":
        raise HTTPException(status_code=400, detail="不支持的 grant_type")

    row = db.query(BindCode).filter(BindCode.code_hash == _hash(req.code)).first()
    if not row or row.used or row.app_id != app.id or row.expires_at < _now():
        raise HTTPException(status_code=400, detail="授权码无效或已过期")
    user = db.query(User).filter(User.id == row.user_id).first()
    if not user:
        raise HTTPException(status_code=400, detail="授权码无效或已过期")
    scope = (getattr(row, "scope", None) or OPEN_SCOPE_DEFAULT).strip() or OPEN_SCOPE_DEFAULT

    row.used = True
    token = "act_" + secrets.token_urlsafe(32)
    expires = _now() + timedelta(days=TOKEN_TTL_DAYS)
    # 同一用户对同一应用只保留一条绑定：重新授权 = 轮换令牌（旧令牌立即失效），并刷新授权范围
    binding = (
        db.query(BindToken)
        .filter(BindToken.app_id == app.id, BindToken.user_id == user.id)
        .first()
    )
    if binding:
        binding.token_hash = _hash(token)
        binding.scope = scope
        binding.revoked = False
        binding.expires_at = expires
        binding.created_at = _now()
        binding.last_used_at = None
    else:
        db.add(BindToken(
            app_id=app.id,
            user_id=user.id,
            token_hash=_hash(token),
            scope=scope,
            expires_at=expires,
        ))
    # 顺手清理该用户在本应用下未使用的过期授权码
    db.query(BindCode).filter(
        BindCode.app_id == app.id,
        BindCode.used.is_(False),
        BindCode.expires_at < _now(),
    ).delete(synchronize_session=False)

    # v2：同时签发刷新令牌（轮换式，90 天）；旧客户端忽略该新增字段即可
    from features.open_platform import issue_refresh_token
    refresh = issue_refresh_token(db, app.id, user.id)
    db.commit()

    return {
        "access_token": token,
        "token_type": "Bearer",
        "expires_in": TOKEN_TTL_DAYS * 86400,
        "scope": scope,
        "refresh_token": refresh,
        "user": _user_payload(user),
    }


@router.get("/api/open/userinfo", tags=["开放接口"])
def open_userinfo(request: Request, db: Session = Depends(get_db)):
    """读取已绑定用户的基础资料（Bearer 访问令牌）"""
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="缺少访问令牌")
    binding = (
        db.query(BindToken)
        .filter(BindToken.token_hash == _hash(auth[7:].strip()), BindToken.revoked.is_(False))
        .first()
    )
    if not binding or binding.expires_at < _now():
        raise HTTPException(status_code=401, detail="访问令牌无效或已过期")
    if "profile" not in (binding.scope or SCOPE).split():
        raise HTTPException(status_code=403, detail="令牌未授权此范围（scope 不足），需用户重新授权")
    app = db.query(BindApp).filter(BindApp.id == binding.app_id).first()
    user = db.query(User).filter(User.id == binding.user_id).first()
    if not app or not app.is_active or not user:
        raise HTTPException(status_code=401, detail="访问令牌无效或已过期")

    binding.last_used_at = _now()
    db.commit()

    return {
        "app": {"client_id": app.client_id, "name": app.name},
        "scope": binding.scope,
        "user": _user_payload(user),
    }


class RevokeRequest(BaseModel):
    client_id: str = Field(..., max_length=64)
    client_secret: str = Field(..., max_length=128)
    token: str = Field(..., max_length=128)


@router.post("/api/open/revoke", tags=["开放接口"])
def open_revoke(req: RevokeRequest, request: Request, db: Session = Depends(get_db)):
    """第三方主动解除绑定（用户在第三方侧解绑时调用），幂等"""
    if not revoke_ip.allow(_client_ip(request)):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="请求过于频繁，请稍后再试")
    app = (
        db.query(BindApp)
        .filter(BindApp.client_id == req.client_id)
        .first()
    )
    if not app or not hmac.compare_digest(_hash(req.client_secret), app.client_secret_hash):
        raise HTTPException(status_code=400, detail="client_id 或 client_secret 无效")
    binding = (
        db.query(BindToken)
        .filter(BindToken.app_id == app.id, BindToken.token_hash == _hash(req.token))
        .first()
    )
    if binding and not binding.revoked:
        binding.revoked = True
        db.commit()
    return {"revoked": bool(binding)}


# ============================================
# 用户端（本站已登录用户）
# ============================================

@router.get("/api/bind/authorize", tags=["账号绑定"])
def bind_authorize_info(
    client_id: str,
    redirect_uri: str,
    state: str = "",
    scope: str = "",
    user: User = Depends(get_current_user_obj),
    db: Session = Depends(get_db),
):
    """授权确认页数据：校验白名单与回调地址，回显应用信息、当前用户与申请的权限范围"""
    if len(state) > 200:
        raise HTTPException(status_code=400, detail="state 参数过长")
    app = _get_active_app(db, client_id)
    _check_redirect(app, redirect_uri)
    granted = _validate_scope(scope)
    return {
        "app": {"name": app.name, "description": app.description, "homepage": app.homepage},
        "user": _user_payload(user),
        "scope": granted,
        "scopes": _scope_payload(granted),
        "state": state,
    }


class AuthorizeDecision(BaseModel):
    client_id: str = Field(..., max_length=64)
    redirect_uri: str = Field(..., max_length=500)
    state: str = Field("", max_length=200)
    scope: str = Field("", max_length=100, description="申请的权限范围（与授权入口一致）")
    approve: bool = True


@router.post("/api/bind/authorize", tags=["账号绑定"])
def bind_authorize(
    req: AuthorizeDecision,
    user: User = Depends(get_current_user_obj),
    db: Session = Depends(get_db),
):
    """用户确认/拒绝授权 → 返回带 code 或 error 的回调地址，由前端跳转"""
    app = _get_active_app(db, req.client_id)
    _check_redirect(app, req.redirect_uri)
    if not req.approve:
        return {"redirect_url": _append_query(
            req.redirect_uri, {"error": "access_denied", "state": req.state}
        )}

    granted = _validate_scope(req.scope)
    # 同一用户在同一应用下只保留一个待用授权码，避免积压
    db.query(BindCode).filter(
        BindCode.app_id == app.id, BindCode.user_id == user.id, BindCode.used.is_(False)
    ).delete(synchronize_session=False)
    code = "acb_" + secrets.token_urlsafe(24)
    db.add(BindCode(
        code_hash=_hash(code),
        app_id=app.id,
        user_id=user.id,
        redirect_uri=req.redirect_uri,
        scope=granted,
        expires_at=_now() + timedelta(minutes=CODE_TTL_MINUTES),
    ))
    db.commit()
    return {"redirect_url": _append_query(
        req.redirect_uri, {"code": code, "state": req.state}
    )}


@router.get("/api/bind/mine", tags=["账号绑定"])
def bind_mine(user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """我绑定的第三方应用列表"""
    rows = (
        db.query(BindToken)
        .filter(BindToken.user_id == user.id, BindToken.revoked.is_(False))
        .order_by(BindToken.created_at.desc())
        .all()
    )
    app_ids = [r.app_id for r in rows]
    apps = {}
    if app_ids:
        apps = {a.id: a for a in db.query(BindApp).filter(BindApp.id.in_(app_ids)).all()}
    now = _now()
    bindings = []
    for r in rows:
        app = apps.get(r.app_id)
        if not app:
            continue
        bindings.append({
            "app_id": r.app_id,
            "name": app.name,
            "description": app.description,
            "homepage": app.homepage,
            "scope": r.scope,
            "created_at": r.created_at,
            "last_used_at": r.last_used_at,
            "expires_at": r.expires_at,
            "expired": r.expires_at < now,
        })
    return {"bindings": bindings}


@router.delete("/api/bind/mine/{app_id}", tags=["账号绑定"])
def bind_revoke(app_id: int, user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """解除绑定（撤销令牌，第三方随即无法再读取资料）"""
    binding = (
        db.query(BindToken)
        .filter(BindToken.app_id == app_id, BindToken.user_id == user.id, BindToken.revoked.is_(False))
        .first()
    )
    if not binding:
        raise HTTPException(status_code=404, detail="绑定不存在或已解除")
    binding.revoked = True
    db.commit()
    return {"message": "已解除绑定"}


# ============================================
# 管理员端（白名单管理）
# ============================================

class CreateAppRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=50, description="应用名")
    description: Optional[str] = Field(None, max_length=200, description="应用简介")
    homepage: Optional[str] = Field(None, max_length=500, description="应用主页")
    redirect_uris: list[str] = Field(..., description="回调地址，可多个")


class UpdateAppRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=50)
    description: Optional[str] = Field(None, max_length=200)
    homepage: Optional[str] = Field(None, max_length=500)
    redirect_uris: Optional[list[str]] = None
    is_active: Optional[bool] = None


@router.get("/api/admin/bind-apps", tags=["管理员"])
def admin_list_apps(_admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """白名单应用列表（含未解绑的绑定数）"""
    apps = db.query(BindApp).order_by(BindApp.created_at.desc()).all()
    counts = dict(
        db.query(BindToken.app_id, func.count(BindToken.id))
        .filter(BindToken.revoked.is_(False))
        .group_by(BindToken.app_id)
        .all()
    )
    return {
        "total": len(apps),
        "apps": [{**_app_payload(a), "bound_count": counts.get(a.id, 0)} for a in apps],
    }


@router.post("/api/admin/bind-apps", status_code=status.HTTP_201_CREATED, tags=["管理员"])
def admin_create_app(
    req: CreateAppRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """登记白名单应用 —— 返回的 client_secret 只显示这一次，请立即保存"""
    secret = "acs_" + secrets.token_urlsafe(24)
    app = BindApp(
        name=req.name.strip(),
        description=(req.description or "").strip() or None,
        homepage=(req.homepage or "").strip() or None,
        client_id=_new_client_id(db),
        client_secret_hash=_hash(secret),
        redirect_uris=_normalize_uris(req.redirect_uris),
        is_active=True,
        created_by=admin.id,
    )
    db.add(app)
    db.commit()
    db.refresh(app)
    return {**_app_payload(app), "client_secret": secret}


@router.put("/api/admin/bind-apps/{app_id}", tags=["管理员"])
def admin_update_app(
    app_id: int,
    req: UpdateAppRequest,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """修改白名单应用（启用/停用、改名、增删回调地址）"""
    app = db.query(BindApp).filter(BindApp.id == app_id).first()
    if not app:
        raise HTTPException(status_code=404, detail="应用不存在")
    if "name" in req.model_fields_set and req.name:
        app.name = req.name.strip()
    if "description" in req.model_fields_set:
        app.description = (req.description or "").strip() or None
    if "homepage" in req.model_fields_set:
        app.homepage = (req.homepage or "").strip() or None
    if "redirect_uris" in req.model_fields_set and req.redirect_uris is not None:
        app.redirect_uris = _normalize_uris(req.redirect_uris)
    if "is_active" in req.model_fields_set and req.is_active is not None:
        app.is_active = req.is_active
    db.commit()
    db.refresh(app)
    return _app_payload(app)


@router.post("/api/admin/bind-apps/{app_id}/secret", tags=["管理员"])
def admin_rotate_secret(
    app_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """重置应用密钥（旧密钥立即失效，已有绑定不受影响）"""
    app = db.query(BindApp).filter(BindApp.id == app_id).first()
    if not app:
        raise HTTPException(status_code=404, detail="应用不存在")
    secret = "acs_" + secrets.token_urlsafe(24)
    app.client_secret_hash = _hash(secret)
    db.commit()
    return {"client_id": app.client_id, "client_secret": secret}


@router.delete("/api/admin/bind-apps/{app_id}", tags=["管理员"])
def admin_delete_app(
    app_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """删除白名单应用 —— 该应用的全部绑定与令牌一并作废"""
    app = db.query(BindApp).filter(BindApp.id == app_id).first()
    if not app:
        raise HTTPException(status_code=404, detail="应用不存在")
    db.delete(app)
    db.commit()
    return {"message": "应用已删除，相关绑定已全部作废"}
