# AGENTS.md — anticraft · 逆匠

全栈博客：React 18 + Vite 5 前端 / FastAPI + SQLAlchemy 后端 / MySQL 8。完整文档见 `README.md`，部署排错见 `warning.md`，任务清单见 `todo.md`。

## 常用命令
- `npm run dev` — Vite 前端，端口 3000，`/api` 代理到 `127.0.0.1:8000`
- `npm run back`（=`backend`）— 后端：`cmd /c "backend\.venv\Scripts\activate.bat && python backend\main.py"`，uvicorn `main:app` 端口 8000，`reload=False`（改后端代码后需手动重启）
- **重启服务一律用 `cmd /c restart-backend.bat` / `cmd /c restart-frontend.bat`**（已 gitignore）：bat 内部用**一次性 schtasks 计划任务**拉起 `run-backend-hidden.cmd`（pythonw 直启、日志重定向到 log/），完全脱离调用方控制台/管道/进程树，bat 瞬间自我退出——绝不内联 Start-Process/cmd 包装（实测会被工具会话回收或挂住）。子进程（如校园服务的容器命令）必须带 `creationflags=CREATE_NO_WINDOW`，否则 pythonw 下反复闪黑窗。验证：隔几秒单独一条 curl http://127.0.0.1:8000/api/health；Vite 只监听 IPv6 `[::1]:3000`，探测用 `http://localhost:3000`。bat 必须纯 ASCII + CRLF；**不要在使用者跑后台任务时重启后端**（会中断在跑的任务）。
- `npm run start` — 两个新窗口分别启动前后端
- `npm run build` — 构建前端到 `dist/`
- **没有测试框架、没有 linter/typecheck**。验证方式：启动后 `curl http://127.0.0.1:8000/api/health`，或 `npm run build` 确认构建通过。

## 完成后的默认动作
- 每次任务完成并验证通过后，**自动启动本地前后端并保持存活**，向用户汇报地址与端口：
  - 前端 http://localhost:3000（`/api` 经 Vite 代理到后端）
  - 后端 http://127.0.0.1:8000（本机若 8000 被 Windows/Hyper-V 排除区间占用，改用 18000 并同步 `vite.config.js` 代理；端口说明见 `log/acceptance-2026-08-06.md`）
- 启动方式：用 **agent 内部终端**（Bash 工具，常驻用 `run_in_background`）启动，**不要打开新的终端弹窗/新窗口**（用户明确要求，2026-08-12）；若确需可视终端，**使用 VSCode 内置终端**（不用 cmd/PowerShell 独立窗口）；日志写 `log/back.out.log` / `log/fe.out.log`。
- **任务完成提醒**：每个任务完成并验证通过后，发出声音提醒用户——播放 Undertale《His Theme》9 秒节奏（`python play_ring.py`，脚本与 `ringtone/his_theme.wav` 已 gitignore，零依赖 winsound，音量已调低；**用分离子进程播放且无黑窗口（DETACHED_PROCESS+CREATE_NO_WINDOW），主进程立即返回不阻塞总结**）。
- **部署红线：未经用户明确同意，禁止运行任何部署脚本（`deploy.bat` / `deploy-backend.bat` / `deploy-fresh-server.bat` 等，`deploy-config.bat` 是共享凭据来源）或发布到服务器**。完成功能后只启动本地服务供验收，等用户指示「发布到服务器并git」再部署。**代理不得读取、展示或上传这些脚本中的任何凭据/密码**——凭据仅由用户本人运行脚本时使用，代理一概不接触。


## 后端
- 虚拟环境 `backend/.venv`（Python 3.14）。入口是根目录的 `python backend/main.py`，main.py 内部用同目录相对导入（`from database import ...`）。
- 依赖锁版本，勿随意升级：`mysql-connector-python==8.4.0`（9.x 兼容问题）、`bcrypt==5.0.0`（passlib 不兼容，直接 `import bcrypt`）、`pyjwt`（不用 python-jose，避免 C 扩展编译）。
- `.env`：`database.py` 优先读项目根 `.env`，回退 `backend/.env`（服务器用），`.env` 已 gitignore。

## 认证与密码（易错）
- 密码流程：SHA-256 预哈希 → bcrypt（绕过 bcrypt 72 字节限制）。所有密码处理必须走 `backend/auth.py` 的 `hash_password` / `verify_password`，不要自行实现。
- JWT：pyjwt / HS256 / 24h。前端 token 存 `localStorage.token`、用户信息存 `localStorage.user`，请求头 `Authorization: Bearer <token>`。
- 公开接口（博客列表/详情）用 `oauth2_scheme_optional` 附带当前用户信息（决定 `liked_by_me`），未登录返回 None 而非 401。

