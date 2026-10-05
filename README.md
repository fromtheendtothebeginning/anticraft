# anticraft

> 以匠心为刃，破常规之笼。

**anticraft** 是一个全栈博客系统，包含品牌首页、用户认证（邀请码）、博客管理、点赞评论、管理员后台等功能。淡色主题 + 紫/青渐变辅色，支持 Markdown 渲染、分类筛选与全响应式布局。

---

## 技术栈

| 层 | 技术 | 说明 |
|---|------|------|
| **前端** | React 18 + Vite 5 | 纯 CSS 主题动画页面 |
| **前端路由** | react-router-dom v7 | SPA 路由 |
| **Markdown** | 自研渲染器 | 支持标题/列表/代码块/表格/引用/图片/链接等完整语法 |
| **后端** | Python FastAPI | RESTful API 服务 |
| **数据库** | MySQL 8.0+ | 用户、博客、评论、点赞、邀请码 |
| **认证** | JWT + bcrypt | 密码 SHA-256 预哈希后 bcrypt 加密 |
| **部署** | systemd + Nginx | 反向代理 + 进程守护 |

---

## 功能特性

### 用户系统
- 注册 / 登录 / 重置密码
- **邀请码注册**：新用户必须持邀请码注册，每个用户注册后自动获得一个专属可重复使用邀请码
- 个人资料编辑（昵称、头像 URL）
- 无效账号自动登出（token 失效时前端自动清理）

### 博客系统
- 创建 / 编辑 / 删除博客
- **Markdown 实时预览编辑器**
- 分类筛选：技术讨论 / 更新日志 / 娱乐论坛
- **点赞功能**：同用户对同博客只能赞一次，可取消
- **评论功能**：支持发表、删除自己评论
- 分页列表

### 权限系统
- **角色**：`user`（普通用户）/ `admin`（管理员）
- 管理员后台 `/admin`，四个 Tab：
  - **用户管理**：查看所有用户、切换 user/admin 角色
  - **评论管理**：查看所有评论、删除任意评论
  - **博客管理**：查看所有博客、撤回任意博客、修改分类
  - **邀请码**：生成、查看、删除、切换可重复使用
- 管理员在博客列表页和详情页可直接编辑/撤回/改分类（无需进入后台）

### 开放接口（第三方账号绑定）
- **白名单制**：管理员在「管理后台 → 绑定应用」登记第三方项目（应用名 / 回调地址），登记后拿到 `client_id` / `client_secret`，只有登记且启用的项目能发起绑定
- **OAuth 2.0 授权码模式**：第三方把用户送到 `/bind?client_id=..&redirect_uri=..&state=..`，用户确认后回跳 `redirect_uri?code=..`，第三方服务端用 code 换 30 天访问令牌，再读用户名/昵称/头像
- **用户自助**：「我的 → 账号绑定」查看绑定时间、最近调用，随时解除绑定（令牌立即失效）
- 令牌为不透明的随机串（非 JWT），只对 `/api/open/userinfo` 有效，拿不到站内写权限
- 完整对接文档（流程、接口、错误码、Python/Node 示例）：[docs/account-binding-api.md](docs/account-binding-api.md)

### 界面与交互
- 淡色主题 + 紫青渐变点缀
- 玻璃态导航栏、入场动画、Tab 切换动画
- 统一 Modal 确认弹窗（替代浏览器原生 confirm）
- 全响应式（手机 480px / 平板 768px / 桌面）

---

## 快速开始

### 前置环境

