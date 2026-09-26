# models.py — SQLAlchemy 数据模型

from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean, ForeignKey, UniqueConstraint, JSON, Float
from sqlalchemy.orm import relationship, backref
from sqlalchemy.sql import func
from database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    username = Column(String(50), unique=True, nullable=False, index=True, comment="用户名")
    hashed_password = Column(String(255), nullable=False, comment="加密后的密码")
    nickname = Column(String(50), nullable=True, comment="昵称")
    avatar_url = Column(String(500), nullable=True, comment="头像 URL")
    is_active = Column(Boolean, default=True, comment="是否激活")
    # 角色：user 普通用户 / admin 管理员（不对外公开，仅后台管理）
    role = Column(String(20), nullable=False, default="user", server_default="user", comment="角色：user/admin")
    token_version = Column(Integer, nullable=False, default=0, server_default="0", comment="令牌版本号：改密/重置时+1，用于吊销旧 JWT")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="注册时间")
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间"
    )

    def __repr__(self):
        return f"<User(id={self.id}, username='{self.username}')>"


class Blog(Base):
    __tablename__ = "blogs"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    title = Column(String(200), nullable=False, comment="文章标题")
    category = Column(String(50), nullable=True, comment="分类：技术讨论 / 更新日志 / 娱乐论坛")
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True)
    is_featured = Column(Boolean, default=False, nullable=False, server_default="0", comment="是否精选")
    content_md = Column(Text, nullable=False, comment="Markdown 内容")
    author_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="发布时间")
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间"
    )

    author = relationship("User", backref=backref("blogs", passive_deletes=True))
    project = relationship("Project", back_populates="blogs")
    likes = relationship("BlogLike", backref="blog", cascade="all, delete-orphan")
    comments = relationship("Comment", backref="blog", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<Blog(id={self.id}, title='{self.title}')>"


class Project(Base):
    """项目 —— 用于聚合多篇博客"""

    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(200), nullable=False, comment="项目名")
    description = Column(Text, nullable=True, comment="项目简介")
    cover_url = Column(String(500), nullable=True, comment="封面图床 URL")
    tags = Column(Text, nullable=True, comment="标签，逗号分隔")
    bg_color = Column(String(9), nullable=True, comment="自定义封面背景色，如 #6c5ce7")
    link_url = Column(String(500), nullable=True, comment="项目链接（GitHub/下载，可自定义）")
    links = Column(JSON, nullable=True, comment="多个项目链接 [{name,url}]")
    author_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="创建时间")
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间"
    )

    author = relationship("User", backref=backref("projects", passive_deletes=True))
    blogs = relationship("Blog", back_populates="project")

    def __repr__(self):
        return f"<Project(id={self.id}, name='{self.name}')>"


class BlogLike(Base):
    """博客点赞记录 —— 同一用户对同一篇博客只能点赞一次"""
    __tablename__ = "blog_likes"
    __table_args__ = (UniqueConstraint("blog_id", "user_id", name="uq_blog_user_like"),)

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    blog_id = Column(Integer, ForeignKey("blogs.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="点赞时间")


class ProjectLike(Base):
    """项目点赞记录 —— 同一用户对同一项目只能点赞一次"""
    __tablename__ = "project_likes"
    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_project_user_like"),)

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="点赞时间")

    user = relationship("User")


class ProjectFollow(Base):
    """项目关注记录 —— 同一用户对同一项目只能关注一次"""
    __tablename__ = "project_follows"
    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_project_user_follow"),)

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="关注时间")

    user = relationship("User")

    def __repr__(self):
        return f"<ProjectFollow(id={self.id}, project_id={self.project_id}, user_id={self.user_id})>"


class Comment(Base):
    """博客评论"""
    __tablename__ = "comments"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    blog_id = Column(Integer, ForeignKey("blogs.id", ondelete="CASCADE"), nullable=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True, comment="所属项目 ID（项目评论时非空，与 blog_id 二选一）")
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    parent_id = Column(Integer, ForeignKey("comments.id", ondelete="CASCADE"), nullable=True, index=True, comment="父评论 ID（回复时非空）")
    content = Column(Text, nullable=False, comment="评论内容")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="评论时间")
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间"
    )

    user = relationship("User")
    parent = relationship("Comment", remote_side="Comment.id", backref="replies")

    def __repr__(self):
        return f"<Comment(id={self.id}, blog_id={self.blog_id})>"