## 数据库迁移（关键）
- 启动时 `init_db()` 只建新表；已有表的新增列必须写进 `database.py` 的 `run_migrations()`（ALTER TABLE 逻辑），否则旧库报 `Unknown column`。在 `models.py` 加列时务必同步迁移逻辑。
- **`create_all` 不会为已存在的同名旧表补列**：`projects` 表是早期已删功能的遗留表（含 `owner_id`/`image_url`/`tags`/`is_featured` 旧列），曾导致 INSERT 报缺列、`Field 'owner_id' doesn't have a default value`。库中若存在同名的遗留旧表，必须在 `run_migrations()` 里补齐新列并把阻塞的 NOT NULL 旧列改为可空。
- 迁移还会：为无专属邀请码的用户补发可重复使用邀请码；把用户 `end` 提升为 admin（首个管理员账号）。

## 业务规则
- 注册必须携带邀请码，无邀请码无法注册；每个新用户自动获得一个可重复使用的专属邀请码；重置密码必须使用**本人专属**可重复邀请码（不消耗，防止接管他人账号）。
- 权限用 `User.role`（`user`/`admin`），后端 `require_admin` 依赖拦截 403，前端 `/admin` 页面。
- 博客分类是固定中文字符串：`技术讨论` / `更新日志` / `娱乐论坛`。前端导航下拉与后端 `?category=` 共享，改动需两端同步。

## 前端
- 无 UI 组件库；Markdown 渲染为自研 `src/utils/markdown.js`，新增语法改它。
- 确认弹窗统一用 `src/components/Modal.jsx`，不用 `window.confirm`。
- 每页独立 CSS 文件；主题色在 `src/index.css` 的 CSS 变量（`--bg-primary` / `--text-primary` / `--accent-1` / `--accent-2`）。
- react-router-dom v7，路由集中在 `src/App.jsx`，页面在 `src/pages/`。
- **图标一律不用 emoji**：统一用镂空简笔 SVG 图标（`src/components/Icons.jsx` 的 `UiIcon` 组件，Feather 风格 stroke；品牌图标用 `ContactIcon`）。新增图标先看 Icons.jsx 是否已有，没有则按相同风格补一个。

## harness（AI 智能体管控框架，顶层目录）
- 纯 Python 标准库，零第三方依赖；不修改 `backend/` 代码，后端集成走懒加载。
- 三子系统：`core/context.py` 上下文 token 预算/压缩、`core/entropy.py` 不确定性→风险分级→人工介入、`core/watchdog.py` 周期自检+告警+`require()` 强制门禁。
- 命令：`python -m harness check [--only 名称]`；演示 `context`/`entropy`；测试 `python -m unittest discover -s harness -t .`。建议用 `backend\.venv\Scripts\python.exe` 运行。详见 `harness/README.md`。

## 经验与提醒（重构后勿回退）
- 登录/注册统一走 `/auth`（双 Tab 合一页），`/login` 仅重定向到 `/auth`。新增认证链接/跳转一律指 `/auth`，勿重建 `LoginPage`/`RegisterPage`。
- 共享组件样式（`.btn` / `.navbar` / `.modal-*` 弹窗）统一在 `App.css`。Modal 弹窗样式必须在 App.css，勿搬回页面私有 CSS（如 Blog.css），否则 AdminPage 等不加载 Blog.css 的页面弹窗样式丢失。
- 已删除文件勿恢复：`context.md`（过时）、`log/2026-06-30.md`（描述已移除的 Project/Category 功能）、`anticraft.nginx.conf`（与 deploy.bat 内联生成的 Nginx 配置重复）；**视频功能全量移除（2026-09-11）**：`backend/tools.py`、`backend/features/tool_api.py`、`backend/features/video_summary.py`、`src/pages/ToolParsePage.jsx`、`src/features/video-summary/`（注意 `src/pages/ToolParsePage.css` 是共享样式，图文转 LaTeX / 校园服务仍在 import，勿删）。
- `check_db.sh` 含硬编码服务器密码，已 gitignore，勿提交 git。
- models.py 勿新增仅序列化/零读写的字段（`User.email` 教训）；在 models.py 加列必须同步 `database.py` 的 `run_migrations()`。
- 大型多步骤任务优先派子代理实施，主脑负责架构、接口约定与验证，保持上下文清洁。
- **国外 AI 厂商文档读取**（Anthropic docs.anthropic.com / platform.openai.com / ai.google.dev 直接 webfetch 会超时/403，勿反复重试）：改用**国内可访问文档源**（阿里云 help.aliyun.com、千问 platform.qianwenai.com）或 **GitHub 官方 SDK 源码**（openai/openai-python、anthropics/anthropic-sdk-python、googleapis/python-genai 的 raw 源码/README）获取权威 API 配置。2026-08 实测有效。
- **AI 设置（MyPage AI 设置 tab）**：思考深度选项按厂商文档差异化（`provider.thinking_levels`，后端 aisettings.py + 前端 aiProviders.js 双处同步），UI 用 CategoryDropdown 选择器（不是定死低/中/高三档）。Anthropic（Claude）不支持 temperature/top_k，配置 `sampling: false`，前端对 `sampling===false` 的厂商隐藏温度/Top-K 滑块。模型选择走「可用模型列表点击选中」，不单独放下拉。

