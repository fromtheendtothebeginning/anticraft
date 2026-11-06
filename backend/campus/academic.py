# campus/academic.py — 学业情况（教务「学生学业情况查询」，正方 N105515）页面解析
#
# 新版正方把这一页渲染成服务端 HTML：学号 / 整体统计 / 培养方案节点与 showKc 占位都在
# 首页 HTML 里；点开节点时再 POST 明细接口（教学计划课程 / 非课程信息）拉 JSON 数组。
# 解析规则与 App 直连实现 packages/campus_core/lib/direct/academic.dart 保持一致，
# 协议移植自开源实现 zfn_api（openschoolcn/zfn_api）的 get_academia 系列。

import re

# 首页（相对 …/jwglxt 之后）；真实页面可能带 echarts=1，只影响前端图表。
ACADEMIC_INDEX_PATH = "/xsxy/xsxyqk_cxXsxyqkIndex.html?gnmkdm=N105515&layout=default"
# 教学计划课程明细：POST 表单 xfyqjd_id，返回 JSON 数组。
ACADEMIC_COURSES_PATH = "/xsxy/xsxyqk_cxJxzxjhxfyqKcxx.html?gnmkdm=N105515"
# 「非课程信息」节点（通识类 / 实践环节等，页面 JS 里 jdkcsx != '1'）。
ACADEMIC_NON_COURSE_PATH = "/xsxy/xsxyqk_cxJxzxjhxfyqFKcxx.html?gnmkdm=N105515"

_STATUS_TEXT = {
    "1": "在修", "2": "未过", "3": "未修", "4": "已修", "21": "已修",
    "5": "校内被替代", "6": "校内课程替代", "7": "校内课程替代节点",
    "8": "校外课程替换/认定", "9": "学分认定", "10": "学业预警不审核",
}

_ACADEMIC_FORM_IDS = (
    "xh_id", "cjlrxn", "cjlrxq", "bkcjlrxn", "bkcjlrxq",
    "xscjcxkz", "cjcxkzzt", "cjztkz", "cjzt",
)

_TEMPLATE_NODE_RE = re.compile(
    r"""<p\s+class=['"]title1['"][^>]*?\bid=['"]p([0-9A-Za-z]{4,40})['"][^>]*?"""
    r"""\byxxf=['"]([^'"]*)['"][^>]*?\byqzdxf=['"]([^'"]*)['"][^>]*?"""
    r"""\bsftg=['"]([^'"]*)['"][^>]*>\s*"?\s*\+\s*"([^"]*?)&nbsp;""",
    re.S,
)
_ALERT_BOX_RE = re.compile(
    r"""<div[^>]*\bid\s*=\s*["']alertBox["'][^>]*>([\s\S]*?)</div>""", re.I)
_ALERT_DANGER_RE = re.compile(
    r"""<div[^>]*class\s*=\s*["'][^"']*alert-danger[^"']*["'][^>]*>([\s\S]*?)</div>""",
    re.I,
)
_LOGIN_PAGE_RE = re.compile(r"<h5[^>]*>\s*用户登录\s*</h5>")
_SPAN_PLACEHOLDER_RE = re.compile(
    r"""<span[^>]*\bid\s*=\s*["']showKc([^"']*)["'][^>]*>""", re.I)
_TAG_RE = re.compile(r"<[^>]+>")
_SPACE_RE = re.compile(r"\s+")
_STAT_PUNCT_RE = re.compile(r"[：:，,。；;、]")
_EDGE_RE = re.compile(r"""^["“”「」『』：:，,、\s\[\]【】]+|["“”「」『』：:，,、\s\[\]【】]+$""")


def _num_of(s):
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    try:
        return int(t)
    except ValueError:
        try:
            return float(t)
        except ValueError:
            return None


def _last_num(text, pattern):
    out = None
    for m in re.finditer(pattern, text):
        v = _num_of(m.group(1))
        if v is not None:
            out = v
    return out


