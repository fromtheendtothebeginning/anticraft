# features/img2latex.py — 图文转 LaTeX 工具：AI 识图生成 LaTeX 代码 + 服务器 XeLaTeX 编译出 PDF

import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Session

import aisettings
from database import Base, get_db
from deps import ai_vision_text, get_current_user_obj, _log
from models import AiKey, AiSetting, User
from ratelimit import SlidingWindow

router = APIRouter()

_MAX_IMAGES = 5
_MAX_IMAGE_BYTES = 6 * 1024 * 1024   # 单张 ≤6MB
_MAX_MD_FILES = 2                    # Markdown 文件 ≤2 份
_MAX_MD_BYTES = 256 * 1024           # 单份 md ≤256KB
_MAX_MD_CHARS = 50000                # 单份 md 送入 AI 最多 5 万字
_MAX_NOTES_CHARS = 20000             # 文字说明 ≤2 万字
_AI_TIMEOUT = 300                    # 识图生成超时
_COMPILE_TIMEOUT = 90                # 单遍 XeLaTeX 超时
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0

_ALLOWED_MIME = {"image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"}

# ── 会话持久化（三步骤向导的撤销/恢复）──
_FILES_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "img2latex_files")
_IMG_EXT_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
    ".pdf": "application/pdf",
}


class Img2LatexSession(Base):
    """图文转 LaTeX 会话（每用户一行）：步骤间撤销/恢复的状态快照"""
    __tablename__ = "img2latex_session"

    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    step = Column(Integer, nullable=False, default=1)
    notes = Column(Text, nullable=True)
    code = Column(Text, nullable=True)
    files = Column(Text, nullable=True)       # JSON: [{name, saved, kind, size}]
    pdf = Column(String(300), nullable=True)  # 已保存 PDF 文件名
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


def _files_dir(user_id: int) -> str:
    d = os.path.join(_FILES_ROOT, str(user_id))
    os.makedirs(d, exist_ok=True)
    return d


def _session_files(db: Session, user_id: int) -> list:
    s = db.query(Img2LatexSession).filter(Img2LatexSession.user_id == user_id).first()
    if s and s.files:
        try:
            return json.loads(s.files)
        except Exception:
            return []
    return []


def _clear_user_files(user_id: int) -> None:
    """清空某用户的会话文件目录（图片/md/pdf）"""
    d = _files_dir(user_id)
    if os.path.isdir(d):
        for fn in os.listdir(d):
            try:
                os.remove(os.path.join(d, fn))
            except OSError:
                pass


def _save_blob(user_id: int, data: bytes, ext: str) -> str:
    """落盘扩展名白名单：仅纯字母数字后缀（防夹带路径分隔符），文件名主体为随机 uuid。"""
    ext = ext if re.match(r"^\.[A-Za-z0-9]{1,8}$", ext or "") else ".bin"
    saved = uuid.uuid4().hex + ext
    dirpath = Path(_files_dir(user_id)).resolve()
    path = (dirpath / saved).resolve()
    if not path.is_relative_to(dirpath):
        raise ValueError("illegal file path")
    with path.open("wb") as fh:
        fh.write(data)
    return saved