## 新功能开发流程（文件冻结制）
- **后端**：新功能 = 新建 `backend/features/<名>.py`（模块级 `router = APIRouter()` 即被 main.py 自动发现挂载）；跨域共享助手放 `backend/deps.py`。旧文件一律不改。
- **前端**：新功能 = 新建 `src/features/<kebab-name>/` 文件夹（页面 + css + `routes.js(x)`，default 导出 `{ path, element }[]`；可选导出 `nav` 自动追加进导航栏）。App.jsx / Navbar 零改动。约定见 `src/features/README.md`。
- **字符串常量**集中在两处并开放权限：`backend/constants.py` / `src/constants.js`（博客分类、角色、CORS 默认值等两端同步项改这里，禁止散落硬编码）。
- **权限规则**（项目根 `opencode.json`）：**逐功能逐文件登记，禁止目录通配批量放行**——所有既有文件默认 `edit: ask`；既有 features 模块逐个显式列 `"ask"`（受保护的存量代码）；开发中的新功能开工时为其单独加一条 `"allow"`（只放行该功能的文件）；两个 constants 文件 `allow`。opencode 配置不热加载，改完需重启 opencode 生效。
- **竣工锁定**：新功能经用户确认完成后，把该功能在 `opencode.json` 里的 `"allow"` 条目改为 `"ask"`（last-match-wins），即冻结为受保护旧文件。

## 运行注意事项（每次任务结束追加新发现）
1. **单条 Bash 调用必须秒级返回（目标 <10 秒），严禁串联慢动作**：不要把「重启服务 + sleep + 验证 curl + 构建」写进同一条命令——用户会看到长时间无输出视为卡死。正确姿势：重启用 bat（默认立即返回）→ 单独一条 curl 验证 → 构建再单独一条。预计超 ~30 秒的操作（真实 AI 调用、批量测试）一律 `Start-Process` 分离进程重定向到 log 文件，随后用独立的 `Get-Content -Tail` 快速轮询结果。
1. **本地后端端口必须是 8000**：`vite.config.js` 代理固定指向 `127.0.0.1:8000`，本地后端起 8000（18000 仅当 8000 被 Windows 排除区间占用时用，且必须同步 vite 代理）。用错端口 API 测试会 Connection refused。
2. **Vite HMR 偶发失效**：改前端代码后浏览器仍显示旧代码/旧图标时，先杀 3000 端口进程重启 `npm run dev`，不要怀疑代码没改（2026-08-10 图标替换时踩坑）。
3. **本地库 ≠ 服务器库**：本地库有测试数据（"测试博客 111"等），线上是真实数据；测试/示例用真实 id 前先查 API，勿按线上 id 假设本地存在（反之亦然）。
4. **服务器 DB 密码禁止含 `@` 等 URL 特殊字符**：`database.py` 用 URL 拼接连接串，密码含 `@` 会导致启动失败 `Unknown MySQL server host`（2026-08-10 事故根因）。密码字符集只用字母数字 `_` `-`。改密流程：`ALTER USER`（远程 SQL 用 base64 传输，避免引号嵌套问题）→ 同步本机 `deploy.bat` L16 / `deploy-config.bat` L12 / `check_db.sh` L2 三处 → 重跑 `deploy.bat` 验证。
5. **deploy.bat 每次部署覆盖生成 `backend/.env`**（从根 `.env` 复制并替换 `DB_PASSWORD` 为服务器密码）→ 本地 `backend/.env` 的 DB_PASSWORD 是服务器密码，连本地库需注意。
6. **Playwright 验证环境**（项目已装 `playwright-core`，chromium 二进制在 `C:\Users\86133\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe`，启动需传 `executablePath`）：`addInitScript` 只接受一个参数（多参数先写入 localStorage 再 `location.reload()`）；`page.evaluate` 里的相对 fetch 需先 goto 一个页面；`innerText` 不含 input 值，验证输入用 `inputValue()`；CSS hover 菜单点击用 Playwright 会暴露真实用户遇见的 hover 断链/遮挡问题。
7. **测试账号流程**：注册测试账号 → 直接改库 `role='admin'` 用其 token 调 admin 接口 → 测试完毕删除账号并**还原被改的数据**（如博客分类）。
   - **固定本地测试账号（长期保留，勿删除、勿重复注册）**：`demotools` / `DemoTools123`（admin）。需 token 时直接查库改其 `role='admin'` 后登录取 token；不要每次注册新账号再删。
