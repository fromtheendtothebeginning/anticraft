# features/downloads.py — 文件下载分发：管理员上传文件到服务器，生成公开下载链接
#
# 文件本体落盘在 backend/download_files/<token><ext>（gitignored，不随部署上传），
# 元数据每文件一行；公开链接 = /api/dl/<token>（22 位随机串，不可枚举，无需登录）。
# 更新文件沿用同一 token，链接不变；删除即失效。
# 上传上限 10MB（线上该站点 nginx client_max_body_size 12m，留出 multipart 余量）；
# 响应一律按附件下载，html/svg/js 等危险类型降级为 octet-stream，避免同源存储型 XSS。

import os
import re
import secrets
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Session, joinedload, relationship

from database import Base, get_db
from deps import _client_ip, _log, require_admin
from models import User
from ratelimit import SlidingWindow
from schemas import MessageResponse

router = APIRouter()

_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "download_files"))
_MAX_BYTES = 10 * 1024 * 1024
_MAX_NAME = 200
_MAX_NOTE = 200
# 这些类型若按原 MIME 返回，同源打开可执行脚本（存储型 XSS），一律降级为二进制流
_RISKY_EXT = {".html", ".htm", ".xhtml", ".svg", ".xml", ".js", ".mjs", ".css"}
_dl_ip = SlidingWindow(120, 60)   # 公开下载限流：同一 IP 每分钟 120 次


class DownloadFile(Base):
    """下载分发文件 —— 一行一个文件，文件本体在服务器磁盘上（stored 为磁盘文件名）"""
    __tablename__ = "download_files"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    token = Column(String(32), unique=True, nullable=False, index=True, comment="公开下载令牌（链接用，随机不可枚举）")
    filename = Column(String(_MAX_NAME), nullable=False, comment="展示与下载文件名（可改，不影响链接）")
    stored = Column(String(80), nullable=False, comment="磁盘文件名（token + 后缀）")
    size = Column(Integer, nullable=False, default=0, server_default="0", comment="文件大小（字节）")
    content_type = Column(String(120), nullable=False, default="application/octet-stream", comment="响应 MIME")
    note = Column(String(_MAX_NOTE), nullable=True, comment="备注")
    uploader_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True, comment="上传者")
    downloads = Column(Integer, nullable=False, default=0, server_default="0", comment="下载次数")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="上传时间")
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间")

    uploader = relationship("User")

    def __repr__(self):
        return f"<DownloadFile(id={self.id}, filename='{self.filename}')>"


class DownloadFileItem(BaseModel):
    id: int
    filename: str
    size: int
    note: Optional[str] = None
    downloads: int
    uploader: Optional[str] = None
    url: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class DownloadFileListResponse(BaseModel):
    total: int
    files: list[DownloadFileItem] = []


def _item(f: DownloadFile) -> DownloadFileItem:
    """序列化一行（url 为相对路径，前端拼站点域名得到可分享的完整链接）"""
    return DownloadFileItem(
        id=f.id, filename=f.filename, size=f.size or 0, note=f.note,
        downloads=f.downloads or 0,
        uploader=(f.uploader.nickname or f.uploader.username) if f.uploader else None,
        url=f"/api/dl/{f.token}", created_at=f.created_at, updated_at=f.updated_at,
    )


def _safe_name(raw: str, fallback: str) -> str:
    """取纯文件名做展示与下载名：去路径分隔与控制字符，仅作字符串使用，不参与磁盘路径"""
    name = os.path.basename((raw or "").replace("\\", "/")).strip()
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip(" .")
    return (name or fallback)[:_MAX_NAME]


def _ext_of(raw: str) -> str:
    """保留后缀里的字母数字（最多 12 位），防止后缀携带路径/特殊字符"""
    ext = re.sub(r"[^a-z0-9]", "", os.path.splitext(raw or "")[1].lower().lstrip("."))[:12]
    return "." + ext if ext else ""


def _mime_of(stored: str, declared: Optional[str]) -> str:
    if os.path.splitext(stored)[1].lower() in _RISKY_EXT:
        return "application/octet-stream"
    return ((declared or "").strip() or "application/octet-stream")[:120]


def _write(stored: str, raw: bytes) -> None:
    os.makedirs(_ROOT, exist_ok=True)
    with open(os.path.join(_ROOT, stored), "wb") as fh:
        fh.write(raw)


def _remove(stored: str) -> None:
    """删除磁盘文件（缺失视为已删除，不报错）"""
    try:
        os.remove(os.path.join(_ROOT, stored))
    except OSError:
        pass


