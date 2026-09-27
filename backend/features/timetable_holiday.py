# 课程表调休：从校历图片 AI 提取调休规则
# 识别结果不落库——由前端确认后并入课表 JSON，走 PUT /api/timetable 保存

import base64
import json
import re
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import get_db
from deps import ai_vision_text, get_current_user_obj
from models import User

import aisettings
from features.campus_service import _resolve_vision_model

router = APIRouter()

MAX_IMAGE_BYTES = 6 * 1024 * 1024  # base64 解码后的图片大小上限
MAX_RULES = 200

PARSE_SYSTEM = (
    "你是校历解析器。从用户提供的学校校历/放假安排图片中提取影响上课的日期安排，"
    "只输出一个 JSON 数组，不要输出任何解释、markdown 代码块或其他文字。"
)


class HolidayParseRequest(BaseModel):
    image_b64: str = Field(..., description="校历图片 base64（可带 data URL 前缀）")
    mime: str = "image/png"
    start_date: str = Field(..., description="学期第一周周一，YYYY-MM-DD")
    week_count: int = Field(20, ge=1, le=40)
    thinking: str = Field("", description="本次识别的思考深度：空=跟随识图模型配置；off=关闭；或厂商档位（low/high/max…）")


@router.get("/api/timetable/holiday/options", tags=["课程表"])
def holiday_thinking_options(current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """校历识别的思考深度选项：跟随用户配置的识图模型，档位按厂商/模型差异化（与 MyPage AI 设置同源）"""
    vision = _resolve_vision_model(current_user.id, db)
    if not vision:
        return {"ok": True, "vision": None}
    return {
        "ok": True,
        "vision": {
            "provider": vision["provider"],
            "model": vision["model"],
            "thinking": vision["thinking"] or "",
            "levels": aisettings.resolve_thinking_levels(vision["provider"], vision["model"]),
        },
    }


def _parse_iso(s):
    try:
        return date.fromisoformat(str(s).strip())
    except (TypeError, ValueError):
        return None


def _extract_json_array(text):
    """模型输出 → JSON 数组（容忍 markdown 代码块与前后缀文字）"""
    m = re.search(r"\[.*\]", (text or "").strip(), re.S)
    if not m:
        # 模型没给数组：多半是图里没认出安排（返回了说明文字）
        raise HTTPException(status_code=422, detail="未能从图片中识别出调休安排，请确认图片内容后重试")
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI 返回的内容无法解析，请重试")
    return data if isinstance(data, list) else []


@router.post("/api/timetable/holiday/parse", tags=["课程表"])
def parse_holiday_image(req: HolidayParseRequest, current_user: User = Depends(get_current_user_obj),
                        db: Session = Depends(get_db)):
    vision = _resolve_vision_model(current_user.id, db)
    if not vision:
        raise HTTPException(status_code=400, detail="尚未配置识图模型，请先在「我的 → AI 设置」配置视觉模型")

    # 本次识别的思考深度：请求未指定时跟随识图模型的全局配置
    thinking = (req.thinking or "").strip()[:10] or (vision["thinking"] or "")

    raw = (req.image_b64 or "").strip()
    mime = req.mime or "image/png"
    if raw.startswith("data:"):  # data URL 前缀：head[5:head.index(';')] = "image/png" 等
        head, raw = raw.split(",", 1)
        if ";" in head:
            mime = head[5:head.index(";")] or mime

    try:
        img = base64.b64decode(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="图片数据无效")
    if len(img) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="图片过大，请压缩后重试")

    start = _parse_iso(req.start_date)
    if not start:
        raise HTTPException(status_code=400, detail="请先在「学期设置」填写第一周周一的日期")
    end = start + timedelta(days=req.week_count * 7 - 1)

    user_text = (
        f"学校校历图片如下。学期第一周周一为 {start.isoformat()}，共 {req.week_count} 周，"
        f"学期日期范围 {start.isoformat()} 至 {end.isoformat()}。"
        "请提取所有影响正常上课的日期安排，输出 JSON 数组，每个元素为以下两种之一：\n"
        '- 放假日（该日放假、不上课）：{"date": "YYYY-MM-DD", "type": "off"}\n'
        '- 调休上课日（因放假，该日按星期 N 的课表上课）：{"date": "YYYY-MM-DD", "type": "follow", "day": N}\n'
        "其中 day 取值 0-6（0=周一，1=周二，……，6=周日）。"
        "日期按图片中的月份结合学期范围推算年份，必须落在学期日期范围内；"
        "连续多天的放假（如国庆假期）逐日展开；原本就休息的正常周末不要输出。"
    )

    text = ai_vision_text(
        vision["provider"], vision["api_key"], vision["model"], vision["base_url"],
        PARSE_SYSTEM, user_text, [(mime, raw)], timeout=120, thinking=thinking or None,
    )

    seen = {}
    for it in _extract_json_array(text):
        if not isinstance(it, dict):
            continue
        d = _parse_iso(it.get("date"))
        if not d or d < start or d > end or d.isoformat() in seen:
            continue
        if it.get("type") == "off":
            seen[d.isoformat()] = {"date": d.isoformat(), "type": "off"}
        elif it.get("type") == "follow":
            try:
                day = int(it.get("day"))
            except (TypeError, ValueError):
                continue
            if 0 <= day <= 6:
                seen[d.isoformat()] = {"date": d.isoformat(), "type": "follow", "day": day}

    out = [seen[k] for k in sorted(seen)][:MAX_RULES]
    if not out:
        raise HTTPException(status_code=422, detail="未能从图片中识别出调休安排，请确认图片内容后重试")
    return {"ok": True, "adjustments": out}