8. **CSS hover 下拉经验**：下拉菜单与触发按钮之间留 gap 会导致鼠标移动时 hover 断链、菜单收起（gap 归零 + `padding-top` 桥接热区）；列表项 `animation ... both` 保留的 transform 会创建 stacking context、导致相邻行遮挡下拉菜单（hover 行加 `position: relative; z-index: 5`）。
9. `deploy.bat` 输出末尾的 `Input redirection is not supported` 是 systemd status 重定向的已知噪音（warning.md #2/#10），不影响部署结果。
10. **深色模式排查**：任何组件"深色下看不清/仍是白底"，先查其 background 是否用了 `var(--white)`（恒定纯白）——应改用 `var(--bg-card)`（跟随主题）。
11. **校园服务「Docker 不可用（127.0.0.1:2375）」= `.env` 里残留本地开发的 `DOCKER_HOST`**（2026-09-09 事故根因，排查样板）：
    - `database.py` 用 `load_dotenv(dotenv_path=..., override=True)` 加载 `.env`（优先项目根，回退 `backend/.env`），所以 `.env` 里的 `DOCKER_HOST` 会进进程环境；**服务器 dockerd 只监听 `/var/run/docker.sock`**（`ss -lntp | grep 2375` 为空）。旧版 `campus/docker_mgr.py` 只认 `DOCKER_HOST`、没有 socket 回退 → 报 `校园服务未就绪（Docker 不可用）：... port=2375 ... Connection refused`；b965165 起的改写版加了 unix socket 回退，所以"新代码反而能连上"。
    - 本地根 `.env` / `backend/.env` 里那行 `DOCKER_HOST=tcp://127.0.0.1:2375` 是给"Windows 侧后端连 WSL dockerd"的，已注释；它指向的 WSL 2375 本来就没监听（本地后端跑在 WSL 里，走默认 socket）。**服务器 `/var/www/anticraft/backend/.env` 里这行必须保持注释**，修复时的备份是 `.env.bak-20260909`。
    - 排查手法：`ssh root@47.100.125.150 "journalctl -u anticraft-api --since '2026-09-08' | grep -i 'campus docker init failed'"` 看首次失败时间；`systemctl show anticraft-api -p Environment -p EnvironmentFile`；注意 `/proc/<pid>/environ` **看不到**运行时 `load_dotenv` 注入的变量，要在服务器上按应用方式复现：`cd /var/www/anticraft/backend && .venv/bin/python -c "import database,os;print(os.environ.get('DOCKER_HOST'))"`，再 `DockerManager(Config())` 试连。
