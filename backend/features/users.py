# features/users.py — 用户（资料/用户名检查/重置密码/注销）

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from auth import hash_password, verify_password
from database import get_db
from deps import _client_ip, get_current_user_obj
from models import InviteCode, User
from ratelimit import check_username_ip, reset_ip, reset_lock
from schemas import (
    DeleteAccountRequest, MessageResponse, ResetPasswordRequest,
    UpdateProfileRequest, UserResponse,
)

router = APIRouter()


@router.get("/api/user/me", response_model=UserResponse, tags=["用户"])
def get_current_user(current_user: User = Depends(get_current_user_obj)):
    """获取当前登录用户信息（需 Bearer Token）"""
    return UserResponse.model_validate(current_user)


@router.put("/api/user/profile", response_model=UserResponse, tags=["用户"])
def update_profile(
    req: UpdateProfileRequest,
    current_user: User = Depends(get_current_user_obj),
    db: Session = Depends(get_db),
):
    """更新当前用户昵称和头像"""
    if req.nickname is not None:
        current_user.nickname = req.nickname
    if req.avatar_url is not None:
        current_user.avatar_url = req.avatar_url

    db.commit()
    db.refresh(current_user)

    return UserResponse.model_validate(current_user)


@router.get("/api/user/check-username", tags=["用户"])
def check_username(username: str, request: Request, db: Session = Depends(get_db)):
    """检查用户名是否存在"""
    if not check_username_ip.allow(_client_ip(request)):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="请求过于频繁，请稍后再试",
        )
    user = db.query(User).filter(User.username == username).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")
    return {"exists": True, "username": user.username}


@router.put("/api/user/reset-password", response_model=MessageResponse, tags=["用户"])
def reset_password(req: ResetPasswordRequest, request: Request, db: Session = Depends(get_db)):
    """重置密码（无需登录，需本人专属可重复邀请码验证，防止接管他人账号）"""
    if not reset_ip.allow(_client_ip(request)):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="请求过于频繁，请稍后再试",
        )

    user = db.query(User).filter(User.username == req.username).first()
    if not user:
        # 与「邀请码无效」同文案同状态码，避免借本接口区分用户名是否存在
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="邀请码无效或不属于该账号",
        )

    if not reset_lock.check(user.username):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="尝试次数过多，请 15 分钟后再试",
        )

    # 校验邀请码归属：必须是该账号本人的专属可重复邀请码（不消耗）
    invite = db.query(InviteCode).filter(InviteCode.code == req.invite_code).first()
    if not invite or invite.owner_user_id != user.id or not invite.is_reusable:
        reset_lock.fail(user.username)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="邀请码无效或不属于该账号",
        )

    user.hashed_password = hash_password(req.new_password)
    user.token_version = (user.token_version or 0) + 1
    db.commit()
    reset_lock.clear(user.username)

    return MessageResponse(message="密码重置成功")


@router.post("/api/user/delete-account", response_model=MessageResponse, tags=["用户"])
def delete_own_account(
    req: DeleteAccountRequest,
    current_user: User = Depends(get_current_user_obj),
    db: Session = Depends(get_db),
):
    """注销当前账号（需账号与密码验证，博客/评论/点赞/邀请码由外键级联删除）"""
    if req.username != current_user.username or not verify_password(req.password, current_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="账号或密码错误",
        )

    db.delete(current_user)
    db.commit()
    return MessageResponse(message="账号已注销")
