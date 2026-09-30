# features/print_service.py — 云打印工具：把 AntiPrint（print.anticraft.top）的打印 API
# 代理给站内用户。AntiPrint 的 CORS 只放行它自己的前端源，浏览器无法直连，统一走本后端转发。
# AntiPrint 令牌（24h）由前端保存在 localStorage，经 X-Print-Token 头带来，本服务不落库、
# 不保存任何 AntiPrint 凭据。首次使用在前端输 anticraft 账号密码换令牌
# （AntiPrint /api/login/anticraft 校验通过后自动建号，anticraft 来源账号在其侧免计费）。
# 接口契约以 AntiPrint 站内「API 文档」为准；本地联调用 .env 的 PRINT_BASE 覆盖服务地址。

import os

import requests
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from deps import _client_ip, get_current_user_obj
from models import User
from ratelimit import SlidingWindow

router = APIRouter()

PRINT_BASE = os.environ.get("PRINT_BASE", "https://print.anticraft.top").rstrip("/")
_TIMEOUT = (10, 120)   # (连接, 读)：上传与 Office 转 PDF 可能较慢
MAX_FILES = 5
MAX_FILE_BYTES = 10 * 1024 * 1024
_login_ip = SlidingWindow(5, 60)  # 登录转发限流：防止本接口被当作对 AntiPrint 的爆破中继


class PrintLoginBody(BaseModel):
    username: str = ""
    password: str = ""


def _forward(resp: requests.Response) -> dict:
    """AntiPrint 响应原样转发：2xx 回 JSON，错误透传状态码与 detail（中文说明）。"""
    try:
        data = resp.json()
    except ValueError:
        data = {}
    if resp.status_code >= 400:
        detail = data.get("detail") if isinstance(data, dict) else None
        raise HTTPException(status_code=resp.status_code, detail=detail or "打印服务返回错误")
    return data


def _call(method: str, path: str, token: str, **kwargs) -> dict:
    try:
        resp = requests.request(method, PRINT_BASE + path, timeout=_TIMEOUT,
                                headers={"Authorization": "Bearer " + token}, **kwargs)
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="无法连接打印服务，请稍后重试")
    return _forward(resp)


def _token(request: Request) -> str:
    token = (request.headers.get("X-Print-Token") or "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="尚未绑定打印账号，请先登录打印服务")
    return token


@router.post("/api/print/login", tags=["打印服务"])
def print_login(body: PrintLoginBody, request: Request, current_user: User = Depends(get_current_user_obj)):
    """用 anticraft 账号密码登录 AntiPrint（首次自动建号），令牌交前端保存。

    必须已是站内登录用户：否则这里会成为一个匿名借用本服务器 IP 转发凭据校验的通道。
    """
    if not _login_ip.allow(_client_ip(request)):
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
    username = (body.username or "").strip()
    if not username or not body.password:
        raise HTTPException(status_code=400, detail="请填写用户名和密码")
    try:
        resp = requests.post(PRINT_BASE + "/api/login/anticraft", timeout=_TIMEOUT,
                             json={"username": username, "password": body.password})
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="无法连接打印服务，请稍后重试")
    return _forward(resp)


@router.get("/api/print/balance", tags=["打印服务"])
def print_balance(request: Request, current_user: User = Depends(get_current_user_obj)):
    return _call("GET", "/api/balance", _token(request))


@router.get("/api/print/jobs", tags=["打印服务"])
def print_jobs(request: Request, current_user: User = Depends(get_current_user_obj)):
    return _call("GET", "/api/jobs/mine", _token(request))


@router.get("/api/print/profile", tags=["打印服务"])
def print_profile(request: Request, current_user: User = Depends(get_current_user_obj)):
    """AntiPrint 里的个人默认配置（默认地址/配送方式），前端用来预填表单。"""
    return _call("GET", "/api/profile", _token(request))


@router.get("/api/print/jobs/{job_id}", tags=["打印服务"])
def print_job(job_id: int, request: Request, current_user: User = Depends(get_current_user_obj)):
    return _call("GET", "/api/jobs/%d" % job_id, _token(request))


@router.post("/api/print/jobs", tags=["打印服务"])
async def print_submit(request: Request,
                       current_user: User = Depends(get_current_user_obj),
                       files: list[UploadFile] = File(...),
                       delivery_mode: str = Form("配送"),
                       address: str = Form(""),
                       note: str = Form(""),
                       copies: str = Form("1"),
                       settings: str = Form("")):
    """提交打印任务（multipart 透传；打印参数校验在 AntiPrint 侧，错误中文透传）。"""
    token = _token(request)
    if not files or len(files) > MAX_FILES:
        raise HTTPException(status_code=400, detail="每次提交 1~5 个文件")
    payload = []
    for f in files:
        content = await f.read()
        if len(content) > MAX_FILE_BYTES:
            raise HTTPException(status_code=400, detail="「%s」超过 10MB 限制" % (f.filename or "文件"))
        payload.append(("files", (f.filename, content, f.content_type or "application/octet-stream")))
    data = {"delivery_mode": delivery_mode, "copies": copies}
    if address:
        data["address"] = address
    if note:
        data["note"] = note
    if settings:
        data["settings"] = settings
    try:
        resp = requests.post(PRINT_BASE + "/api/jobs", files=payload, data=data,
                             timeout=_TIMEOUT, headers={"Authorization": "Bearer " + token})
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="无法连接打印服务，请稍后重试")
    return _forward(resp)


@router.post("/api/print/jobs/{job_id}/withdraw", tags=["打印服务"])
def print_withdraw(job_id: int, request: Request, current_user: User = Depends(get_current_user_obj)):
    """撤回任务（待审核/已通过可撤，AntiPrint 自动退费）。"""
    return _call("POST", "/api/jobs/%d/withdraw" % job_id, _token(request))


@router.get("/api/print/jobs/{job_id}/files/{file_id}", tags=["打印服务"])
def print_job_file(job_id: int, file_id: int, request: Request,
                   download: int = 0, current_user: User = Depends(get_current_user_obj)):
    """任务文件透传：预览给转换后的 PDF/图片（浏览器内联打开），download=1 拿原件（附件下载）。"""
    token = _token(request)
    try:
        resp = requests.get(PRINT_BASE + "/api/jobs/%d/files/%d" % (job_id, file_id),
                            params={"download": download} if download else None,
                            stream=True, timeout=_TIMEOUT,
                            headers={"Authorization": "Bearer " + token})
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="无法连接打印服务，请稍后重试")
    if resp.status_code >= 400:
        _forward(resp)   # JSON 错误透传（会抛 HTTPException）
    headers = {"Content-Type": resp.headers.get("Content-Type", "application/octet-stream")}
    if resp.headers.get("Content-Disposition"):
        headers["Content-Disposition"] = resp.headers["Content-Disposition"]
    return StreamingResponse(resp.iter_content(chunk_size=65536),
                             status_code=resp.status_code, headers=headers)
