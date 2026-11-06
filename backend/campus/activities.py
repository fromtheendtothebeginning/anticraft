# campus/activities.py — 第二课堂活动（学工「活动报名」引导页）的结构化解析
# 解析规则移植自 Second_Class_Notification/watcher.py（名额提取 / 报名线索 / 校区 / 事后补录），
# 仅保留「查看看板」所需部分：不做提醒状态机、不做关键词过滤（展示层自行筛选）。

import re
from datetime import datetime

# 报名线索：学校没有在线报名，报名靠 QQ 群 / 电话 / 扫码，从说明里捞出来
QQ_RES = [
    re.compile(r"(?:QQ\s*群|qq群|群号|群\s*号)\D{0,8}(\d{5,12})", re.I),
    re.compile(r"(\d{6,12})\s*(?:的)?\s*(?:QQ|qq)\s*群", re.I),
    re.compile(r"(?:加|进|入)\s*群[^0-9\r\n]{0,6}(\d{6,12})"),
]
PHONE_RE = re.compile(r"(?<!\d)(1[3-9]\d{9})(?!\d)")
# 联系方式的判定要具体，别用光秃秃的「群」「联系」——「社群创始人」「青年群体」
# 这类正常叙述会被误判成报名线索。
CONTACT_RE = re.compile(
    r"(QQ\s*群|qq群|群\s*号|加\s*群|进\s*群|扫码|二维码|钉钉|微信群|"
    r"联\s*系\s*人|联系\s*电话|咨询\s*电话|报名\s*方式|报名\s*链\s*接|报名\s*请|"
    r"申请\s*加入|入\s*群)", re.I)
CONTACT_EXCLUDE = re.compile(r"群体|社群|人群|群众|成群|超群")


def extract_signup(text):
    """从活动说明里提取报名方式（QQ 群号、手机号、相关提示行）。"""
    t = str(text or "")
    if not t:
        return {}
    qq = set()
    for r in QQ_RES:
        qq |= set(r.findall(t))
    phone = sorted(set(PHONE_RE.findall(t)))
    # 手机号别同时当成 QQ 号
    qq = sorted({q for q in qq if 5 <= len(q) <= 12 and q not in phone})
    tips = [k for k in ("扫码", "二维码", "扫码进群", "报名成功", "请勿申请", "无需报名")
            if k in t]
    lines = [l.strip() for l in re.split(r"[\r\n]+", t) if l.strip()]
    contact = [l for l in lines
               if CONTACT_RE.search(l) and not CONTACT_EXCLUDE.search(l)]
    out = {}
    if qq:
        out["qq"] = qq
    if phone:
        out["phone"] = phone
    if tips:
        out["tips"] = tips
    if contact:
        out["contact_lines"] = contact[:3]
    return out


# 从活动说明里捞「名额」的字样，例如「人数30人」「名额：30」
QUOTA_RES = [
    re.compile(r"人数\s*[:：]?\s*(\d{1,4})\s*人"),
    re.compile(r"名额\s*[:：]?\s*(\d{1,4})\s*人?"),
    re.compile(r"(?:限|招收|招募|录取|报名人数)\s*[:：]?\s*(\d{1,4})\s*人"),
]
# 说明里写「人数不限」就不算名额
UNLIMITED_RE = re.compile(r"(?:人数|名额)\s*不限")


def extract_quota(text):
    """从说明里猜名额，返回如 '30 人'；找不到返回 None。"""
    if not text or UNLIMITED_RE.search(text):
        return None
    for rx in QUOTA_RES:
        m = rx.search(text)
        if m:
            return f"{int(m.group(1))} 人"
    return None


def enrolled_of(activity):
    """报名人数：上游字段 bdrs（旧版抓包里存在但多为空）；兼容同义字段。"""
    for k in ("bdrs", "bmrs", "ybmrs", "bmsl"):
        v = activity.get(k)
        if v is None or v == "":
            continue
        try:
            return int(str(v).strip())
        except (TypeError, ValueError):
            continue
    return None


def status_text_of(activity):
    """报名状态原文（部分活动写「名额已满 / 条件不符」）；纯数字状态码不参与判断。"""
    for k in ("bmztmc", "bmzt", "hdztmc", "ztmc"):
        v = str(activity.get(k) or "").strip()
        if v and re.search(r"[\u4e00-\u9fa5]", v):
            return v
    return ""


def parse_dt(text):
    if not text:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(str(text).strip(), fmt)
        except ValueError:
            continue
    return None


def is_backfill(activity):
    """活动开始时间早于报名开始时间 → 活动早办完了，这个"报名"是事后补录登记。"""
    ev = parse_dt(activity.get("hdkssj") or activity.get("_hdkssj"))
    bm = parse_dt(activity.get("hdbmkssj") or activity.get("_hdbmkssj"))
    return bool(ev and bm and ev < bm)


def campus_of(activity):
    """依据名称/说明里的「奉贤 / 徐汇」字样判断校区，未标注返回「未标注」。"""
    b = str(activity.get("hdmc") or "") + " " + str(activity.get("_hdms") or activity.get("hdms") or "")
    xx, fx = "徐汇" in b, "奉贤" in b
    if xx and fx:
        return "奉贤+徐汇"
    if xx:
        return "徐汇"
    if fx:
        return "奉贤"
    return "未标注"


def snapshot(a):
    """整理单条活动为给前端看板用的视图。报名状态(即将/报名中/已结束)由前端按本机时间推导。"""
    hdms = a.get("_hdms") or a.get("hdms") or ""
    return {
        "id": a.get("id"),
        "name": a.get("hdmc") or "",
        "dlmc": a.get("dlmc") or a.get("_dlmc") or "",
        "lbmc": a.get("lbmc") or a.get("_lbmc") or "",
        "host": a.get("zbfmc") or "",
        "bm_start": a.get("hdbmkssj"),
        "bm_end": a.get("hdbmjzsj"),
        "start": a.get("hdkssj"),
        "end": a.get("hdjssj"),
        "campus": campus_of(a),
        "backfill": is_backfill(a),
        "quota": extract_quota(hdms),
        # 报名人数 / 学校给的报名状态原文：客户端据此把报名按钮显示成「已人满 / 条件不符」
        "enrolled": enrolled_of(a),
        "status_code": str(a.get("hdbmzt") or ""),
        "status_text": status_text_of(a),
        "signup": extract_signup(hdms),
        "hdms": (hdms or "")[:2000],
    }


def snapshot_all(activities):
    return [snapshot(a) for a in activities or []]


def activities_payload(client):
    """用已登录的 DektClient 拉取活动列表并整理，作为各接口共用的 data 载荷。"""
    acts = snapshot_all(client.fetch_activities())
    return {"activities": acts, "student_id": client.student_id}