class CommentLike(Base):
    """评论点赞记录 —— 同一用户对同一评论只能点赞一次"""
    __tablename__ = "comment_likes"
    __table_args__ = (UniqueConstraint("comment_id", "user_id", name="uq_comment_user_like"),)

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    comment_id = Column(Integer, ForeignKey("comments.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="点赞时间")

    user = relationship("User")


class Notification(Base):
    """站内通知 —— 评论回复 / 评论点赞"""
    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True, comment="接收者 ID")
    type = Column(String(30), nullable=False, comment="类型：comment_reply / comment_like / blog_comment_like")
    actor_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, comment="触发者 ID")
    blog_id = Column(Integer, ForeignKey("blogs.id", ondelete="CASCADE"), nullable=True, comment="相关博客 ID")
    comment_id = Column(Integer, ForeignKey("comments.id", ondelete="CASCADE"), nullable=True, comment="相关评论 ID")
    content = Column(String(300), nullable=False, comment="通知文案快照")
    is_read = Column(Boolean, default=False, nullable=False, comment="是否已读")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="通知时间")

    actor = relationship("User", foreign_keys=[actor_id])
    recipient = relationship("User", foreign_keys=[user_id])

    def __repr__(self):
        return f"<Notification(id={self.id}, user_id={self.user_id}, type='{self.type}', read={self.is_read})>"


class InviteCode(Base):
    """邀请码 —— 管理员生成或用户专属，默认一次性使用"""
    __tablename__ = "invite_codes"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    code = Column(String(64), unique=True, nullable=False, index=True, comment="邀请码")
    created_by = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, comment="生成者ID")
    # 专属用户：非 NULL 表示这是该用户的专属邀请码（注册时自动分配）
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, comment="专属用户ID")
    used_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, comment="使用者ID")
    is_used = Column(Boolean, default=False, nullable=False, comment="是否已使用")
    is_reusable = Column(Boolean, default=False, nullable=False, server_default="0", comment="是否可重复使用")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="生成时间")
    used_at = Column(DateTime(timezone=True), nullable=True, comment="使用时间")

    creator = relationship("User", foreign_keys=[created_by])
    owner = relationship("User", foreign_keys=[owner_user_id])

    def __repr__(self):
        return f"<InviteCode(id={self.id}, code='{self.code}', used={self.is_used}, reusable={self.is_reusable})>"


class LeetcodeBinding(Base):
    """LeetCode 绑定 —— 记录用户 LeetCode 刷题增量（8.13 起算）"""
    __tablename__ = "leetcode_bindings"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False, index=True, comment="绑定用户 ID")
    leetcode_username = Column(String(100), unique=True, nullable=False, index=True, comment="LeetCode 用户名（leetcode.cn）")
    difficulty_mode = Column(Boolean, default=False, nullable=False, comment="困难模式：得分减半")
    serious_mode = Column(Boolean, default=False, nullable=False, server_default="0", comment="严肃模式：简单题不计分")
    boost_mode = Column(Boolean, default=False, nullable=False, server_default="0", comment="激励模式：初始 -100 分，3/6/9 计分，与困难/严肃互斥")
    backup_base_easy = Column(Integer, nullable=True, comment="激励模式备份：进入时保存基线，退出时恢复")
    backup_base_medium = Column(Integer, nullable=True, comment="激励模式备份：进入时保存基线，退出时恢复")
    backup_base_hard = Column(Integer, nullable=True, comment="激励模式备份：进入时保存基线，退出时恢复")
    debug_mode = Column(Boolean, default=False, nullable=False, server_default="0", comment="调试模式：不读取 LeetCode，手动调整刷题量")
    debug_backup_base_easy = Column(Integer, nullable=True, comment="调试备份：开启时保存基线，关闭时恢复")
    debug_backup_base_medium = Column(Integer, nullable=True, comment="调试备份：开启时保存基线，关闭时恢复")
    debug_backup_base_hard = Column(Integer, nullable=True, comment="调试备份：开启时保存基线，关闭时恢复")
    debug_backup_cur_easy = Column(Integer, nullable=True, comment="调试备份：开启时保存当前值，关闭时恢复")
    debug_backup_cur_medium = Column(Integer, nullable=True, comment="调试备份：开启时保存当前值，关闭时恢复")
    debug_backup_cur_hard = Column(Integer, nullable=True, comment="调试备份：开启时保存当前值，关闭时恢复")
    base_easy = Column(Integer, default=0, nullable=False, comment="8.13 基线：简单题数")
    base_medium = Column(Integer, default=0, nullable=False, comment="8.13 基线：中等题数")
    base_hard = Column(Integer, default=0, nullable=False, comment="8.13 基线：困难题数")
    cur_easy = Column(Integer, default=0, nullable=False, comment="最近同步：简单题数")
    cur_medium = Column(Integer, default=0, nullable=False, comment="最近同步：中等题数")
    cur_hard = Column(Integer, default=0, nullable=False, comment="最近同步：困难题数")
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间"
    )
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="创建时间")

    user = relationship("User")

    def __repr__(self):
        return f"<LeetcodeBinding(id={self.id}, user_id={self.user_id}, leetcode_username='{self.leetcode_username}')>"