def _read_upload(file: UploadFile) -> bytes:
    raw = file.file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="文件内容为空")
    if len(raw) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"文件超过 {_MAX_BYTES // 1024 // 1024}MB 上限")
    return raw


def _get(db: Session, file_id: int) -> DownloadFile:
    row = db.query(DownloadFile).filter(DownloadFile.id == file_id).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="文件不存在")
    return row


@router.get("/api/admin/downloads", response_model=DownloadFileListResponse, tags=["管理员"])
def admin_list_downloads(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """下载链接列表（仅管理员，按上传时间倒序）"""
    rows = (
        db.query(DownloadFile)
        .options(joinedload(DownloadFile.uploader))
        .order_by(DownloadFile.created_at.desc(), DownloadFile.id.desc())
        .all()
    )
    return DownloadFileListResponse(total=len(rows), files=[_item(r) for r in rows])


@router.post("/api/admin/downloads", response_model=DownloadFileItem,
             status_code=status.HTTP_201_CREATED, tags=["管理员"])
def admin_create_download(
    admin: User = Depends(require_admin),
    file: UploadFile = File(...),
    name: str = Form(""),
    note: str = Form(""),
    db: Session = Depends(get_db),
):
    """上传文件并生成公开下载链接（仅管理员，POST multipart：file 必填，name/note 可选）"""
    raw = _read_upload(file)
    original = file.filename or "download"
    token = secrets.token_urlsafe(16)
    stored = token + _ext_of(original)
    _write(stored, raw)
    row = DownloadFile(
        token=token,
        filename=_safe_name(name or original, "download" + _ext_of(original)),
        stored=stored,
        size=len(raw),
        content_type=_mime_of(stored, file.content_type),
        note=(note or "").strip()[:_MAX_NOTE] or None,
        uploader_id=admin.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    row.uploader = admin   # 供 _item 取上传者显示名
    _log(f"[downloads] 新增 id={row.id} {row.filename} {row.size}B by {admin.username}")
    return _item(row)


@router.put("/api/admin/downloads/{file_id}", response_model=DownloadFileItem, tags=["管理员"])
def admin_update_download(
    file_id: int,
    _admin: User = Depends(require_admin),
    file: Optional[UploadFile] = File(default=None),
    name: Optional[str] = Form(default=None),
    note: Optional[str] = Form(default=None),
    db: Session = Depends(get_db),
):
    """更新文件（仅管理员）：传 file 替换内容（沿用同一 token，链接不变），name/note 改展示名与备注"""
    row = _get(db, file_id)
    if file is not None:
        raw = _read_upload(file)
        stored = row.token + _ext_of(file.filename or row.filename)
        _write(stored, raw)
        if stored != row.stored:
            _remove(row.stored)
        row.stored = stored
        row.size = len(raw)
        row.content_type = _mime_of(stored, file.content_type)
        if not (name or "").strip():
            row.filename = _safe_name(file.filename, row.filename)
    if name is not None and name.strip():
        row.filename = _safe_name(name, row.filename)
    if note is not None:
        row.note = note.strip()[:_MAX_NOTE] or None
    db.commit()
    db.refresh(row)
    _log(f"[downloads] 更新 id={row.id} {row.filename} {row.size}B")
    return _item(row)


@router.delete("/api/admin/downloads/{file_id}", response_model=MessageResponse, tags=["管理员"])
def admin_delete_download(
    file_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """删除文件及其下载链接（仅管理员，磁盘文件一并清除）"""
    row = _get(db, file_id)
    _remove(row.stored)
    db.delete(row)
    db.commit()
    _log(f"[downloads] 删除 id={file_id} {row.filename}")
    return MessageResponse(message="文件已删除，下载链接已失效")


@router.get("/api/dl/{token}", tags=["下载"])
def public_download(token: str, request: Request, db: Session = Depends(get_db)):
    """公开下载（无需登录）：token 即凭据；按附件返回，下载次数 +1"""
    if len(token) > 32 or not _dl_ip.allow(_client_ip(request)):
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
    row = db.query(DownloadFile).filter(DownloadFile.token == token).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="链接无效或文件已被删除")
    if os.path.basename(row.stored) != row.stored or not os.path.isfile(os.path.join(_ROOT, row.stored)):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="文件已从服务器移除，请联系站务")
    row.downloads = (row.downloads or 0) + 1
    db.commit()
    return FileResponse(os.path.join(_ROOT, row.stored),
                        media_type=row.content_type, filename=row.filename)