def _mime_for_name(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    return _IMG_EXT_MIME.get(ext, "text/plain; charset=utf-8")


def _session_payload(db: Session, user_id: int) -> dict:
    s = db.query(Img2LatexSession).filter(Img2LatexSession.user_id == user_id).first()
    files = []
    if s and s.files:
        try:
            files = json.loads(s.files)
        except Exception:
            files = []
    return {
        "step": s.step if s else 1,
        "notes": (s.notes or "") if s else "",
        "code": s.code or "" if s else "",
        "files": [{**f, "url": f"/api/tools/img2latex/session/file/{f['saved']}"} for f in files],
        "pdf": f"/api/tools/img2latex/session/file/{s.pdf}" if s and s.pdf else None,
    }


def _get_session_row(db: Session, user_id: int) -> Img2LatexSession:
    s = db.query(Img2LatexSession).filter(Img2LatexSession.user_id == user_id).first()
    if not s:
        s = Img2LatexSession(user_id=user_id)
        db.add(s)
    return s


@router.get("/api/tools/img2latex/session", tags=["工具"])
def img2latex_session_get(current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """读取当前用户的三步向导会话快照（进入页面/回退时恢复）"""
    return {"session": _session_payload(db, current_user.id)}


@router.post("/api/tools/img2latex/session", tags=["工具"])
def img2latex_session_save(
    step: int = Form(1),
    notes: str = Form(""),
    keep_saved: str = Form(""),
    images: Optional[list[UploadFile]] = File(default=None),
    md_files: Optional[list[UploadFile]] = File(default=None),
    current_user: User = Depends(get_current_user_obj),
    db: Session = Depends(get_db),
):
    """保存第 1 步的输入：本次上传的图片/md 落到磁盘（按扩展名分辨）+ 保留 keep_saved 指定的已存文件，
    未保留的旧文件从磁盘清理。文字说明随存，供撤销恢复与二次生成。"""
    images = images or []
    md_files = md_files or []
    notes = (notes or "").strip()
    if len(images) > _MAX_IMAGES:
        raise HTTPException(status_code=400, detail=f"最多上传 {_MAX_IMAGES} 张图片")
    if len(md_files) > _MAX_MD_FILES:
        raise HTTPException(status_code=400, detail=f"最多上传 {_MAX_MD_FILES} 份 Markdown 文件")
    if len(notes) > _MAX_NOTES_CHARS:
        raise HTTPException(status_code=400, detail=f"文字说明不能超过 {_MAX_NOTES_CHARS} 字")

    keep = {x.strip() for x in keep_saved.split(",") if x.strip()}
    new_files = []
    for f in images:
        raw = f.file.read()
        if len(raw) > _MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail=f"图片「{f.filename}」超过 6MB，请压缩后重试")
        ext = os.path.splitext(f.filename or "")[1] or ".png"
        saved = _save_blob(current_user.id, raw, ext)
        new_files.append({"name": f.filename, "saved": saved, "kind": "image", "size": len(raw)})
    for f in md_files:
        raw = f.file.read()
        if len(raw) > _MAX_MD_BYTES:
            raise HTTPException(status_code=400, detail=f"Markdown 文件「{f.filename}」超过 256KB，请精简后重试")
        ext = os.path.splitext(f.filename or "")[1] or ".md"
        saved = _save_blob(current_user.id, raw, ext)
        new_files.append({"name": f.filename, "saved": saved, "kind": "md", "size": len(raw)})

    # 保留旧会话中仍被引用的文件
    kept = [f for f in _session_files(db, current_user.id) if f["saved"] in keep]
    files = kept + new_files

    s = _get_session_row(db, current_user.id)
    # 只有输入真正变化（文件集合或文字说明不同）才丢弃旧代码/PDF；纯回退后原样保存则保留
    old_sig = sorted((f["name"], f["kind"]) for f in _session_files(db, current_user.id))
    new_sig = sorted((f["name"], f["kind"]) for f in files)
    changed = (old_sig != new_sig) or ((notes or None) != (s.notes if s else None))

    # 清理磁盘上不再被引用的旧文件；未变化时已编译 PDF 仍被会话引用，一并保留
    saved_set = {f["saved"] for f in files}
    if not changed and s.pdf:
        saved_set.add(s.pdf)
    d = _files_dir(current_user.id)
    for fn in os.listdir(d):
        if fn not in saved_set:
            try:
                os.remove(os.path.join(d, fn))
            except OSError:
                pass

    s.step = max(1, min(step, 3))
    s.notes = notes or None
    s.files = json.dumps(files, ensure_ascii=False)
    if changed:
        s.code = None
        s.pdf = None
    db.commit()
    return {"session": _session_payload(db, current_user.id)}


class StepRequest(BaseModel):
    step: int


class CodeRequest(BaseModel):
    code: str


@router.post("/api/tools/img2latex/session/step", tags=["工具"])
def img2latex_session_step(req: StepRequest, current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """保存当前所在步骤（撤销/跳转时记录）"""
    s = _get_session_row(db, current_user.id)
    s.step = max(1, min(req.step, 3))
    db.commit()
    return {"ok": True}


@router.post("/api/tools/img2latex/session/code", tags=["工具"])
def img2latex_session_code(req: CodeRequest, current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """保存第 2 步生成的 LaTeX 代码（编辑后同样保存）"""
    if len(req.code) > 200_000:
        raise HTTPException(status_code=400, detail="LaTeX 代码过长（>200KB）")
    s = _get_session_row(db, current_user.id)
    s.code = req.code or None
    # 新代码进来 → 旧 PDF 丢弃
    s.pdf = None
    db.commit()
    return {"ok": True}


@router.post("/api/tools/img2latex/session/pdf", tags=["工具"])
def img2latex_session_pdf(file: UploadFile = File(...), current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """保存第 3 步编译出的 PDF 文件（供回退/刷新后恢复预览与下载）"""
    raw = file.file.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="PDF 过大（>20MB）")
    saved = _save_blob(current_user.id, raw, ".pdf")
    s = _get_session_row(db, current_user.id)
    s.pdf = saved
    db.commit()
    return {"pdf": f"/api/tools/img2latex/session/file/{saved}"}


@router.get("/api/tools/img2latex/session/file/{saved}", tags=["工具"])
def img2latex_session_file(saved: str, current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """读取当前用户会话内已保存的文件（图片预览 / PDF / md 内容）——按文件名白名单防越权"""
    allowed = {f["saved"] for f in _session_files(db, current_user.id)}
    s = db.query(Img2LatexSession).filter(Img2LatexSession.user_id == current_user.id).first()
    if s and s.pdf:
        allowed.add(s.pdf)
    if saved not in allowed:
        raise HTTPException(status_code=404, detail="文件不存在")
    path = os.path.join(_files_dir(current_user.id), saved)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="文件不存在")
    with open(path, "rb") as fh:
        return Response(content=fh.read(), media_type=_mime_for_name(saved))


def _cfg(msg):
    """AI 配置类错误（前端弹窗引导去 AI 设置）"""
    return HTTPException(status_code=400, detail={"code": "ai_config", "message": msg})


def _resolve_vision_model(db: Session, user_id: int):
    """识图模型：AI 设置的 vision_key_id + vision_model，返回 (provider, 明文key, model, base_url)"""
    s = db.query(AiSetting).filter(AiSetting.user_id == user_id).first()
    key_id = s.vision_key_id if s else None
    model = (s.vision_model or "").strip() if s else ""
    if not key_id and not model:
        raise _cfg("尚未在 AI 设置中配置识图模型，请到「我的 → AI 设置」完成配置")
    if not model:
        raise _cfg("识图模型未选择完整，请到「我的 → AI 设置」补全后重试")
    if not key_id:
        raise _cfg("识图模型未绑定 API Key，请到「我的 → AI 设置」补全后重试")
    key = db.query(AiKey).filter(AiKey.id == key_id, AiKey.user_id == user_id).first()
    if not key or not key.api_key_enc:
        raise _cfg("识图模型绑定的 API Key 不存在或无密钥，请到 AI 设置重新配置")
    return key.provider, aisettings.decrypt_secret(key.api_key_enc), model, key.custom_base_url


def _resolve_main_model(db: Session, user_id: int):
    """当前主模型：AI 设置选中的 Key + 模型（纯文字/Markdown 生成用，无需识图能力）"""
    s = db.query(AiSetting).filter(AiSetting.user_id == user_id).first()
    key_id = s.key_id if s else None
    model = (s.model or "").strip() if s else ""
    if not key_id or not model:
        raise _cfg("尚未在 AI 设置中选择当前使用的 Key 与模型")
    key = db.query(AiKey).filter(AiKey.id == key_id, AiKey.user_id == user_id).first()
    if not key or not key.api_key_enc:
        raise _cfg("当前选中的 API Key 不存在或无密钥，请到 AI 设置重新配置")
    return key.provider, aisettings.decrypt_secret(key.api_key_enc), model, key.custom_base_url


# ============================================
# AI 生成 LaTeX
# ============================================

_SYSTEM_PROMPT = (
    "你是专业的 LaTeX 排版专家。用户会提供图片（题目、笔记、板书、试卷、文档截图等）、文字说明和/或 Markdown 文件内容，"
    "请把内容整理成一份完整、可直接编译的 LaTeX 文档。\n"
    "要求：\n"
    "1. 第一行必须是 \\documentclass，文档类固定用 ctexart（支持中文，XeLaTeX 编译）；最后一行必须是 \\end{document}，结构完整；\n"
    "2. 图片中的文字、数学公式、表格、列表如实还原；Markdown 内容保留其结构（标题→section、列表→itemize/enumerate、表格→tabular、代码→verbatim/listing）；文字说明中的要求尽量满足；\n"
    "3. 公式用标准 LaTeX 数学环境（amsmath）：下标 _ 上标 ^ 分数 \\frac 求和 \\sum 积分 \\int；\n"
    "4. 只使用常见宏包：amsmath、amssymb、geometry、enumitem、booktabs、array、fancyvrb；禁止冷门或过时宏包；\n"
    "5. 禁止 \\includegraphics 等引用外部文件的命令（编译环境无外部文件）；图片内容用文字/表格/公式表达；\n"
    "6. 数学铁律：只有真正的数学公式才用数学环境（$...$、\\(...\\)、\\[\\]）；普通文本（数字、百分比、文件名、代码标识符）一律写成普通文本，不要包数学环境；\n"
    "7. 百分号在 LaTeX 中是注释符，所有需要显示的 % 必须写为 \\%（含数学环境内外）；如 30% 写 30\\%，3/10 写 3/10（不要写成 \\\\(3/10=30\\\\%\\\\) 这种用数学环境包普通文本的写法）；\n"
    "8. 文本中的特殊字符必须转义：下划线 \\_、百分号 \\%、美元 \\$、与号 \\&、井号 \\#、上尖 ^ 写 \\textasciicircum{}、波浪号 ~ 写 \\textasciitilde{}、反斜杠写 \\textbackslash{}、反引号 ` 写普通单引号 '（不要输出反引号）；\n"
    "9. 严禁把图片中出现的英文单词/标识符（如 \\counselors、\\switchView、\\log、\\console）当作 LaTeX 命令输出——它们必须写在 \\texttt{...} 内且反斜杠一律用 \\textbackslash{} 表示；\n"
    "10. 只输出 LaTeX 源代码本身：不要 markdown 代码块围栏（```），不要任何解释或多余文字。"
)


def _strip_fence(text: str) -> str:
    """去掉模型可能包裹的 markdown 代码围栏"""
    m = re.search(r"```(?:latex|tex)?\s*\n(.*?)\n?\s*```", text, re.S)
    return (m.group(1) if m else text).strip() + "\n"


_REVIEW_PROMPT = r"""你是 LaTeX 编译专家。用户会给你一段 XeLaTeX 源码（ctexart 文档类，支持中文），可能附带编译错误日志。
请审查代码并修复所有会导致编译失败的问题：
1. 未定义的命令/环境：
   - 若属于常见宏包命令（如 \multirow \rowcolor \textcolor \url \href \cancel \mathbb \dfrac \binom 等），自动补上对应宏包 \usepackage{...}（放在 \begin{document} 之前）；
   - 若是普通文本或代码标识符被误当命令（如 \counselors \switchView \log 等），改写成纯文本或 \texttt{...} 内用 \textbackslash 表示；
2. 环境不配对（\begin/\end 缺一）、括号不配对、% 注释符误用；
3. 数学环境里包了普通文本、特殊字符未转义（_ % $ & # ^ ~ \）；
4. 表格/列表语法错误（multirow/multicolumn 参数、tabular 列格式、\\ 使用）；
5. 需要显示的百分号一律写 \%。
直接输出修复后的完整 LaTeX 源码（含 \documentclass 到 \end{document}），不要代码块围栏、不要任何解释；若代码没有问题则原样输出。"""


def _ai_review(provider_id, api_key, model, base_url, code: str, log_tail: str = None) -> str:
    """用 AI 审查并修复 LaTeX 代码；附上编译错误日志可针对性修复。返回修复后的代码。"""
    user = "请审查并修复下面的 LaTeX 源码：\n\n" + code
    if log_tail:
        user += "\n\n【XeLaTeX 编译错误日志】\n" + log_tail[-1500:]
    return _ai_vision_chat(provider_id, api_key, model, base_url, _REVIEW_PROMPT, user, [])


def _ai_vision_chat(provider_id, api_key, model, base_url, system, user_text, images):
    """带图对话：images = [(mime, b64)]，user_text 为已组装好的文字/Markdown 说明。委托 deps 通用实现。"""
    return ai_vision_text(provider_id, api_key, model, base_url, system,
                          user_text or "请根据输入内容生成 LaTeX 文档。",
                          images, timeout=_AI_TIMEOUT)


@router.post("/api/tools/img2latex/generate", tags=["工具"])
def img2latex_generate(
    images: Optional[list[UploadFile]] = File(default=None),
    md_files: Optional[list[UploadFile]] = File(default=None),
    notes: str = Form(""),
    use_session: str = Form(""),
    current_user: User = Depends(get_current_user_obj),
    db: Session = Depends(get_db),
):
    """图片/Markdown 文件/文字说明（任一或任意组合）→ AI 生成 LaTeX 代码（需在 AI 设置配置识图模型）
    use_session=1 且无上传文件时，改从会话已保存的文件读取（刷新/回退后二次生成用）"""
    images = images or []
    md_files = md_files or []
    notes = (notes or "").strip()
    if len(images) > _MAX_IMAGES:
        raise HTTPException(status_code=400, detail=f"最多上传 {_MAX_IMAGES} 张图片")
    if len(md_files) > _MAX_MD_FILES:
        raise HTTPException(status_code=400, detail=f"最多上传 {_MAX_MD_FILES} 份 Markdown 文件")
    if len(notes) > _MAX_NOTES_CHARS:
        raise HTTPException(status_code=400, detail=f"文字说明不能超过 {_MAX_NOTES_CHARS} 字")

    parsed = []
    md_texts = []
    for f in images:
        raw = f.file.read()
        if len(raw) > _MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail=f"图片「{f.filename}」超过 6MB，请压缩后重试")
        mime = (f.content_type or "").lower().split(";")[0]
        if mime not in _ALLOWED_MIME:
            raise HTTPException(status_code=400, detail=f"不支持的图片格式「{mime}」，请用 png/jpg/webp/gif/bmp")
        import base64 as _b64
        parsed.append((mime, _b64.b64encode(raw).decode()))
    for f in md_files:
        raw = f.file.read()
        if len(raw) > _MAX_MD_BYTES:
            raise HTTPException(status_code=400, detail=f"Markdown 文件「{f.filename}」超过 256KB，请精简后重试")
        md_texts.append(raw.decode("utf-8", errors="replace")[:_MAX_MD_CHARS])

    # 无上传文件且要求使用会话文件 → 从会话磁盘读取
    if not images and not md_files and use_session == "1":
        for f in _session_files(db, current_user.id):
            path = os.path.join(_files_dir(current_user.id), f["saved"])
            if not os.path.exists(path):
                continue
            with open(path, "rb") as fh:
                raw = fh.read()
            if f["kind"] == "image":
                import base64 as _b64
                parsed.append((_mime_for_name(f["saved"]), _b64.b64encode(raw).decode()))
            elif f["kind"] == "md":
                if len(raw) <= _MAX_MD_BYTES:
                    md_texts.append(raw.decode("utf-8", errors="replace")[:_MAX_MD_CHARS])

    if not images and not md_files and not parsed and not md_texts and not notes:
        raise HTTPException(status_code=400, detail="请至少提供图片、Markdown 文件或文字说明中的一种")

    user_text = "请根据以下输入内容生成 LaTeX 文档。"
    if md_texts:
        for i, mt in enumerate(md_texts, 1):
            user_text += f"\n\n【Markdown 文件 {i}】\n{mt}"
    if notes:
        user_text += f"\n\n【文字说明】\n{notes}"

    # 模型选择：含图片必须用识图模型（能读图）；纯文字/Markdown 用当前主模型
    if parsed:
        provider_id, api_key, model, base_url = _resolve_vision_model(db, current_user.id)
    else:
        provider_id, api_key, model, base_url = _resolve_main_model(db, current_user.id)
    _log(f"img2latex generate: user={current_user.id} model={provider_id}/{model} "
         f"images={len(parsed)} md={len(md_texts)} notes={len(notes)}")
    code = _strip_fence(_ai_vision_chat(provider_id, api_key, model, base_url, _SYSTEM_PROMPT, user_text, parsed))
    if code.strip():
        code = _strip_fence(_ai_review(provider_id, api_key, model, base_url, code))
    return {"code": code}


# ============================================
# XeLaTeX 编译
# ============================================

class CompileRequest(BaseModel):
    code: str


def _fix_math_percent(code: str) -> str:
    """数学环境内裸 % 转义为转义百分号：% 是 LaTeX 注释符，若 AI 把含 % 的文本包进数学环境，
    会导致 % 吞掉闭合分隔符（如 \\(3/10 = 30%\\)）使文档编译失败。"""
    def _esc(m):
        return re.sub(r"(?<!\\)%", r"\\%", m.group(0))
    return re.sub(r"(\\\[.*?\\\]|\\\(.*?\\\)|\$\$.*?\$\$|\$[^$\n]*\$)", _esc, code, flags=re.S)


def _sanitize_latex(code: str) -> str:
    """编译前防御性清洗：去首尾空白 + 修复数学环境内 % + 补齐缺失的文档头"""
    code = code.strip()
    if not code.startswith("\\documentclass"):
        code = "\\documentclass{ctexart}\n" + code
    code = _fix_math_percent(code)
    return code + "\n"


def _extract_undefined_cmd(log_tail: str):
    """从 XeLaTeX 日志提取第一个未定义控制序列的命令名（无则返回 None）"""
    m = re.search(r"Undefined control sequence\.(?:[^\n]*\n){0,3}[^\n]*\\([a-zA-Z]+)", log_tail)
    return m.group(1) if m else None


# 常见宏包命令 → 宏包：遇到这些未定义命令时自动补 \usepackage，而非字面化
_PACKAGE_FIX = {
    "multirow": "multirow",
    "rowcolor": "colortbl",
    "cellcolor": "colortbl",
    "arrayrulecolor": "colortbl",
    "cmidrule": "booktabs",
    "textcolor": "xcolor",
    "colorbox": "xcolor",
    "fcolorbox": "xcolor",
    "color": "xcolor",
    "includegraphics": "graphicx",
    "url": "url",
    "href": "hyperref",
    "cancel": "cancel",
    "bm": "bm",
    "checkmark": "amssymb",
    "mathbb": "amssymb",
    "mathcal": "amssymb",
    "mathrm": "amssymb",
    "dfrac": "amsmath",
    "tfrac": "amsmath",
    "cfrac": "amsmath",
    "binom": "amsmath",
    "boxed": "amsmath",
    "operatorname": "amsmath",
    "substack": "amsmath",
    "boldsymbol": "amsmath",
    "lstinline": "listings",
    "lstlisting": "listings",
}


def _add_package(code: str, pkg: str) -> str:
    """在文档头部插入 \\usepackage{pkg}（已存在则跳过）"""
    if re.search(r"\\usepackage(\[[^\]]*\])?\{" + re.escape(pkg) + r"\}", code):
        return code
    m = re.search(r"\\begin\{document\}", code)
    if not m:
        return code
    return code[:m.start()] + f"\\usepackage{{{pkg}}}\n" + code[m.start():]


def _repair_undefined(code: str, log_tail: str) -> str:
    """编译失败自动修复：常见宏包命令自动补 \\usepackage；其余未定义命令替换为
    textbackslash + 名字按字面渲染。返回修复后的代码（无变化则原样）。"""
    name = _extract_undefined_cmd(log_tail)
    if not name:
        return code
    pkg = _PACKAGE_FIX.get(name)
    if pkg:
        fixed = _add_package(code, pkg)
    else:
        fixed = re.sub(r"\\" + name + r"(?![a-zA-Z])", r"\\textbackslash{}" + name, code)
    return fixed if fixed != code else code


@router.get("/api/tools/img2latex/available", tags=["工具"])
def img2latex_available(_user: User = Depends(get_current_user_obj)):
    """编译引擎可用性（xelatex 是否安装）"""
    return {"engine": shutil.which("xelatex") is not None}


def _run_xelatex(tmp: str, name: str) -> Optional[str]:
    """编译一遍；成功返回 None，失败返回日志尾部（供诊断/自动修复）"""
    cmd = ["xelatex", "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape",
           f"-output-directory={tmp}", f"{name}.tex"]
    # kpathsea 环境变量优先于 texmf.cnf：paranoid 档禁止 \input/\openout 读写绝对路径与上级目录，防沙箱逃逸读文件
    env = {**os.environ, "openin_any": "p", "openout_any": "p"}
    r = subprocess.run(cmd, cwd=tmp, capture_output=True, timeout=_COMPILE_TIMEOUT,
                       creationflags=_CREATE_NO_WINDOW, env=env)
    if os.path.exists(os.path.join(tmp, f"{name}.pdf")):
        return None
    log_path = os.path.join(tmp, f"{name}.log")
    if os.path.exists(log_path):
        try:
            with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
                return fh.read()[-2000:]
        except Exception:
            pass
    return r.stderr.decode("utf-8", errors="replace")[-500:]


_compile_user = SlidingWindow(10, 600)  # 每用户 10 分钟最多 10 次：XeLaTeX 很吃 CPU，防并发刷爆


@router.post("/api/tools/img2latex/compile", tags=["工具"])
def img2latex_compile(req: CompileRequest, current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """LaTeX 代码 → PDF（XeLaTeX 编译两遍）。失败时依次尝试：AI 依错误日志修复 → 正则修复 Undefined → 重试（≤3 轮）"""
    if not _compile_user.allow(str(current_user.id)):
        raise HTTPException(status_code=429, detail="编译请求过于频繁，请稍后再试")
    code = (req.code or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="请先生成或粘贴 LaTeX 代码")
    if shutil.which("xelatex") is None:
        raise HTTPException(status_code=503, detail="服务器未安装 LaTeX 编译引擎（xelatex），请联系管理员")
    if len(code) > 200_000:
        raise HTTPException(status_code=400, detail="LaTeX 代码过长（>200KB）")

    code = _sanitize_latex(code)
    tmp = Path(tempfile.mkdtemp(prefix="anticraft_tex_"))
    try:
        tex_path = tmp / "document.tex"
        with tex_path.open("w", encoding="utf-8") as fh:
            fh.write(code)

        log_tail = _run_xelatex(str(tmp), "document")
        if log_tail:
            # 1) AI 依错误日志修复（需主模型配置；异常则静默跳过）
            try:
                p, rev_key, rev_model, rev_base = _resolve_main_model(db, current_user.id)
                fixed = _ai_review(p, rev_key, rev_model, rev_base, code, log_tail)
                if fixed and fixed.strip() and fixed != code:
                    code = fixed
                    with tex_path.open("w", encoding="utf-8") as fh:
                        fh.write(code)
                    log_tail = _run_xelatex(str(tmp), "document")
            except HTTPException:
                pass
            except Exception as e:
                _log(f"img2latex ai-review(compile) failed: {str(e)[:150]}")

        # 2) 正则修复 Undefined control sequence（≤3 轮）
        attempts = 0
        while log_tail and attempts < 3:
            fixed = _repair_undefined(code, log_tail)
            if fixed == code:
                break                       # 不是未定义命令问题，停止自动修复
            code = fixed
            with tex_path.open("w", encoding="utf-8") as fh:
                fh.write(code)
            log_tail = _run_xelatex(str(tmp), "document")
            attempts += 1

        if log_tail:
            raise HTTPException(status_code=422, detail={"message": "LaTeX 编译失败", "log": log_tail})
        _run_xelatex(str(tmp), "document")  # 第二遍解析目录/交叉引用
        with (tmp / "document.pdf").open("rb") as fh:
            pdf = fh.read()
        return Response(content=pdf, media_type="application/pdf",
                        headers={"Content-Disposition": "inline; filename=document.pdf"})
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=422, detail={"message": "编译超时（可能死循环或文档过大）", "log": ""})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"编译异常：{str(e)[:200]}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)