def _decode_entities(s):
    return (s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
            .replace("&gt;", ">").replace("&quot;", '"')
            .replace("&#39;", "'").replace("&apos;", "'"))


def _squash(s, keep_space=False):
    t = _SPACE_RE.sub(" " if keep_space else "", s)
    if not keep_space:
        t = _STAT_PUNCT_RE.sub("", t)
    return t.strip()


def _html_to_text(html):
    return _squash(_decode_entities(_TAG_RE.sub(" ", html)), keep_space=True)


def _clean_name(s):
    return _EDGE_RE.sub("", s).strip()


def _attr_before(html, pos, attr):
    """模板里 <p ...> 之前最近的某个属性值（父节点 / jdkcsx 挂在前面的 li/div 上）。"""
    prefix = html[max(0, pos - 2000):pos]
    matches = re.findall(r"%s\s*=\s*['\"]([^'\"]*)['\"]" % re.escape(attr), prefix)
    return matches[-1].strip() if matches else ""


def _parse_student_id(html):
    tag = re.search(r"""<input\b[^>]*\bid\s*=\s*["']xh_id["'][^>]*>""", html, re.I)
    if tag:
        v = re.search(r"""\bvalue\s*=\s*["']([^"']*)["']""", tag.group(0))
        if v and v.group(1).strip():
            return v.group(1).strip()
    rev = re.search(
        r"""<input\b[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bid\s*=\s*["']xh_id["']""",
        html, re.I)
    return rev.group(1).strip() if rev else ""


def _hidden_input_value(html, input_id):
    tag = re.search(
        r"""<input\b[^>]*\bid\s*=\s*["']%s["'][^>]*>""" % re.escape(input_id), html, re.I)
    if tag:
        v = re.search(r"""\bvalue\s*=\s*["']([^"']*)["']""", tag.group(0))
        if v is not None:
            return v.group(1)
    rev = re.search(
        r"""<input\b[^>]*\bvalue\s*=\s*["']([^"']*)["'][^>]*\bid\s*=\s*["']%s["']"""
        % re.escape(input_id), html, re.I)
    return rev.group(1) if rev else None


def _parse_form_params(html):
    out = {}
    for input_id in _ACADEMIC_FORM_IDS:
        v = _hidden_input_value(html, input_id)
        if v is not None:
            out[input_id] = v
    return out


def _parse_statistics(html):
    box = _ALERT_BOX_RE.search(html)
    box_html = box.group(1) if box else ""
    out = {"gpa": None, "planed": None, "unplaned": None}

    source = box_html or html
    flat = _squash(_html_to_text(source))

    gpa_match = re.search(r"平均学分绩点[^\d]{0,12}(\d+(?:\.\d+)?)", flat)
    gpa = _num_of(gpa_match.group(1)) if gpa_match else None
    if gpa is None and box_html:
        m = re.search(r"(\d{1,2}\.\d{1,3})", flat)
        gpa = _num_of(m.group(1)) if m else None
    if gpa is None:
        fonts = [_num_of(m.group(1)) for m in re.finditer(
            r"""<font[^>]*size\s*=\s*["']2px["'][^>]*>\s*([\d.]+)\s*</font>""", html, re.I)]
        fonts = [v for v in fonts if v is not None]
        gpa = fonts[2] if len(fonts) >= 3 else (fonts[0] if fonts else None)
    out["gpa"] = gpa

    m = re.search(
        r"计划(?:总)?课程(?:数)?(\d+)门通过(\d+)门未通过(\d+)门未修(?:读)?(\d+)门在(?:读|修)(\d+)门",
        flat)
    if m:
        out["planed"] = {
            "total": int(m.group(1)), "passed": int(m.group(2)), "failed": int(m.group(3)),
            "missed": int(m.group(4)), "in": int(m.group(5)),
        }
    else:
        loose = re.search(r"计划总课程数?(\d+)门", flat)
        passed = re.search(r"计划内?[^未]{0,8}通过(\d+)门", flat)
        failed = re.search(r"计划内?[^未]{0,8}未通过(\d+)门", flat)
        if loose or passed:
            out["planed"] = {
                "total": int(loose.group(1)) if loose else None,
                "passed": int(passed.group(1)) if passed else None,
                "failed": int(failed.group(1)) if failed else None,
                "missed": None, "in": None,
            }

    unplaned = (re.search(r"计划外[^计]{0,8}?通过(\d+)门未通过(\d+)门", flat)
                or re.search(r"计划外[^计]{0,8}?通过(\d+)门", flat))
    if unplaned:
        out["unplaned"] = {
            "passed": int(unplaned.group(1)),
            "failed": int(unplaned.group(2)) if unplaned.lastindex and unplaned.lastindex >= 2 else None,
        }
    return out


