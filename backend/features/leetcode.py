# features/leetcode.py — LeetCode 刷题量 & 公开榜单 & 心跳同步

import json
import re
import threading
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from database import get_db
from constants import LEETCODE_GRAPHQL
from deps import _log, get_current_user_obj, require_admin
from models import LeetcodeBinding, User
from ratelimit import SlidingWindow
from schemas import (
    LeetcodeBoardResponse, LeetcodeDebugSetRequest, LeetcodeMeResponse,
    LeetcodeRefreshResponse, MessageResponse, UpdateLeetcodeDebugRequest,
    UpdateLeetcodeModeRequest, UpdateLeetcodeRequest,
)

router = APIRouter()

LEETCODE_QUERY = (
    "query userQuestionProgress($userSlug: String!) {"
    " userProfileUserQuestionProgress(userSlug: $userSlug) {"
    "  numAcceptedQuestions { difficulty count }"
    " } }"
)


def fetch_leetcode_progress(username: str):
    """调用 LeetCode 公开 GraphQL 拉取用户各难度已解题数。
    返回 (easy, medium, hard) 或 None（用户不存在）；网络/解析失败抛异常。"""
    body = json.dumps({
        "query": LEETCODE_QUERY,
        "variables": {"userSlug": username},
    }).encode()
    req = urllib.request.Request(
        LEETCODE_GRAPHQL, data=body,
        headers={
            "Content-Type": "application/json",
            "Referer": "https://leetcode.cn/u/" + urllib.parse.quote(username, safe=""),
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) anticraft-leetcode-sync",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())
    inner = data.get("data") or {}
    nums = inner.get("userProfileUserQuestionProgress")
    if not nums or not nums.get("numAcceptedQuestions"):
        # 用户不存在（接口返回空数组 / null）
        return None
    counts = {"EASY": 0, "MEDIUM": 0, "HARD": 0}
    for item in nums["numAcceptedQuestions"]:
        counts[item.get("difficulty", "")] = int(item.get("count") or 0)
    return counts["EASY"], counts["MEDIUM"], counts["HARD"]


def leetcode_inc(binding) -> tuple:
    """8.13 起（绑定日）的刷题增量：当前题数 - 基线，各维度不为负"""
    return (
        max(0, binding.cur_easy - binding.base_easy),
        max(0, binding.cur_medium - binding.base_medium),
        max(0, binding.cur_hard - binding.base_hard),
    )


def leetcode_score(e: int, m: int, h: int, difficulty_mode: bool, serious_mode: bool = False, boost_mode: bool = False) -> float:
    """激励模式：初始 -100 分，简单 3 / 中等 6 / 困难 9；
    否则：简单 2 / 中等 4 / 困难 8，严肃模式简单不计分，困难模式减半"""
    if boost_mode:
        return -100.0 + e * 3 + m * 6 + h * 9
    e_score = 0 if serious_mode else e * 2
    score = e_score + m * 4 + h * 8
    return score / 2 if difficulty_mode else float(score)


def _leetcode_me_payload(binding) -> dict:
    e, m, h = leetcode_inc(binding)
    return {
        "bound": True,
        "leetcode_username": binding.leetcode_username,
        "difficulty_mode": bool(binding.difficulty_mode),
        "serious_mode": bool(binding.serious_mode),
        "boost_mode": bool(binding.boost_mode),
        "debug_mode": bool(binding.debug_mode),
        "base": {"easy": binding.base_easy, "medium": binding.base_medium, "hard": binding.base_hard},
        "cur": {"easy": binding.cur_easy, "medium": binding.cur_medium, "hard": binding.cur_hard},
        "inc": {"easy": e, "medium": m, "hard": h},
        "total_inc": e + m + h,
        "score": leetcode_score(e, m, h, bool(binding.difficulty_mode), bool(binding.serious_mode), bool(binding.boost_mode)),
        "updated_at": binding.updated_at,
        "leetcode_ok": True,
    }


@router.get("/api/leetcode/me", response_model=LeetcodeMeResponse, tags=["LeetCode"])
def leetcode_me(quick: bool = False, current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """获取当前用户的 LeetCode 绑定与刷题增量（实时同步；quick=true 只读库不实时抓取，毫秒级返回）"""
    user_id = current_user.id
    binding = db.query(LeetcodeBinding).filter(LeetcodeBinding.user_id == user_id).first()
    if not binding:
        return LeetcodeMeResponse(bound=False)
    if not binding.debug_mode and not quick:
        try:
            prog = fetch_leetcode_progress(binding.leetcode_username)
            if prog is not None:
                binding.cur_easy, binding.cur_medium, binding.cur_hard = prog
                db.commit()
        except Exception:
            pass
    return LeetcodeMeResponse(**_leetcode_me_payload(binding))


@router.put("/api/leetcode/me", response_model=LeetcodeMeResponse, tags=["LeetCode"])
def leetcode_bind(
    req: UpdateLeetcodeRequest,
    current_user: User = Depends(get_current_user_obj),
    db: Session = Depends(get_db),
):
    """绑定/改绑 LeetCode 账号（绑定时刻为 8.13 起算基线）"""
    user_id = current_user.id
    username = req.leetcode_username.strip()
    if not username:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="用户名不能为空")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", username):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="用户名无效，仅支持字母、数字、下划线等字符")
    try:
        prog = fetch_leetcode_progress(username)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="无法连接 LeetCode，请稍后重试")
    if prog is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="LeetCode 用户不存在")
    existing = db.query(LeetcodeBinding).filter(
        LeetcodeBinding.leetcode_username == username,
        LeetcodeBinding.user_id != user_id,
    ).first()
    if existing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="该 LeetCode 账号已被其他用户绑定")
    binding = db.query(LeetcodeBinding).filter(LeetcodeBinding.user_id == user_id).first()
    if binding:
        binding.leetcode_username = username
    else:
        binding = LeetcodeBinding(user_id=user_id, leetcode_username=username)
        db.add(binding)
    binding.base_easy, binding.base_medium, binding.base_hard = prog
    binding.cur_easy, binding.cur_medium, binding.cur_hard = prog
    db.commit()
    db.refresh(binding)
    return LeetcodeMeResponse(**_leetcode_me_payload(binding))