class FriendLink(Base):
    """友情链接"""
    __tablename__ = "friend_links"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(100), nullable=False, comment="站点名称")
    url = Column(String(500), nullable=False, comment="链接地址")
    description = Column(String(200), nullable=True, comment="简介")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="创建时间")

    def __repr__(self):
        return f"<FriendLink(id={self.id}, name='{self.name}')>"


class AiKey(Base):
    """用户 AI API Key —— 每个 Key 一条（同一用户可多个），Key 加密存储"""
    __tablename__ = "ai_keys"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True, comment="所属用户 ID")
    provider = Column(String(30), nullable=False, default="deepseek", comment="AI 提供商 ID（见 aisettings.PROVIDERS）")
    label = Column(String(50), nullable=False, default="", server_default="", comment="备注名（如「工作账号」「备用」）")
    api_key_enc = Column(Text, nullable=True, comment="加密后的 API Key（aisettings 加密，永不回传明文）")
    custom_base_url = Column(String(500), nullable=True, comment="自定义 Base URL（留空用提供商默认）")
    last_model = Column(String(100), nullable=True, comment="该 Key 上次选择的模型（切换 Key 时恢复）")
    last_thinking_level = Column(String(10), nullable=True, comment="该 Key 上次思考深度")
    last_temperature = Column(Float, nullable=True, comment="该 Key 上次温度")
    last_top_k = Column(Integer, nullable=True, comment="该 Key 上次 Top-K")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="创建时间")
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间"
    )

    user = relationship("User")

    def __repr__(self):
        return f"<AiKey(id={self.id}, user_id={self.user_id}, provider='{self.provider}')>"


class AiFavorite(Base):
    """收藏的 AI 模型 —— 可用模型列表置顶展示"""
    __tablename__ = "ai_favorites"
    __table_args__ = (UniqueConstraint("user_id", "provider", "model", name="uq_ai_fav"),)

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True, comment="所属用户 ID")
    provider = Column(String(30), nullable=False, comment="提供商 ID")
    model = Column(String(100), nullable=False, comment="模型 ID")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="收藏时间")

    user = relationship("User")

    def __repr__(self):
        return f"<AiFavorite(id={self.id}, user_id={self.user_id}, {self.provider}/{self.model})>"


class AiModel(Base):
    """用户手动新增/关注的 AI 模型 —— 出现在「可用模型」列表，记录添加时间用于排序"""
    __tablename__ = "ai_models"
    __table_args__ = (UniqueConstraint("user_id", "provider", "model", name="uq_ai_model"),)

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True, comment="所属用户 ID")
    provider = Column(String(30), nullable=False, comment="提供商 ID")
    model = Column(String(100), nullable=False, comment="模型 ID")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="添加时间")

    user = relationship("User")

    def __repr__(self):
        return f"<AiModel(id={self.id}, user_id={self.user_id}, {self.provider}/{self.model})>"


class AiSetting(Base):
    """用户 AI 设置 —— 每用户一行：当前选中的 Key/模型 + 采样参数"""
    __tablename__ = "ai_settings"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False, index=True, comment="所属用户 ID")
    key_id = Column(Integer, ForeignKey("ai_keys.id", ondelete="SET NULL"), nullable=True, comment="当前选中的 AI Key")
    model = Column(String(100), nullable=False, default="", server_default="", comment="当前模型 ID")
    thinking_level = Column(String(10), nullable=False, default="medium", server_default="medium", comment="思考深度：low/medium/high")
    temperature = Column(Float, nullable=False, default=0.7, server_default="0.7", comment="温度 0~2")
    top_k = Column(Integer, nullable=False, default=40, server_default="40", comment="Top-K 1~100")
    vision_key_id = Column(Integer, nullable=True, comment="识图模型使用的 AI Key ID（视频总结等）")
    vision_model = Column(String(100), nullable=True, server_default="", comment="识图模型 ID（多模态 chat）")
    vision_thinking = Column(String(10), nullable=False, default="", server_default="", comment="识图模型思考深度（空=不发送该参数，跟随模型默认）")
    speech_key_id = Column(Integer, nullable=True, comment="语音模型使用的 AI Key ID（ASR 转写）")
    speech_model = Column(String(100), nullable=True, server_default="", comment="语音模型 ID（audio/transcriptions）")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="创建时间")
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间"
    )

    user = relationship("User")
    key = relationship("AiKey")

    def __repr__(self):
        return f"<AiSetting(id={self.id}, user_id={self.user_id})>"


