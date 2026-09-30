# deps.py — 跨域共享依赖与助手（自 main.py 逐字搬移，不依赖 features 下任何模块）

import ipaddress
import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

import aisettings
from auth import decode_access_token
from constants import ROLE_ADMIN
from database import get_db
from models import User, Notification


def _assert_public_http_url(url: str) -> str:
    """校验 URL 为公网 http(s) 且目标非内网/环回/链路本地地址，防 SSRF。合法返回原 URL。
    域名会先解析并逐一校验 IP（实现见 aisettings.assert_public_http_url）。"""
    try:
        return aisettings.assert_public_http_url(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _log(msg: str):
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/login")
# 可选鉴权 —— 未携带 token 时不报错，返回 None（用于公开接口附带当前用户信息）
oauth2_scheme_optional = OAuth2PasswordBearer(tokenUrl="/api/login", auto_error=False)


def _is_trusted_proxy(ip: str) -> bool:
    """直连方是否为本机/内网（可信反向代理），只有可信代理才采信其携带的 X-Forwarded-For"""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved


def _client_ip(request: Request) -> str:
    """获取客户端 IP：仅当直连方是可信代理（本机/内网）时采信 X-Forwarded-For 末段
    （nginx $proxy_add_x_forwarded_for 把真实 IP 追加在最后），防止公网直连伪造 XFF 绕过限流"""
    client = request.client.host if request.client else None
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded and client and _is_trusted_proxy(client):
        return forwarded.split(",")[-1].strip()
    return client or "unknown"


def _escape_like(s: str) -> str:
    """转义 LIKE 通配符，防止搜索词里的 % _ \\ 被当作模式匹配"""
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def generate_invite_code() -> str:
    """生成 12 位大写字母数字邀请码（token_urlsafe 去掉 - _ 后截取）"""
    import secrets
    return secrets.token_urlsafe(8).upper().replace("-", "").replace("_", "")[:12]


def _mask_sid(sid: str) -> str:
    """学号脱敏：保留前 2 后 2，中间打码"""
    if len(sid) <= 4:
        return "*" * len(sid)
    return sid[:2] + "*" * (len(sid) - 4) + sid[-2:]


def _verify_token(token: str, db: Session) -> Optional[User]:
    """校验 JWT 并返回用户；令牌无效 / 用户不存在 / 已禁用 / 令牌版本号与用户不匹配时返回 None"""
    payload = decode_access_token(token)
    if payload is None:
        return None
    try:
        user_id = int(payload.get("sub"))
    except (TypeError, ValueError):
        return None
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return None
    if not user.is_active:
        return None
    if payload.get("ver") != user.token_version:
        return None
    return user


def get_current_user_obj(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    """获取当前用户对象（含令牌版本校验）"""
    user = _verify_token(token, db)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="无效的令牌")
    return user


def require_admin(current_user: User = Depends(get_current_user_obj)) -> User:
    """管理员权限依赖 —— 非管理员返回 403"""
    if current_user.role != ROLE_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限")
    return current_user


def get_optional_user(token: Optional[str], db: Session) -> Optional[User]:
    """可选鉴权：传入 Bearer token 时返回用户，否则返回 None"""
    if not token:
        return None
    return _verify_token(token, db)


def _notify(db, user_id, type_, actor_id, blog_id, comment_id, content):
    """发站内通知并去重：同接收者/类型/触发者/目标的未读通知已存在则不再发。"""
    dup = (
        db.query(Notification)
        .filter(
            Notification.user_id == user_id,
            Notification.type == type_,
            Notification.actor_id == actor_id,
            Notification.comment_id == comment_id,
            Notification.blog_id == blog_id,
            Notification.is_read.is_(False),
        )
        .first()
    )
    if dup:
        return
    db.add(Notification(
        user_id=user_id,
        type=type_,
        actor_id=actor_id,
        blog_id=blog_id,
        comment_id=comment_id,
        content=content,
    ))
    db.commit()


# ============================================
# AI 带图对话（识图 / LaTeX 生成 / 验证码识别共用）
# ============================================

def ai_vision_text(provider_id, api_key, model, base_url, system, user_text, images,
                   timeout=60, max_tokens=8192, thinking=None):
    """通用带图对话：按 provider 的 api 风格（anthropic / responses / openai）构造请求并解析响应，
    返回模型输出文本。images = [(mime, b64)]；thinking 非空时按厂商写入思考参数，
    被模型 400 拒绝时自动去掉重试一次。失败抛 HTTPException：400=配置类（引导去 AI 设置），502=调用类。"""
    p = aisettings.get_provider(provider_id)
    api = aisettings.resolve_api(provider_id, model)
    base = base_url or (p["base_url"] if p else "")
    url = _assert_public_http_url(aisettings._endpoint_url(api, base, provider_id))

    if api == "anthropic":
        parts = [{"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}}
                 for mime, b64 in images]
        if user_text:
            parts.append({"type": "text", "text": user_text})
        payload = {"model": model, "max_tokens": max_tokens,
                   "messages": [{"role": "user", "content": parts}]}
        if system:
            payload["system"] = system
    elif api == "responses":
        parts = [{"type": "input_text", "text": user_text}]
        parts += [{"type": "input_image", "image_url": f"data:{mime};base64,{b64}"} for mime, b64 in images]
        payload = {"model": model, "max_output_tokens": max_tokens,
                   "input": [{"role": "user", "content": parts}]}
        if system:
            payload["instructions"] = system
    else:
        parts = []
        if user_text:
            parts.append({"type": "text", "text": user_text})
        parts += [{"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}} for mime, b64 in images]
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": parts})
        payload = {"model": model, "messages": messages, "max_tokens": max_tokens, "stream": False}

    # 思考深度：按 provider 写入思考参数（未配置则不加，跟随模型默认）
    base_keys = set(payload)
    if thinking:
        payload = aisettings.apply_thinking(payload, provider_id, thinking)
    thinking_keys = [k for k in payload if k not in base_keys]

    headers = {**aisettings._build_headers(api, api_key), "Content-Type": "application/json"}

    def _post(body):
        req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
        with aisettings.safe_urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())

    try:
        try:
            data = _post(payload)
        except urllib.error.HTTPError as e:
            # 400 且本次确实加了思考参数：去掉该参数重试一次（部分模型/兼容层不认）
            if e.code == 400 and thinking_keys:
                data = _post({k: v for k, v in payload.items() if k not in thinking_keys})
            else:
                try:
                    detail = e.read().decode("utf-8", errors="replace")[:300]
                except Exception:
                    detail = ""
                msg = {401: "API Key 无效或未授权", 403: "无权访问该模型，请到 AI 设置更换模型",
                       404: "接口或模型不存在（检查 Base URL / 模型 ID），请到 AI 设置调整",
                       413: "图片总大小超出模型限制，请减少图片数量或压缩后重试"}.get(e.code)
                if msg:
                    raise HTTPException(status_code=400, detail={"code": "ai_config", "message": msg})
                raise HTTPException(status_code=502, detail=f"AI 提供商返回 HTTP {e.code}: {detail}")
        except aisettings.UnsafeURLError:
            raise HTTPException(status_code=400, detail="不允许访问内网地址")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"连接 AI 提供商失败：{e}")

    if api == "responses":
        if data.get("output_text"):
            return data["output_text"]
        for item in data.get("output") or []:
            for c in item.get("content") or []:
                if c.get("type") in ("output_text", "text") and c.get("text"):
                    return c["text"]
    elif api == "anthropic":
        for c in data.get("content") or []:
            if c.get("type") == "text" and c.get("text"):
                return c["text"]
    else:
        choices = data.get("choices") or []
        content = (choices[0].get("message") or {}).get("content") if choices else None
        if isinstance(content, list):   # 部分网关把 content 返回为数组
            content = "".join(c.get("text") or "" for c in content if isinstance(c, dict))
        if content:
            return content
    raise HTTPException(status_code=502, detail="AI 响应中没有文本输出")