@router.delete("/api/leetcode/me", response_model=MessageResponse, tags=["LeetCode"])
def leetcode_unbind(current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """解绑 LeetCode 账号"""
    user_id = current_user.id
    binding = db.query(LeetcodeBinding).filter(LeetcodeBinding.user_id == user_id).first()
    if binding:
        db.delete(binding)
        db.commit()
    return MessageResponse(message="已解绑")


def _enter_boost(binding) -> None:
    """进入激励模式：备份当前基线并清零刷题量（退出时恢复），并关闭困难/严肃（互斥）"""
    if binding.backup_base_easy is None:
        binding.backup_base_easy = binding.base_easy
        binding.backup_base_medium = binding.base_medium
        binding.backup_base_hard = binding.base_hard
    binding.base_easy = binding.cur_easy
    binding.base_medium = binding.cur_medium
    binding.base_hard = binding.cur_hard
    binding.boost_mode = True
    binding.difficulty_mode = False
    binding.serious_mode = False


def _exit_boost(binding) -> None:
    """退出激励模式：恢复备份的基线（若此前已进入）"""
    if not binding.boost_mode:
        return
    if binding.backup_base_easy is not None:
        binding.base_easy = binding.backup_base_easy
        binding.base_medium = binding.backup_base_medium
        binding.base_hard = binding.backup_base_hard
        binding.backup_base_easy = None
        binding.backup_base_medium = None
        binding.backup_base_hard = None
    binding.boost_mode = False


@router.put("/api/leetcode/me/mode", response_model=LeetcodeMeResponse, tags=["LeetCode"])
def leetcode_mode(
    req: UpdateLeetcodeModeRequest,
    current_user: User = Depends(get_current_user_obj),
    db: Session = Depends(get_db),
):
    """切换模式（激励与困难/严肃互斥；进入激励备份并清零刷题量，退出恢复）"""
    user_id = current_user.id
    binding = db.query(LeetcodeBinding).filter(LeetcodeBinding.user_id == user_id).first()
    if not binding:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="尚未绑定 LeetCode 账号")
    # 三模式互斥：激励与困难/严肃不可共存
    if req.boost_mode is True:
        _enter_boost(binding)
    if req.difficulty_mode is True:
        _exit_boost(binding)
        binding.difficulty_mode = True
    if req.serious_mode is True:
        _exit_boost(binding)
        binding.serious_mode = True
    if req.boost_mode is False:
        _exit_boost(binding)
    if req.difficulty_mode is False:
        binding.difficulty_mode = False
    if req.serious_mode is False:
        binding.serious_mode = False
    db.commit()
    db.refresh(binding)
    return LeetcodeMeResponse(**_leetcode_me_payload(binding))


