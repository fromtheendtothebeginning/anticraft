# aisettings.py — 用户 AI 设置：提供商注册表 / API Key 加密存储 / 连通性测试
#
# 提供商注册表模仿 AI SDK（@ai-sdk/openai-compatible）与 opencode 的 provider 配置格式：
# 每个提供商 = { id, label, base_url(OpenAI 兼容), models[], docs, thinking, topk }
# 全部走 OpenAI 兼容 /chat/completions（Anthropic/Gemini 官方均提供兼容层）。

import os
import json
import base64
import hashlib
import hmac as _hmac
import secrets
import socket
import time
import ipaddress
import urllib.parse
import urllib.request
import urllib.error

from dotenv import load_dotenv

load_dotenv()

# ============================================
# 提供商注册表（与前端 src/utils/aiProviders.js 保持同步）
# api 字段：openai=OpenAI兼容 /chat/completions(Bearer)；anthropic=Anthropic /v1/messages(x-api-key)
# opencode-go 的模型分三种端点（chat/completions / messages / responses），用 model_api 按模型前缀路由
# ============================================

PROVIDERS = {
    "opencode-go": {
        "label": "OpenCode Go",
        "base_url": "https://opencode.ai/zen/go/v1",
        "api": "openai",
        "docs": "https://opencode.ai/docs/go/",
        "models": [
            "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp",
            "glm-5.3", "glm-5.2", "glm-5.1",
            "kimi-k3", "kimi-k2.7-code", "kimi-k2.6",
            "mimo-v2.5", "mimo-v2.5-pro",
            "qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus",
            "grok-4.5", "gpt-5.6-luna", "muse-spark-1.2-contributor",
            "minimax-m3", "minimax-m2.7",
            "hy3", "ox-alpha-free",
        ],
        # 模型前缀 → 走 Anthropic /messages 或 OpenAI /responses 端点
        "model_api": {
            "minimax-": "anthropic",
            "qwen3.8-max": "anthropic",
            "qwen3.7-": "anthropic",
            "qwen3.6-plus": "anthropic",
            "grok-": "responses",
            "gpt-5.6-luna": "responses",
            "muse-spark-": "responses",
        },
        "default_model": "deepseek-v4-flash",
        "thinking": True,
        "thinking_levels": [
            {"value": "off", "label": "Off"},
            {"value": "low", "label": "Low"},
            {"value": "high", "label": "High"},
            {"value": "max", "label": "Max"},
        ],
        # 模型级思考档位覆盖：按模型前缀路由到不同档位
        # anthropic 端点模型（minimax/qwen3.x）→ 仅开关；responses 端点模型（grok/gpt-luna）→ OpenAI 风格
        "model_thinking_levels": {
            "minimax-": [
                {"value": "off", "label": "Off"},
                {"value": "high", "label": "On"},
            ],
            "qwen3.8-max": [
                {"value": "off", "label": "Off"},
                {"value": "high", "label": "On"},
            ],
            "qwen3.7-": [
                {"value": "off", "label": "Off"},
                {"value": "high", "label": "On"},
            ],
            "qwen3.6-plus": [
                {"value": "off", "label": "Off"},
                {"value": "high", "label": "On"},
            ],
            "grok-": [
                {"value": "minimal", "label": "Minimal"},
                {"value": "low", "label": "Low"},
                {"value": "medium", "label": "Medium"},
                {"value": "high", "label": "High"},
            ],
            "gpt-5.6-luna": [
                {"value": "minimal", "label": "Minimal"},
                {"value": "low", "label": "Low"},
                {"value": "medium", "label": "Medium"},
                {"value": "high", "label": "High"},
            ],
            "muse-spark-": [
                {"value": "minimal", "label": "Minimal"},
                {"value": "low", "label": "Low"},
                {"value": "medium", "label": "Medium"},
                {"value": "high", "label": "High"},
            ],
        },
        "topk": False,
    },
    "deepseek": {
        "label": "DeepSeek",
        "base_url": "https://api.deepseek.com",
        "api": "openai",
        "docs": "https://platform.deepseek.com/api_keys",
        "models": ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"],
        "default_model": "deepseek-v4-flash",
        "thinking": True,
        # 文档：thinking enabled/disabled + reasoning_effort low/high/max（默认 high）
        "thinking_levels": [
            {"value": "off", "label": "Off"},
            {"value": "low", "label": "Low"},
            {"value": "high", "label": "High"},
            {"value": "max", "label": "Max"},
        ],
        "topk": False,
    },
    "kimi": {
        "label": "Kimi (月之暗面)",
        "base_url": "https://api.moonshot.cn/v1",
        "api": "openai",
        "docs": "https://platform.moonshot.cn/console/api-keys",
        "models": ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"],
        "default_model": "kimi-k3",
        "thinking": True,
        # 文档：K3 用 reasoning_effort low/high/max（默认 max）；K2.x 用 thinking enabled/disabled
        "thinking_levels": [
            {"value": "off", "label": "Off"},
            {"value": "low", "label": "Low"},
            {"value": "high", "label": "High"},
            {"value": "max", "label": "Max"},
        ],
        "topk": False,
    },
    "glm": {
        "label": "GLM (智谱)",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "api": "openai",
        "docs": "https://open.bigmodel.cn/usercenter/apikeys",
        "models": ["glm-5.3", "glm-5.2", "glm-5.1", "glm-4.7", "glm-4.7-flash", "glm-4.6", "glm-4.5-air"],
        "default_model": "glm-4.6",
        "thinking": True,
        # 文档：thinking {"type":"enabled"/"disabled"}（无档位）
        "thinking_levels": [
            {"value": "off", "label": "Off"},
            {"value": "high", "label": "On"},
        ],
        "topk": False,
    },
    "qwen": {
        "label": "Qwen (通义千问)",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "api": "openai",
        "docs": "https://bailian.console.aliyun.com/?apiKey=1",
        "models": ["qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen-max", "qwen-plus", "qwen-turbo"],
        "default_model": "qwen-max",
        "thinking": True,
        # 文档：enable_thinking true/false（qwen3 系列）
        "thinking_levels": [
            {"value": "off", "label": "Off"},
            {"value": "high", "label": "On"},
        ],
        "topk": False,
    },
    "claude": {
        "label": "Claude (Anthropic)",
        "base_url": "https://api.anthropic.com",
        "api": "anthropic",
        "docs": "https://console.anthropic.com/settings/keys",
        "models": ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"],
        "default_model": "claude-sonnet-5",
        "thinking": True,
        # 文档：thinking {"type":"adaptive"}(推荐) / {"type":"enabled","budget_tokens":N(>=1024)} / {"type":"disabled"}
        "thinking_levels": [
            {"value": "off", "label": "Off"},
            {"value": "high", "label": "On"},
        ],
        # Anthropic Messages API 不支持 temperature / top_k / top_p 等采样参数
        "sampling": False,
        "topk": False,
    },
    "gpt": {
        "label": "GPT (OpenAI)",
        "base_url": "https://api.openai.com/v1",
        "api": "openai",
        "docs": "https://platform.openai.com/api-keys",
        "models": ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
        "default_model": "gpt-5-mini",
        "thinking": True,
        # 文档：reasoning_effort none/minimal/low/medium/high/xhigh/max（gpt-5/o 系列；gpt-4.1 无思考档位）
        "thinking_levels": [
            {"value": "minimal", "label": "Minimal"},
            {"value": "low", "label": "Low"},
            {"value": "medium", "label": "Medium"},
            {"value": "high", "label": "High"},
        ],
        "topk": False,
    },
    "gemini": {
        "label": "Gemini (Google)",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "api": "openai",
        "docs": "https://aistudio.google.com/app/apikey",
        "models": ["gemini-3.7-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
        "default_model": "gemini-2.5-flash",
        "thinking": True,
        # OpenAI 兼容下用 reasoning_effort 近似控制思考（2.5 系列支持）
        "thinking_levels": [
            {"value": "off", "label": "Off"},
            {"value": "high", "label": "On"},
        ],
        "topk": False,
    },
    "mimo": {
        "label": "MiMo (小米)",
        "base_url": "https://api.xiaomimimo.com/v1",
        "api": "openai",
        "docs": "https://platform.mimo.ai",
        "models": ["mimo-v2.5", "mimo-v2.5-asr", "mimo-v2.5-pro", "mimo-v2.5-tts", "mimo-v2.5-tts-voiceclone", "mimo-v2.5-tts-voicedesign"],
        "default_model": "mimo-v2.5",
        "thinking": True,
        "thinking_levels": [
            {"value": "off", "label": "Off"},
            {"value": "high", "label": "On"},
        ],
        # 小米 ASR 不走 OpenAI /audio/transcriptions，而是 /chat/completions + input_audio 内容块
        "asr_mode": "chat_audio",
        "topk": False,
    },
    "custom": {
        "label": "自定义 (OpenAI 兼容)",
        "base_url": "",  # 使用 Key 的 custom_base_url（必填）
        "api": "openai",
        "docs": "",
        "models": [],
        "default_model": "",
        "thinking": True,
        "thinking_levels": [
            {"value": "off", "label": "Off"},
            {"value": "low", "label": "Low"},
            {"value": "high", "label": "High"},
            {"value": "max", "label": "Max"},
        ],
        "topk": False,
    },
}


def get_provider(pid: str):
    return PROVIDERS.get(pid)


def resolve_api(provider_id: str, model: str) -> str:
    """按 provider + 模型 决定请求 API 类型：openai / anthropic / responses"""
    p = get_provider(provider_id)
    if not p:
        return "openai"
    routes = p.get("model_api") or {}
    for prefix, api in routes.items():
        if model.startswith(prefix):
            return api
    return p.get("api", "openai")


def resolve_thinking_levels(provider_id: str, model: str = None):
    """按 provider + 模型 返回思考深度选项列表；无模型匹配时回退 provider 默认档位"""
    p = get_provider(provider_id)
    if not p:
        return [
            {"value": "off", "label": "Off"},
            {"value": "low", "label": "Low"},
            {"value": "medium", "label": "Medium"},
            {"value": "high", "label": "High"},
        ]
    if model:
        mapping = p.get("model_thinking_levels") or {}
        for prefix, levels in mapping.items():
            if model.startswith(prefix):
                return list(levels)
    return list(p.get("thinking_levels") or [
        {"value": "off", "label": "Off"},
        {"value": "low", "label": "Low"},
        {"value": "medium", "label": "Medium"},
        {"value": "high", "label": "High"},
    ])


# ============================================
# 思考参数适配（把统一档位 off/low/high/max 翻译成各家的请求字段）
# ============================================

# 思考档位 → Anthropic thinking budget_tokens
_ANTHROPIC_BUDGETS = {"low": 1024, "high": 8192, "max": 16384}


def apply_thinking(payload: dict, provider_id: str, level: str) -> dict:
    """按 provider 把思考深度写进请求体；返回修改后的 payload（调用方按返回值用）。

    level 为空/None → 原样返回，不加任何字段（跟随模型默认）。
    各家协议不同，未识别的 provider 一律不加参数（乱加会 400）：
      deepseek  : off→thinking{type:disabled}；low/high/max→reasoning_effort（无 medium 档）
      claude    : off→thinking{type:disabled}；其余→thinking{type:enabled,budget_tokens}
      kimi      : kimi-k3 用 reasoning_effort（off→none）；K2.x 用 thinking{enabled|disabled}
      qwen      : enable_thinking true/false
      gpt/gemini: reasoning_effort（off→none）
    """
    if not level:
        return payload
    pid = (provider_id or "").lower()
    model = str(payload.get("model") or "")

    if pid == "deepseek":
        if level == "off":
            payload["thinking"] = {"type": "disabled"}
        else:
            # deepseek 只接受 none/minimal/low/high/max，medium 归一到 high 避免 400
            payload["reasoning_effort"] = "high" if level == "medium" else level
    elif pid in ("claude", "anthropic"):
        if level == "off":
            payload["thinking"] = {"type": "disabled"}
        else:
            budget = _ANTHROPIC_BUDGETS.get(level, 8192)
            payload["thinking"] = {"type": "enabled", "budget_tokens": budget}
            # anthropic 要求 max_tokens > budget_tokens，否则直接 400；
            # 识图这类调用原来只给 512，必须相应抬高
            if isinstance(payload.get("max_tokens"), int) and payload["max_tokens"] <= budget:
                payload["max_tokens"] = budget + 512
    elif pid == "kimi":
        if model.startswith("kimi-k3"):
            payload["reasoning_effort"] = "none" if level == "off" else ("high" if level == "medium" else level)
        else:
            payload["thinking"] = {"type": "disabled" if level == "off" else "enabled"}
    elif pid in ("qwen", "dashscope"):
        payload["enable_thinking"] = level != "off"
    elif pid in ("gpt", "openai", "gemini", "google", "mimo"):
        # mimo 实测（api.xiaomimimo.com，2026-09-10）：reasoning_effort none/high 都生效
        # （none 时 reasoning_tokens=0）；thinking{"type":"disabled"} 虽被接受但会把结果弄错，不用它
        payload["reasoning_effort"] = "none" if level == "off" else level
    # 其它 provider（opencode-go / glm / mimo / custom 等）：思考字段格式不确定，不加参数
    return payload


# ============================================
# API Key 加密（纯标准库：HMAC-SHA256 密钥流 + nonce + HMAC 校验）
# 密钥从 SECRET_KEY 派生；拿到数据库泄露的密文没有 SECRET_KEY 无法还原。
# ============================================

_SECRET_KEY = os.getenv("SECRET_KEY")
if not _SECRET_KEY:
    raise RuntimeError("缺少 SECRET_KEY 环境变量，无法加密 API Key")
_ENC_KEY = hashlib.sha256(b"anticraft-ai-apikey-v1" + _SECRET_KEY.encode()).digest()


def encrypt_secret(plain: str) -> str:
    """明文 → base64(nonce + ciphertext + hmac_tag)"""
    data = plain.encode("utf-8")
    nonce = secrets.token_bytes(16)
    # 密钥流：HMAC(key, nonce || counter) 逐块拼接
    blocks = []
    for counter in range((len(data) // 32) + 1):
        blocks.append(_hmac.new(_ENC_KEY, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest())
    keystream = b"".join(blocks)[: len(data)]
    ct = bytes(a ^ b for a, b in zip(data, keystream))
    tag = _hmac.new(_ENC_KEY, nonce + ct, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(nonce + ct + tag).decode("ascii")


def decrypt_secret(blob: str):
    """密文 → 明文；校验失败/格式错误返回 None"""
    try:
        raw = base64.urlsafe_b64decode(blob.encode("ascii"))
        nonce, ct, tag = raw[:16], raw[16:-32], raw[-32:]
        expect = _hmac.new(_ENC_KEY, nonce + ct, hashlib.sha256).digest()
        if not _hmac.compare_digest(expect, tag):
            return None
        blocks = []
        for counter in range((len(ct) // 32) + 1):
            blocks.append(_hmac.new(_ENC_KEY, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest())
        keystream = b"".join(blocks)[: len(ct)]
        return bytes(a ^ b for a, b in zip(ct, keystream)).decode("utf-8")
    except Exception:
        return None


def mask_key(plain: str) -> str:
    """明文 Key → 脱敏展示（sk-ab…wxyz）"""
    if len(plain) <= 8:
        return "***"
    return f"{plain[:5]}***{plain[-4:]}"


# ============================================
# 连通性测试（按提供商/模型选择端点：openai / anthropic / responses）
# ============================================

# opencode.ai 的 Cloudflare 拦截默认 urllib 请求（无浏览器 UA 返回 403 error code:1010）
_BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"


def _build_headers(api: str, api_key: str):
    """按 API 类型构建认证头（统一带浏览器 UA 绕过 Cloudflare 1010 拦截）"""
    if api == "anthropic":
        return {
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "User-Agent": _BROWSER_UA,
        }
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": _BROWSER_UA,
    }


def _build_payload(api: str, model: str):
    """按 API 类型构建最小测试请求体"""
    if api == "anthropic":
        return {
            "model": model,
            "max_tokens": 8,
            "messages": [{"role": "user", "content": "ping"}],
        }
    if api == "responses":
        return {
            "model": model,
            "input": "ping",
            "max_output_tokens": 8,
        }
    return {
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 8,
        "stream": False,
    }


def _endpoint_url(api: str, base: str, provider_id: str):
    base = base.rstrip("/")
    if provider_id == "opencode-go":
        # base 已是 .../zen/go/v1：anthropic 走 /messages，responses 走 /responses
        if api == "anthropic":
            return base + "/messages"
        if api == "responses":
            return base + "/responses"
        return base + "/chat/completions"
    if api == "anthropic":
        return base + "/v1/messages"
    if api == "responses":
        return base + "/responses"
    return base + "/chat/completions"


# ============================================
# SSRF 防护：外发 URL 校验 + 逐跳安全重定向
# ============================================

class UnsafeURLError(Exception):
    """外发请求目标未通过公网校验（含 302 等重定向跳向内网）"""


def assert_public_http_url(url: str) -> str:
    """校验 URL 为公网 http(s)：域名先解析，逐一检查解析出的 IP，
    拦截内网/环回/链路本地/保留/组播地址。合法返回原 URL，非法抛 ValueError。
    （校验与发起请求之间存在 DNS 重解析窗口，理论上可被 DNS rebinding 利用，
    需要攻击者控制权威 DNS 并精确卡时序，风险可接受。）"""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("无效的资源地址")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except OSError:
        raise ValueError("无法解析目标主机")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped  # ::ffff:10.0.0.1 形态按映射后的 IPv4 判定
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise ValueError("不允许访问内网地址")
    return url


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """urlopen 默认跟随重定向且不复查目标：这里逐跳复检，堵「公网 URL 302 跳内网」"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            assert_public_http_url(newurl)
        except ValueError as e:
            raise UnsafeURLError(str(e))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_SafeRedirectHandler())


def safe_urlopen(req, timeout):
    """urlopen 的安全等价物：每一跳重定向都重新做公网地址校验"""
    return _opener.open(req, timeout=timeout)


def test_chat(provider_id: str, api_key: str, model: str, base_url: str = None, timeout: int = 20):
    """向提供商发一条极小请求验证 Key/模型可用。返回 (ok: bool, latency_ms, error: str|None)"""
    p = get_provider(provider_id)
    api = resolve_api(provider_id, model)
    url = _endpoint_url(api, base_url or (p["base_url"] if p else ""), provider_id)
    payload = json.dumps(_build_payload(api, model)).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers=_build_headers(api, api_key), method="POST")
    start = time.monotonic()
    try:
        with safe_urlopen(req, timeout=timeout) as resp:
            resp.read()
            return True, int((time.monotonic() - start) * 1000), None
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            detail = ""
        msg = {401: "API Key 无效或未授权", 403: "无权访问该模型", 404: "接口或模型不存在（检查 Base URL / 模型 ID）"}.get(e.code)
        return False, int((time.monotonic() - start) * 1000), msg or f"HTTP {e.code}: {detail}"
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        return False, int((time.monotonic() - start) * 1000), f"无法连接提供商：{reason}"
    except Exception as e:
        return False, int((time.monotonic() - start) * 1000), f"请求失败：{e}"


# ============================================
# 列出可用模型（OpenAI 兼容 GET /models；Anthropic 无该端点回退注册表）
# ============================================

def list_models(provider_id: str, api_key: str, base_url: str = None, timeout: int = 20):
    """用 API Key 调提供商 GET /models，返回可用模型 ID 列表。

    返回 (ok: bool, models: list[str], error: str|None)。
    Anthropic 无 OpenAI 兼容 /models；opencode-go 有独立 /models 端点；失败一律回退注册表内置列表。
    """
    p = get_provider(provider_id)
    base = (base_url or (p["base_url"] if p else "")).rstrip("/")

    # Anthropic 原生无 /models，直接返回注册表模型
    if resolve_api(provider_id, p["default_model"]) == "anthropic" and provider_id != "opencode-go":
        return True, list(p.get("models", [])), None

    # opencode-go：从独立 /models 端点拉取真实可用模型
    if provider_id == "opencode-go":
        url = base + "/models"
    else:
        url = base + "/models"
    req = urllib.request.Request(url, headers=_build_headers("openai", api_key))
    try:
        with safe_urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode())
        ids = [str(m.get("id")) for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]
        ids = [i for i in ids if i]
        # opencode-go：/models 返回含不支持的残留模型（如 mimo-v2-pro/mimo-v2-omni/hy3-preview），
        # 用注册表白名单过滤，只保留官方文档支持的模型，避免选了报 400 Unsupported
        if provider_id == "opencode-go" and p and p.get("models"):
            whitelist = set(p["models"])
            ids = [i for i in ids if i in whitelist]
        if not ids and p and p.get("models"):
            return True, list(p["models"]), None
        return True, ids, None
    except urllib.error.HTTPError as e:
        if p and p.get("models"):
            return True, list(p["models"]), None
        try:
            detail = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            detail = ""
        msg = {401: "API Key 无效或未授权", 403: "无权访问"}.get(e.code)
        return False, [], msg or f"HTTP {e.code}: {detail}"
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        if p and p.get("models"):
            return True, list(p["models"]), None
        return False, [], f"无法连接提供商：{reason}"
    except Exception as e:
        if p and p.get("models"):
            return True, list(p["models"]), None
        return False, [], f"请求失败：{e}"