class SiteSetting(Base):
    """站点设置（单行配置：首页"保持联系"区块）"""
    __tablename__ = "site_settings"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    email = Column(String(200), nullable=False, default="", comment="联系邮箱")
    github_url = Column(String(500), nullable=False, default="", comment="GitHub 链接")
    contact_items = Column(JSON, nullable=True, comment="自定义联系项 [{label,value}]，与邮箱/GitHub 并列")
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间"
    )

    def __repr__(self):
        return f"<SiteSetting(id={self.id}, email='{self.email}')>"


class CampusCred(Base):
    """校园服务凭据 —— 每用户一行：学号/姓名/VPN密码/校付宝支付密码（后两者加密存储）"""
    __tablename__ = "campus_creds"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False, index=True, comment="所属用户 ID")
    student_id = Column(String(50), nullable=False, default="", server_default="", comment="学号")
    real_name = Column(String(50), nullable=False, default="", server_default="", comment="姓名")
    vpn_password_enc = Column(Text, nullable=True, comment="VPN 密码（加密存储）")
    pay_password_enc = Column(Text, nullable=True, comment="校付宝支付密码（加密存储，暂未使用）")
    auto_captcha = Column(Boolean, nullable=False, default=False, server_default="0", comment="启用 AI 自动识别验证码")
    dorm = Column(String(100), nullable=False, default="", server_default="", comment="默认寝室（电费查询用）")
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间"
    )

    user = relationship("User")

    def __repr__(self):
        return f"<CampusCred(id={self.id}, user_id={self.user_id})>"


class CampusPoolAccount(Base):
    """共享 VPN 会话账号池 —— 站长维护的校园账号，常驻在线供活动看板免配置使用。
    只服务公开数据（活动列表/详情）；分数/成绩/校园卡等个人数据一律走用户自己的会话。"""
    __tablename__ = "campus_pool_accounts"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    student_id = Column(String(50), nullable=False, unique=True, comment="学号（池内唯一，避免同学号互踢）")
    password_enc = Column(Text, nullable=False, comment="VPN 密码（加密存储）")
    label = Column(String(50), nullable=False, default="", server_default="", comment="备注名")
    enabled = Column(Boolean, nullable=False, default=True, server_default="1", comment="是否启用")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="创建时间")

    def __repr__(self):
        return f"<CampusPoolAccount(id={self.id}, student_id={self.student_id})>"


class ElectricityRecord(Base):
    """电费记录 —— 每次查询/自动采集写一行，用于折线图展示"""
    __tablename__ = "electricity_records"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True, comment="所属用户 ID")
    dorm = Column(String(100), nullable=False, default="", comment="寝室号（查询时快照）")
    balance = Column(Float, nullable=True, comment="余额（元）")
    remain = Column(Float, nullable=True, comment="剩余电量（度）")
    recharge_amount = Column(Float, nullable=True, comment="本次充值金额（元），仅充值产生的记录有值")
    raw_json = Column(Text, nullable=True, comment="原始 API 返回 JSON（调试用）")
    queried_at = Column(DateTime(timezone=True), server_default=func.now(), index=True, comment="查询时间")

    user = relationship("User")

    def __repr__(self):
        return f"<ElectricityRecord(id={self.id}, user_id={self.user_id}, balance={self.balance})>"


class UserTimetable(Base):
    """课程表 —— 每用户一份 JSON（课程表页云端同步，updatedAt 最后写入胜）"""
    __tablename__ = "user_timetables"

    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, comment="所属用户 ID")
    data = Column(JSON, nullable=False, default=dict, comment="课程表数据（学期信息 + 课程场次数组）")
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间")

    def __repr__(self):
        return f"<UserTimetable(user_id={self.user_id})>"