def _assign_levels(nodes):
    by_id = {str(n.get("id") or ""): n for n in nodes}
    for n in nodes:
        level = 0
        cur = str(n.get("parent") or "")
        guard = set()
        while cur and cur in by_id and cur not in guard:
            guard.add(cur)
            level += 1
            cur = str(by_id[cur].get("parent") or "")
            if level > 12:
                break
        n["level"] = level


def _parse_template_nodes(html):
    out, seen = [], set()
    for m in _TEMPLATE_NODE_RE.finditer(html):
        node_id = m.group(1).strip()
        if node_id in seen:
            continue
        seen.add(node_id)
        name = _clean_name(_decode_entities(m.group(5) or ""))
        if not name or len(name) > 40 or "学分" in name:
            continue
        required = _num_of(m.group(3))
        earned = _num_of(m.group(2))
        out.append({
            "name": name,
            "id": node_id,
            "required": required,
            "earned": earned,
            "missed": required - earned
            if required is not None and earned is not None and required >= earned else None,
            "passed": (m.group(4) or "").strip() == "1",
            "parent": _attr_before(html, m.start(), "fxfyqjd_id"),
            # 页面按该属性选明细接口：'1' = 教学计划课程；其它 = 非课程信息。
            "jdkcsx": _attr_before(html, m.start(), "jdkcsx"),
        })
    _assign_levels(out)
    return out


def _category_name(ctx):
    idx = ctx.rfind("要求学分")
    if idx <= 0:
        return ""
    prefix = ctx[:idx]

    name = ""
    for m in re.finditer(r">([^<>]{1,40})<", prefix):
        t = _html_to_text(m.group(1))
        if not t or "学分" in t or "门" in t:
            continue
        name = t
    if name and len(name) <= 24:
        return _clean_name(name)

    tokens = [t for t in re.split(r"\s+", _html_to_text(prefix)) if t]
    kept = []
    for t in reversed(tokens):
        if re.match(r"^[\d.：:％%]+$", t):
            break
        if "学分" in t or t.startswith("共") or t.startswith("在读"):
            break
        kept.insert(0, t)
        if len(kept) >= 4:
            break
    return _clean_name(" ".join(kept))


def _category_of(ctx, node_id):
    required = _last_num(ctx, r"要求学分\s*[:：]?\s*(\d+(?:\.\d+)?)")
    if required is None:
        return None
    earned = _last_num(ctx, r"(?:^|[^未])获得学分\s*[:：]?\s*(\d+(?:\.\d+)?)")
    missed = _last_num(ctx, r"未获得学分\s*[:：]?\s*(\d+(?:\.\d+)?)")
    name = _category_name(ctx)
    if not name or len(name) > 24:
        return None
    return {
        "name": name, "id": node_id, "required": required, "earned": earned,
        "missed": missed,
        # 静态方言拿不到 jdkcsx：按教学计划接口处理，空结果时再由调用方兜底。
        "jdkcsx": "",
    }