12. **服务器实际路径与部署边界**：后端在 `/var/www/anticraft/backend`（**不是** `/root/anticraft`），systemd 单元 `/etc/systemd/system/anticraft-api.service`（2026-06-26 创建，仅 `Environment=PYTHONUNBUFFERED=1`，`ExecStart=.../backend/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000`）。`deploy.bat` 对已存在的 service/venv 只重启不重写（日志里 `[EXISTS] service` / `[EXISTS] venv`），而且**不会更新服务器上的 `.env`**（本地 `backend/.env` 被重新生成 ≠ 服务器 `.env` 被更新）；要改服务器配置得直接改服务器文件。
13. **服务器可免密 SSH 排查**：`ssh root@47.100.125.150`（密钥已就绪，无需任何密码），排查线上问题优先用它读 journal / 看 `.env` / 看 docker 状态。**但部署脚本与其中的凭据依旧禁止读取/展示，部署仍须用户明确同意**。
14. **2026-09-09 git 状态**：`main` 已回滚到 `3560dd7` 并 force-push（线上同版本）；电费 + VPN 单端口共享的改写（`5e2d16a..bbf9e22`，10 个提交）保留在分支 `backup/campus-rewrite`（本地与 origin 都有）。另注意本地 WSL 后端跑在 `/home/dev/anticraft/index`（只有 `backend/` + `log/`，**不是 git 仓库**），是 Windows 仓库的独立副本——回滚/改代码后要手动同步，否则本地后端仍是旧代码。
15. **校园网 VPN「同账号只能一个会话」→ 本地与服务器会互相踢**（2026-09-10 排查结论；症状：第二课堂/成绩查询很慢、提交验证码常失败、`SOCKSHTTPSConnectionPool ... xg.sit.edu.cn ... connect timeout=30`）：学校侧限制一个账号同时只有一个 EasyConnect 会话，本地 WSL 容器与服务器 `ec-c1` 同时在线时会互相踢下线，两边容器日志都出现 `login successfully!` → `svpn stop!` → `Terminated` 的反复；被踢那一刻容器内 `tun0` 消失、隧道路由清零（`docker exec ec-c1 ip route | grep -c tun0` → 0，正常应为几百条），SOCKS 流量按 `ip rule` 进表 2 后走默认路由从 eth0 出网，于是校园内网 IP（`xg.sit.edu.cn` → 172.24.9.11）必然 connect timeout。**排查手法**：`docker exec ec-c1 ip route get 172.24.9.11`（应为 `dev tun0`）+ 两侧容器日志对比。**处置**：同一时间只在一侧连接（本地测试前先断开服务器：`POST /api/campus/disconnect`，反之亦然）。
16. **3560dd7 的「已连接」判定偏弱**：只看容器日志有没有 `login successfully`（`campus/sessions.py:_run`），不校验 `tun0`/隧道路由，所以会话被踢后界面仍显示已连接、查询却必然 30s 超时。改写版（b965165 之后）改成连续 3 次看到 tun0 才置 connected，需要时可从 `backup/campus-rewrite` 取回该判定。容器日志里的 `Error: ipv4: FIB table does not exist. Flush terminated` 是 WSL2 下的既有噪音，不影响隧道建立（实测有该报错时 tun0 仍有 643 条路由）。
17. **Bash 工具里 `cmd /c xxx.bat` 会被 MSYS 路径转换吃掉**：`/c` 被转成 `C:/`，cmd 只打印版本横幅就退出、脚本静默不执行（`restart-backend.bat` 看着像跑过了，其实服务没起）。正确写法 `MSYS2_ARG_CONV_EXCL='*' cmd /c xxx.bat`；是否真执行看 bat 自己的回显（如 `[restart-backend] spawned and exited`），别只看退出码。
18. **校园 VPN 心跳（2026-10-02 新增，服务器专属、gitignored）**：`backend/features/campus_heartbeat.py`（**已 gitignore，本地工作树是唯一源**）——每小时检查 `end` 的 VPN 会话，北京时间 06:00–23:00 内发现无会话/failed/tun0 路由清零就自动重连；后端启动 90 秒后也先查一次（部署重启即自动拉起代理）。开关是服务器 `.env` 的 `CAMPUS_HEARTBEAT=1`（deploy.bat 不覆盖服务器 .env，一次配置永久生效）；**本地绝不设这个变量**（同账号单会话，心跳会把本地测试会话踢下线）。**每次部署后必须核对**：`ssh root@47.100.125.150 'test -f /var/www/anticraft/backend/features/campus_heartbeat.py && echo ok'`（该文件不在 git，若部署方式变成干净覆盖就要从本地重传）+ `journalctl -u anticraft-api --since "-5 min" | grep campus-heartbeat` 确认代理被拉起。

## 部署（Windows → 阿里云 47.100.125.150）
- 迭代部署跑本地 `deploy.bat`（已 gitignore，仅本机存在）：构建前端、SCP 上传前后端、装依赖、重启 systemd 服务 `anticraft-api`、reload Nginx。同目录还有 `deploy-backend.bat`（仅传后端+重启）、`deploy-fresh-server.bat`（全新服务器初始化）、`deploy-config.bat`（SSH/凭据共享配置，被其余脚本引用）——均含服务器凭据，同样禁止未经同意运行。**代理不得读取/展示这些脚本中的凭据内容**，部署与凭据处理只由用户本人执行。
- `deploy.bat` 硬编码服务器 DB 密码（已 gitignore，仅本机存在），并覆盖生成 `backend/.env`。
- Windows cmd 中 SSH 命令的 `&&`/多行字符串会被错误拆分（warning.md #2/#10），修改部署脚本时注意。
- 服务器数据库检查可用 `check_db.sh`。
