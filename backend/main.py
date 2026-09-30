# main.py — FastAPI 应用入口（瘦启动器：应用初始化 + 中间件 + 路由自动发现）

import os
import time as _time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from database import init_db, run_migrations
from constants import DEFAULT_CORS_ORIGINS
from deps import _log

# ============================================
# 应用初始化
# ============================================

app = FastAPI(title="anticraft API", version="1.0.0")

# CORS —— 允许前端开发服务器跨域访问（生产走 nginx 同源代理，无需跨域）
_cors_origins = [
    o.strip() for o in os.getenv("CORS_ORIGINS", DEFAULT_CORS_ORIGINS).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================
# 运行日志（启动 banner + 请求中间件 + 关键事件），便于命令行观察后端状态
# ============================================

@app.middleware("http")
async def _log_requests(request: Request, call_next):
    start = _time.time()
    response = await call_next(request)
    dur = (_time.time() - start) * 1000
    path = request.url.path
    # 记录工具相关请求 + 所有 4xx/5xx 错误，避免刷屏
    if path.startswith("/api/tools") or response.status_code >= 400:
        _log(f"req {request.method} {path} -> {response.status_code} ({dur:.0f}ms)")
    return response


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    response = await call_next(request)
    # 禁止浏览器对响应做 MIME 嗅探（文件类接口一律按显式 Content-Type 处理）
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


@app.on_event("startup")
def on_startup():
    """首次启动自动建表 + 迁移新字段 + 定时任务"""
    import threading
    from datetime import datetime, timedelta, timezone

    # 服务器可能是 UTC，定时任务一律按北京时间（UTC+8）计算
    CN_TZ = timezone(timedelta(hours=8))

    _log("=" * 50)
    _log("anticraft API 启动")
    _log(f"端口 {os.getenv('PORT', '8000')} · HOST={os.getenv('HOST', '127.0.0.1')}")
    _log("=" * 50)
    init_db()
    run_migrations()
    _log("启动完成：数据库就绪，心跳已启动")

    # ── 电费自动采集定时任务（每晚 22:00 北京时间，直连不依赖 VPN） ──
    def _electricity_scheduler():
        while True:
            now = datetime.now(CN_TZ)
            target = now.replace(hour=22, minute=0, second=0, microsecond=0)
            if now >= target:
                target += timedelta(days=1)
            wait = (target - now).total_seconds()
            _log(f"[electricity-scheduler] 下次执行: {target.strftime('%Y-%m-%d %H:%M')} (等待 {wait/3600:.1f}h)")
            _time.sleep(wait)
            try:
                from features.electricity import auto_query_electricity
                _log("[electricity-scheduler] 开始执行自动电费查询")
                auto_query_electricity()
                _log("[electricity-scheduler] 自动电费查询完成")
            except Exception as e:
                _log(f"[electricity-scheduler] 执行失败: {str(e)[:200]}")

    threading.Thread(target=_electricity_scheduler, daemon=True, name="electricity-scheduler").start()


# ============================================
# API 路由
# ============================================

@app.get("/api/health", tags=["系统"])
def health_check():
    """健康检查"""
    return {"status": "ok", "message": "anticraft API is running"}


# ============================================
# 路由自动发现：backend/features/ 下暴露 router 变量的模块自动挂载
# ============================================

import importlib, pkgutil
import features as _features
for _m in sorted(pkgutil.iter_modules(_features.__path__), key=lambda m: m.name):
    _mod = importlib.import_module(f"features.{_m.name}")
    _router = getattr(_mod, "router", None)
    if _router is not None:
        app.include_router(_router)


# ============================================
# 启动入口
# ============================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=os.getenv("HOST", "127.0.0.1"),
                port=int(os.getenv("PORT", "8000")), reload=False)
