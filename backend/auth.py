# auth.py — 密码加密 & JWT 令牌

import os
import re
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Optional
from dotenv import load_dotenv

import bcrypt as _bcrypt
import jwt
from jwt import PyJWTError as JWTError

load_dotenv()

# ============================================
# 配置（生产环境请从环境变量读取）
# ============================================
SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("缺少 SECRET_KEY 环境变量，拒绝启动（防止使用可预测密钥签发 JWT）")
if len(SECRET_KEY) < 32:
    raise RuntimeError("SECRET_KEY 强度不足（<32 字符），拒绝启动")
if "anticraft" in SECRET_KEY.lower() or not re.fullmatch(r"[a-zA-Z0-9_-]{32,64}", SECRET_KEY):
    print("[auth] 警告：SECRET_KEY 可能为弱密钥，建议轮换")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 30  # 30 天（前端临近过期静默换新，活跃用户长期免登录）


# ── 密码 ──

def _prehash(password: str) -> bytes:
    """SHA-256 → bytes，绕过 bcrypt 72 字节限制"""
    return hashlib.sha256(password.encode()).hexdigest().encode()


def hash_password(password: str) -> str:
    """明文 → SHA-256 → bcrypt 哈希"""
    pre = _prehash(password)
    return _bcrypt.hashpw(pre, _bcrypt.gensalt()).decode()


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """验证明文与哈希是否匹配"""
    pre = _prehash(plain_password)
    return _bcrypt.checkpw(pre, hashed_password.encode())


# ── JWT ──

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """生成 JWT access token"""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> Optional[dict]:
    """解码 JWT，失败返回 None"""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None