@router.put("/api/leetcode/me/debug", response_model=LeetcodeMeResponse, tags=["LeetCode"])
def leetcode_debug_toggle(
    req: UpdateLeetcodeDebugRequest,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """管理员调试模式：开启时不再读取 LeetCode，备份当前数据并手动调整；关闭时恢复备份数据"""
    binding = db.query(LeetcodeBinding).filter(LeetcodeBinding.user_id == _admin.id).first()
    if not binding:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="尚未绑定 LeetCode 账号")
    if req.debug_mode and not binding.debug_mode:
        # 开启：备份当前 base/cur
        binding.debug_backup_base_easy = binding.base_easy
        binding.debug_backup_base_medium = binding.base_medium
        binding.debug_backup_base_hard = binding.base_hard
        binding.debug_backup_cur_easy = binding.cur_easy
        binding.debug_backup_cur_medium = binding.cur_medium
        binding.debug_backup_cur_hard = binding.cur_hard
        binding.debug_mode = True
    elif not req.debug_mode and binding.debug_mode:
        # 关闭：保留调试期间手动设置的增量（同步真实值后固化到 base），不再覆盖丢弃
        try:
            real = fetch_leetcode_progress(binding.leetcode_username)
        except Exception:
            real = None
        if real is not None:
            # 增量以「当前 base」为参照，保证关闭前后榜单增量一致
            inc_e = max(0, binding.cur_easy - binding.base_easy)
            inc_m = max(0, binding.cur_medium - binding.base_medium)
            inc_h = max(0, binding.cur_hard - binding.base_hard)
            binding.cur_easy, binding.cur_medium, binding.cur_hard = real
            binding.base_easy = max(0, real[0] - inc_e)
            binding.base_medium = max(0, real[1] - inc_m)
            binding.base_hard = max(0, real[2] - inc_h)
        # 同步失败：保留当前 cur/base 数据
        binding.debug_backup_base_easy = None
        binding.debug_backup_base_medium = None
        binding.debug_backup_base_hard = None
        binding.debug_backup_cur_easy = None
        binding.debug_backup_cur_medium = None
        binding.debug_backup_cur_hard = None
        binding.debug_mode = False
    db.commit()
    db.refresh(binding)
    return LeetcodeMeResponse(**_leetcode_me_payload(binding))


@router.put("/api/leetcode/me/debug/set", response_model=LeetcodeMeResponse, tags=["LeetCode"])
def leetcode_debug_set(
    req: LeetcodeDebugSetRequest,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """调试模式下手动设置刷题量（增量 = 输入值，基于当前基线）"""
    binding = db.query(LeetcodeBinding).filter(LeetcodeBinding.user_id == _admin.id).first()
    if not binding:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="尚未绑定 LeetCode 账号")
    if not binding.debug_mode:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="调试模式未开启")
    # 基线取「当前 base」而非调试开启时的备份：调试期间若进入过激励模式（会把 base 拉到 cur）
    # 或改绑过账号，备份基线已过期，用它会把手动增量吞掉（输入 N 却看不到 N）
    base_e = binding.base_easy
    base_m = binding.base_medium
    base_h = binding.base_hard
    binding.cur_easy = base_e + max(0, req.easy)
    binding.cur_medium = base_m + max(0, req.medium)
    binding.cur_hard = base_h + max(0, req.hard)
    db.commit()
    db.refresh(binding)
    return LeetcodeMeResponse(**_leetcode_me_payload(binding))


@router.get("/api/leetcode/leaderboard", response_model=LeetcodeBoardResponse, tags=["LeetCode"])
def leetcode_leaderboard(db: Session = Depends(get_db)):
    """公开榜单：从 8.13 起的刷题增量，按得分排序（缓存数据，不实时同步）"""
    rows = (
        db.query(LeetcodeBinding)
        .options(joinedload(LeetcodeBinding.user))
        .order_by(LeetcodeBinding.created_at.asc())
        .all()
    )
    users = []
    for b in rows:
        e, m, h = leetcode_inc(b)
        users.append({
            "user_id": b.user_id,
            "nickname": b.user.nickname if b.user else None,
            "username": b.user.username if b.user else "已注销",
            "avatar_url": b.user.avatar_url if b.user else None,
            "leetcode_username": b.leetcode_username,
            "difficulty_mode": bool(b.difficulty_mode),
            "serious_mode": bool(b.serious_mode),
            "boost_mode": bool(b.boost_mode),
            "debug_mode": bool(b.debug_mode),
            "easy": e,
            "medium": m,
            "hard": h,
            "total": e + m + h,
            "score": leetcode_score(e, m, h, bool(b.difficulty_mode), bool(b.serious_mode), bool(b.boost_mode)),
            "updated_at": b.updated_at,
        })
    users.sort(key=lambda u: (-u["score"], -u["total"], u["user_id"]))
    return LeetcodeBoardResponse(users=users, generated_at=datetime.now(timezone.utc))