- [Node.js](https://nodejs.org/) 18+
- [Python](https://www.python.org/) 3.11+
- [MySQL](https://dev.mysql.com/downloads/mysql/) 8.0+

### 1. 安装前端依赖

```bash
cd anticraft
npm install
```

### 2. 配置后端 Python 环境

```bash
python -m venv backend\.venv
backend\.venv\Scripts\activate.bat
pip install -r backend\requirements.txt
```

### 3. 配置 MySQL

```bash
mysql -u root -p -e "CREATE DATABASE anticraft CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

### 4. 配置环境变量

编辑项目根目录 `.env`：

```env
DB_USER=root
DB_PASSWORD=你的数据库密码
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=anticraft
SECRET_KEY=随机长字符串用于JWT加密
```

### 5. 启动

```bash
# 一键启动（前后端同时）
npm run start

# 或分别启动
npm run back   # 终端 1 — 后端
npm run dev    # 终端 2 — 前端
```

### 6. 访问

| 页面 | 地址 |
|------|------|
| 首页 | http://localhost:3000 |
| 博客列表 | http://localhost:3000/blogs |
| 登录/注册 | http://localhost:3000/auth |
| 管理员后台 | http://localhost:3000/admin |
| API 文档 | http://127.0.0.1:8000/docs |
| 健康检查 | http://127.0.0.1:8000/api/health |

> 后端默认以 `reload=False` 启动，避免文件改动触发意外重启。

---

## 项目结构

```
anticraft/
├── .env                     # 数据库 & JWT 配置（不提交 Git）
├── .gitignore
├── package.json
├── vite.config.js           # Vite 配置 + /api 代理
├── index.html
│
├── backend/                 # Python FastAPI 后端
│   ├── .venv/               # Python 虚拟环境
│   ├── requirements.txt
│   ├── main.py              # FastAPI 应用入口 & 所有 API 路由
│   ├── database.py          # MySQL 连接 + init_db + run_migrations
│   ├── models.py            # SQLAlchemy 模型（User/Blog/BlogLike/Comment/InviteCode/Project）
│   ├── schemas.py           # Pydantic 请求/响应模型
│   └── auth.py              # 密码加密 + JWT + 角色守卫
│
├── src/                     # React 前端
│   ├── main.jsx
│   ├── App.jsx              # 路由 + 首页
│   ├── App.css
│   ├── index.css            # 全局 CSS 变量
│   ├── components/
│   │   ├── Navbar.jsx
│   │   └── Modal.jsx        # 统一确认弹窗
│   ├── utils/
│   │   └── markdown.js      # Markdown 渲染器
│   └── pages/
│       ├── AuthPage.jsx            # 登录/注册双 Tab 合一页
│       ├── ResetPasswordPage.jsx
│       ├── BlogListPage.jsx
│       ├── BlogDetailPage.jsx
│       ├── BlogEditorPage.jsx
│       ├── ProjectListPage.jsx     # 项目列表
│       ├── ProjectDetailPage.jsx   # 项目详情 + 关联博客
│       ├── ProjectEditorPage.jsx   # 新建/编辑项目
│       ├── ProfileEdit.jsx
│       ├── AdminPage.jsx    # 管理员后台
│       ├── Auth.css
│       ├── Blog.css
│       ├── Project.css
│       ├── ProfileEdit.css
│       └── AdminPage.css
│
├── log/                     # 开发日志
├── deploy.bat               # 全量部署
├── deploy-backend.bat
├── deploy-fresh-server.bat
├── deploy-config.bat
├── README.md
├── warning.md               # 常见部署错误
└── todo.md                  # 任务清单
```

---

## API 接口

### 系统 / 认证
| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| `GET` | `/api/health` | 健康检查 | 否 |
| `POST` | `/api/register` | 注册（需邀请码） | 否 |
| `POST` | `/api/login` | 登录 | 否 |

### 用户
| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| `GET` | `/api/user/me` | 当前用户信息 | Bearer |
| `PUT` | `/api/user/profile` | 更新昵称/头像 | Bearer |
| `GET` | `/api/user/check-username` | 用户名查重 | 否 |
| `PUT` | `/api/user/reset-password` | 重置密码（需邀请码） | 否 |

### 博客
| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| `GET` | `/api/blogs` | 列表（分页 + `?category=`） | 否 |
| `GET` | `/api/blogs/{id}` | 详情 | 否 |
| `POST` | `/api/blogs` | 创建（需分类） | Bearer |
| `PUT` | `/api/blogs/{id}` | 更新（仅作者） | Bearer |
| `DELETE` | `/api/blogs/{id}` | 删除（仅作者） | Bearer |

### 项目
| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| `GET` | `/api/projects` | 项目列表（含博客数） | 否 |
| `GET` | `/api/projects/{id}` | 项目详情（含关联博客，发布时间倒序） | 否 |
| `POST` | `/api/projects` | 创建项目（封面图床 URL） | Bearer |
| `PUT` | `/api/projects/{id}` | 编辑项目（仅作者/管理员） | Bearer |
| `PUT` | `/api/projects/{id}/blogs` | 批量设置关联博客（全量替换，仅作者/管理员） | Bearer |
| `DELETE` | `/api/projects/{id}` | 删除项目（仅作者/管理员，博客自动解除关联） | Bearer |

### 点赞 / 评论
| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| `POST` | `/api/blogs/{id}/like` | 点赞 / 取消点赞 | Bearer |
| `GET` | `/api/blogs/{id}/comments` | 评论列表 | 否 |
| `POST` | `/api/blogs/{id}/comments` | 发表评论 | Bearer |
| `DELETE` | `/api/comments/{id}` | 删除评论（作者或管理员） | Bearer |

### 管理员（需 admin 角色）
| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/admin/users` | 用户列表 |
| `PUT` | `/api/admin/users/{id}/role` | 切换角色 |
| `GET` | `/api/admin/comments` | 全部评论 |
| `DELETE` | `/api/admin/comments/{id}` | 删除任意评论 |
| `GET` | `/api/admin/blogs` | 全部博客 |
| `DELETE` | `/api/admin/blogs/{id}` | 撤回任意博客 |
| `PUT` | `/api/admin/blogs/{id}/category` | 修改博客分类 |
| `POST` | `/api/admin/invite-codes` | 生成邀请码 |
| `GET` | `/api/admin/invite-codes` | 邀请码列表 |
| `DELETE` | `/api/admin/invite-codes/{id}` | 删除邀请码 |
| `PUT` | `/api/admin/invite-codes/{id}/reusable` | 切换可重复使用 |
| `GET` | `/api/admin/bind-apps` | 绑定白名单列表 |
| `POST` | `/api/admin/bind-apps` | 登记第三方应用（返回一次性密钥） |
| `PUT` | `/api/admin/bind-apps/{id}` | 编辑 / 启用停用 |
| `POST` | `/api/admin/bind-apps/{id}/secret` | 重置应用密钥 |
| `DELETE` | `/api/admin/bind-apps/{id}` | 删除应用（作废其全部绑定） |

### 开放接口（第三方项目调用）
| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/open/apps/{client_id}` | 应用公开信息 |
| `POST` | `/api/open/token` | 授权码换访问令牌（需 client_secret） |
| `GET` | `/api/open/userinfo` | 读取已绑定用户资料（Bearer 令牌） |
| `POST` | `/api/open/revoke` | 第三方主动解除绑定 |
| `GET` | `/api/bind/mine` | 我绑定的第三方应用（需登录） |
| `DELETE` | `/api/bind/mine/{app_id}` | 解除绑定（需登录） |

对接说明见 [docs/account-binding-api.md](docs/account-binding-api.md)。

完整接口文档：http://127.0.0.1:8000/docs

---

## 前端页面

| 页面 | 路由 | 说明 |
|------|------|------|
| **首页** | `/` | Hero + 项目展示 + 联系信息 |
| **博客列表** | `/blogs` | 卡片网格 + 分类筛选 + 分页 |
| **博客详情** | `/blogs/{id}` | Markdown 渲染 + 点赞 + 评论 + 作者/管理员操作 |
| **写文章** | `/blogs/new` | Markdown 编辑器 + 实时预览 |
| **编辑文章** | `/blogs/{id}/edit` | 同上，预填内容 |
| **登录/注册** | `/auth` | 登录/注册双 Tab 合一（`/login` 重定向至此） |
| **重置密码** | `/reset-password` | 用户名 + 邀请码 + 新密码 |
| **编辑资料** | `/profile` | 昵称 + 头像 + 退出登录 |
| **项目列表** | `/projects` | 项目卡片网格（封面/简介/博客数） |
| **项目详情** | `/projects/{id}` | 封面 + 简介 + 关联博客（按发布时间从新到旧） |
| **新建/编辑项目** | `/projects/new`、`/projects/{id}/edit` | 项目名 + 封面图床 URL + 简介 |
| **管理员后台** | `/admin` | 用户/评论/博客/邀请码四 Tab |

## 可复用组件（src/components/）

| 组件 | 用途 |
|------|------|
| `NavItem` | 导航栏栏目（支持下拉），新增栏目用 `<NavItem label="xxx" to="/路径" active={...}>{下拉链接}</NavItem>` |
| `Reveal` | 入场动画（滚动进入视口上移淡入），任意元素包一层 `<Reveal className="...">` |
| `Modal` | 统一确认弹窗（勿用 window.confirm） |
| `CategoryDropdown` | 统一分类/选项下拉选择器（悬停展开 + 动画），`size="sm"` 适配紧凑场景 |
| `ProjectCover` | 项目封面（自动提取图片主色作背景，支持自定义 bgColor） |

---

## 设计要点

- **淡色主题** — `#f8f9fa` 背景配 `#1a1a2e` 深色字体，避免灰色字体保证可读性
- **紫青渐变点缀** — `#6c5ce7`（紫）+ `#00cec9`（青）用于按钮、链接、强调色
- **玻璃态导航** — `backdrop-filter: blur(20px)`
- **入场动画** — 模块依次淡入上移
- **全响应式** — 适配手机 / 平板 / 桌面

### 快速换肤（DIY）

所有颜色已抽象为 `src/index.css` 的 `:root` CSS 变量（全站统一引用，无硬编码颜色），改一处即全局生效：

```css
/* 背景 / 文字 */
--bg-primary: #f8f9fa;         /* 页面背景 */
--bg-card: #ffffff;            /* 卡片/面板背景 */
--bg-elevated: #f5f5f8;        /* 悬浮/次级底 */
--text-primary: #1a1a2e;       /* 主文字 */
--text-secondary: #3a3a4e;     /* 次要文字 */
--text-muted: #4a4a5e;         /* 弱化文字 */

/* 主色调（紫） */
--accent-1: #6c5ce7;           /* 主色 */
--accent-1-light: #8b7cf7;     /* 渐变亮端 */
--accent-1-hover: #5a4bd6;     /* 加深 */
--accent-1-soft: rgba(108,92,231,0.1);          /* 浅底 */
--accent-1-soft-strong: rgba(108,92,231,0.15);  /* 略深底 */
--accent-1-border: rgba(108,92,231,0.3);        /* 描边 */

/* 辅色调（青） */
--accent-2: #00cec9;
--accent-2-hover: #00b894;
--accent-2-soft: rgba(0,206,201,0.15);

/* 危险色（红） */
--danger: #e74c3c;
--danger-hover: #c0392b;
--danger-soft: rgba(231,76,60,0.1);
--danger-soft-strong: rgba(231,76,60,0.15);
--danger-border: rgba(231,76,60,0.3);

/* 中性 / 其它 */
--white: #ffffff;
--border-color: #e2e2ef;
--neutral-soft: #e8e8e8;       /* 次级按钮底 */
--neutral-soft-hover: #d0d0d0;
--overlay: rgba(0,0,0,0.5);    /* 弹窗遮罩 */
--glow-accent: rgba(108,92,231,0.08);
--glow-accent-strong: rgba(108,92,231,0.4);
--glow-cyan: rgba(0,206,201,0.06);
--glow-cyan-strong: rgba(0,206,201,0.4);
```

新增颜色一律使用变量，禁止硬编码（相近色统一收敛为上述档位）。

---

## 数据库自动迁移

后端启动时 `run_migrations()` 会自动：
1. `users` 表新增 `role` 列（默认 `user`）
2. `blogs` 表新增 `category` 列
3. `invite_codes` 表新增 `is_reusable`、`owner_user_id` 列
4. 为所有没有专属邀请码的已存在用户分配一个可重复使用邀请码
5. 将 `end` 用户提升为管理员（部署初始化用）

---

## 生产部署

### 一键部署（推荐）

修改 `deploy-config.bat` 中的服务器信息和密码，然后运行：

```bash
deploy.bat
```

脚本自动执行：
1. 构建前端（vite build）
2. 上传前端到 `/var/www/anticraft/dist`
3. 上传后端到 `/var/www/anticraft/backend`
4. 检查/安装 MySQL，设置 root 密码，创建数据库
5. 创建 Python venv 并安装依赖
6. 配置 systemd 服务 `anticraft-api`
7. 配置 Nginx 反向代理
8. 重启后端（触发自动迁移）
9. 验证 API 健康

### 手动构建

```bash
npm run build    # 产物输出到 dist/
```

### Nginx 配置参考

`/var/www/anticraft/dist/` 提供静态文件，`/api/` 反向代理到 `127.0.0.1:8000`。配置由 `deploy.bat` Step 7 自动生成，无需手工维护独立配置文件。

---

## 常见问题

见 `warning.md`，记录了 10 类部署和开发中遇到的常见错误及解决方案。

---

## 开源协议

本项目基于 **GPL-3.0-or-later**（GNU General Public License v3.0 或更高版本）发布，完整协议文本见 [LICENSE](LICENSE)。