def _parse_static_categories(html):
    out, seen = [], set()
    prev_end = 0
    for m in _SPAN_PLACEHOLDER_RE.finditer(html):
        ctx = html[prev_end:m.start()]
        prev_end = m.end()
        node_id = (m.group(1) or "").strip()
        cat = _category_of(ctx, node_id)
        if cat is None:
            continue
        key = node_id or cat["name"]
        if key in seen:
            continue
        seen.add(key)
        out.append(cat)
    if out:
        return out

    # 没有 showKc 占位（页面改版 / 个别学校不展开课程）：退化成按「要求学分」切块。
    for m in re.finditer(r"要求学分\s*[:：]?", html):
        ctx = html[max(0, m.start() - 400):m.start() + 400]
        cat = _category_of(ctx, "")
        if cat is None:
            continue
        key = "%s|%s" % (cat["name"], cat["required"])
        if key in seen:
            continue
        seen.add(key)
        out.append(cat)
    return out


def _parse_categories(html):
    nodes = _parse_template_nodes(html)
    return nodes if nodes else _parse_static_categories(html)


def _looks_like_login_page(html):
    return ("login_slogin" in html or "login_getPublicKey" in html
            or bool(_LOGIN_PAGE_RE.search(html)))


def parse_academic_index(html):
    """解析学业情况首页 HTML；解析不出来时返回空字段，由调用方判断是否页面改版。"""
    result = {
        "login": False, "error": "", "sid": "", "params": {},
        "statistics": {}, "categories": [],
    }
    if _looks_like_login_page(html):
        result["login"] = True
        return result

    result["sid"] = _parse_student_id(html)
    danger = _ALERT_DANGER_RE.search(html)
    if danger and danger.group(1).strip():
        result["error"] = _html_to_text(danger.group(1))
    result["params"] = _parse_form_params(html)
    result["statistics"] = _parse_statistics(html)
    result["categories"] = _parse_categories(html)
    return result


def _status_text(code):
    return _STATUS_TEXT.get(code, "")


def prescribe_term(sid, year, term_code):
    """建议修读学年 → 「大二上」这类标签；算不出来返回空串。"""
    if len(sid) < 2 or len(year) < 4:
        return ""
    try:
        enter_year = int(sid[:2])
        plan_year = int(year[-2:])
    except ValueError:
        return ""
    diff = plan_year - enter_year
    if diff < 0 or diff > 3:
        return ""
    t = term_code.strip()
    if "一" in t:
        half = "上"
    elif "二" in t:
        half = "下"
    elif t == "1":
        half = "上"
    elif t == "2":
        half = "下"
    else:
        half = ""
    return ["大一", "大二", "大三", "大四"][diff] + half if half else ""


def _course_of(raw, sid):
    def first(keys):
        for k in keys:
            v = raw.get(k)
            if v is None:
                continue
            v = str(v).strip()
            if v:
                return v
        return ""

    year = first(("JYXDXNM", "jyxdxnm", "JYXDXNMC", "jyxdxnmc"))
    term_code = first(("JYXDXQMC", "jyxdxqmc"))
    status = first(("XDZT", "xdzt"))
    return {
        "name": first(("KCMC", "kcmc")),
        "code": first(("KCH", "kch")),
        "credit": first(("XF", "xf")),
        "score": first(("MAXCJ", "maxcj", "CJ", "cj")),
        "point": first(("JD", "jd")),
        "status": status,
        "statusText": _status_text(status),
        "nature": first(("KCXZMC", "kcxzmc")),
        "category": first(("KCLBMC", "kclbmc")),
        "year": year,
        "termCode": term_code,
        "term": prescribe_term(sid, year, term_code),
    }


def _items_of(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("items", "rows", "list", "data"):
            if isinstance(data.get(key), list):
                return data[key]
    return []


def parse_academic_courses(data, sid=""):
    """解析某个培养方案节点的明细 JSON（字段为大写缩写），归一成 App 使用的短字段。"""
    return [_course_of(raw, sid) for raw in _items_of(data) if isinstance(raw, dict)]
