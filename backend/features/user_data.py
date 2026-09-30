# features/user_data.py — 按用户隔离的通用小型数据存储（KV + JSON 值）
# 用途：各功能的「上次查询结果缓存 / 用户偏好 / 进度」等小数据，服务端按账号隔离，
#       换设备/换浏览器跟随账号，前端用 localStorage 缓存易串数据/丢数据的问题在此收口。
# 约定：键名 ^[a-z0-9][a-z0-9._-]{0,63}$，单值 ≤64KB；大型或需要结构化查询的数据请建专用表
#       （参照 user_timetables），不要塞进这里。前端配套客户端：src/utils/userData.js

import json
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import Column, DateTime, ForeignKey, Integer, JSON, String, func
from sqlalchemy.orm import Session

from database import Base, get_db
from deps import get_current_user_obj
from models import User

router = APIRouter()

_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
MAX_DATA_BYTES = 64 * 1024  # 单值大小上限，防滥用


class UserData(Base):
    """通用用户数据 —— (user_id, key) 一行一个键，值为 JSON 对象"""
    __tablename__ = "user_data"

    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, comment="所属用户 ID")
    key = Column(String(64), primary_key=True, comment="数据键名")
    data = Column(JSON, nullable=False, comment="数据内容（JSON 对象）")
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间")


class UserDataPayload(BaseModel):
    data: dict = Field(..., description="数据内容（JSON 对象）")


def _check_key(key: str):
    if not _KEY_RE.match(key):
        raise HTTPException(status_code=400, detail="非法键名（仅限小写字母/数字/._-，≤64 字符）")


def _get_row(db: Session, user_id: int, key: str):
    return db.query(UserData).filter(UserData.user_id == user_id, UserData.key == key).first()


@router.get("/api/user-data", tags=["用户数据"])
def list_user_data(current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """列出当前用户的所有数据键"""
    rows = db.query(UserData).filter(UserData.user_id == current_user.id).all()
    return {"items": [{"key": r.key, "updated_at": r.updated_at} for r in rows]}


@router.get("/api/user-data/{key}", tags=["用户数据"])
def get_user_data(key: str, current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """读取一个键（不存在时 data 返回 null，与课程表接口口径一致）"""
    _check_key(key)
    row = _get_row(db, current_user.id, key)
    return {"key": key, "data": row.data if row else None, "updated_at": row.updated_at if row else None}


@router.put("/api/user-data/{key}", tags=["用户数据"])
def put_user_data(key: str, payload: UserDataPayload, current_user: User = Depends(get_current_user_obj),
                  db: Session = Depends(get_db)):
    """写入/覆盖一个键（整体覆盖，最后写入胜）"""
    _check_key(key)
    raw = json.dumps(payload.data, ensure_ascii=False)
    if len(raw.encode("utf-8")) > MAX_DATA_BYTES:
        raise HTTPException(status_code=413, detail="数据过大（单值上限 64KB）")
    row = _get_row(db, current_user.id, key)
    if row is None:
        row = UserData(user_id=current_user.id, key=key, data=payload.data)
        db.add(row)
    else:
        row.data = payload.data
    db.commit()
    return {"ok": True, "updated_at": row.updated_at}


@router.delete("/api/user-data/{key}", tags=["用户数据"])
def delete_user_data(key: str, current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """删除一个键"""
    _check_key(key)
    row = _get_row(db, current_user.id, key)
    if row is not None:
        db.delete(row)
        db.commit()
    return {"ok": True}