def _sync_leetcode_one(bid: int, username: str) -> bool:
    """同步单个绑定（独立 Session，供并发刷新使用）"""
    from database import SessionLocal
    db = SessionLocal()
    try:
        binding = db.query(LeetcodeBinding).filter(LeetcodeBinding.id == bid).first()
        if not binding or binding.debug_mode:
            return False
        prog = fetch_leetcode_progress(username)
        if prog is None:
            return False
        binding.cur_easy, binding.cur_medium, binding.cur_hard = prog
        db.commit()
        return True
    except Exception:
        db.rollback()
        return False
    finally:
        db.close()


# 全站手动刷新全局限流：心跳线程每分钟已同步全站，手动刷新只为即时性；
# 不加限制会被反复触发放大成对 leetcode.cn 的持续并发请求（有封服务器出口 IP 风险）
refresh_all = SlidingWindow(1, 120)


@router.post("/api/leetcode/refresh", response_model=LeetcodeRefreshResponse, tags=["LeetCode"])
def leetcode_refresh(current_user: User = Depends(get_current_user_obj), db: Session = Depends(get_db)):
    """同步所有绑定用户的 LeetCode 数据（需登录，并发重新请求，失败者保留旧值）"""
    if not refresh_all.allow("global"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="全站刷新过于频繁，请 2 分钟后再试")
    bindings = db.query(LeetcodeBinding).all()
    if not bindings:
        return LeetcodeRefreshResponse(synced=0, total=0)
    tasks = [(b.id, b.leetcode_username) for b in bindings]
    synced = 0
    with ThreadPoolExecutor(max_workers=5) as pool:
        results = pool.map(lambda t: _sync_leetcode_one(*t), tasks)
        synced = sum(1 for ok in results if ok)
    return LeetcodeRefreshResponse(synced=synced, total=len(bindings))


# ============================================
# LeetCode 心跳同步（后台线程，每分钟刷新所有绑定用户数据）
# ============================================

_heartbeat_lock = threading.Lock()
_heartbeat_last = None  # 最近一次心跳完成时间（ISO）
_heartbeat_last_count = 0  # 最近一次成功同步数
_heartbeat_stop = threading.Event()


def _sync_all_heartbeat():
    """同步所有非调试绑定用户（独立会话，失败跳过）"""
    from database import SessionLocal
    db = SessionLocal()
    try:
        bindings = db.query(LeetcodeBinding).filter(LeetcodeBinding.debug_mode.is_(False)).all()
        tasks = [(b.id, b.leetcode_username) for b in bindings]
    finally:
        db.close()
    if not tasks:
        return 0
    synced = 0
    with ThreadPoolExecutor(max_workers=5) as pool:
        results = pool.map(lambda t: _sync_leetcode_one(*t), tasks)
        synced = sum(1 for ok in results if ok)
    return synced


def _heartbeat_loop():
    """后台循环：启动后立即同步一次，之后每分钟一次；防止上一次未完成时重叠"""
    global _heartbeat_last, _heartbeat_last_count
    while not _heartbeat_stop.wait(60):
        if not _heartbeat_lock.acquire(blocking=False):
            continue  # 上一次同步仍在进行，跳过本次
        try:
            _heartbeat_last_count = _sync_all_heartbeat()
            _heartbeat_last = datetime.now(timezone.utc).isoformat()
            _log(f"heartbeat sync done: {_heartbeat_last_count} users")
        except Exception:
            _heartbeat_last_count = 0
        finally:
            _heartbeat_lock.release()


def _start_heartbeat():
    t = threading.Thread(target=_heartbeat_loop, daemon=True, name="leetcode-heartbeat")
    t.start()


@router.on_event("startup")
def _on_startup_start_heartbeat():
    """原 main.py startup 中调用 _start_heartbeat() 的行为随域搬入本模块"""
    _start_heartbeat()


@router.get("/api/leetcode/heartbeat", tags=["LeetCode"])
def leetcode_heartbeat_status(_admin: User = Depends(require_admin)):
    """心跳状态（最近同步时间与成功数，仅管理员）"""
    return {
        "enabled": True,
        "interval": 60,
        "last_run": _heartbeat_last,
        "last_synced": _heartbeat_last_count,
    }
