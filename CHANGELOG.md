# Changelog

本项目的所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **可选访问密码（`PLATFORM_PASSWD`）**：设置后首页显示密码门禁，未通过验证无法调用
  `POST /api/search`、`POST /api/fetch`；未设置时功能完全惰性，行为与 0.1.0 一致。
  - 访问密码以 **Argon2id PHC 哈希**配置（非明文）；新增 `--hash-password` /
    `hash-password` 子命令，从 stdin 读取密码（8–256 个字符）并输出哈希。
  - 新增 `generate-passwd` 子命令：直接生成强随机密码及对应哈希（默认 20 字符，
    `--length 16-64` 可调；字符集排除 `0/O/o`、`1/l/I` 等易混字符；OS CSPRNG +
    拒绝采样保证无偏）；`--hash-only` 便于脚本使用。Docker 下
    `docker run --rm <镜像> generate-passwd` 同样可用。
  - 新增 `POST /api/auth/login`：校验密码后签发 **7 天（604800 秒）**有效的无状态 token
    （`v1.<expiry>.<base64url(HMAC-SHA256)>`，签名密钥由密码哈希派生，改密码后旧 token
    全部失效）；登录接口独立限流 **10 次/分钟/IP**。
  - `GET /api/config` 新增 `auth.enabled` 字段（仅布尔值，不泄露哈希或 token）。
  - 前端新增密码门禁界面（PasswordGate）：未验证前不渲染搜索框；token 存于
    `localStorage`（`ai-search-platform:auth-token`），过期/失效时自动回到门禁并提示。
  - `docker-compose.yml` 透传 `PLATFORM_PASSWD`；`.env` 中的哈希必须用单引号包裹，
    避免 dotenvy 把 `$argon2id` 当作变量替换（`.env.example` 已注明）。

### 安全

- 密码使用 Argon2 校验（常量时间）；token 使用 HMAC-SHA256 + 常量时间比较；服务端不保存会话；
  `PLATFORM_PASSWD` 在 `Config` 的 `Debug` 输出中脱敏；非法哈希在启动时直接失败
  （不静默降级为无密码）；登录限流独立于搜索/抓取。

### 文档

- README 新增「启用访问密码」使用指南、`POST /api/auth/login` API 文档与鉴权错误码，
  并补充单密码共享、token localStorage 等已知限制。

## [0.1.0] - 2026-10-19

首个开源版本。定位：把 DeepSeek Search & Fetch API 封装成自托管的 AI 搜索界面，
单二进制交付，默认开启磁盘缓存与安全防护。

### 新增

- **搜索代理**：`POST /api/search` 转发到上游 `POST /v1/tools/search`，
  支持 `query`、`count`（1–50，默认 50）、`ori_question`、`localization`、
  `need_content`（默认 `true`）、`force_refresh`。
- **正文抓取**：`POST /api/fetch` 转发到上游 `POST /v1/tools/fetch`，
  返回标题与 Markdown 正文，同样支持 `force_refresh`。
- **元信息接口**：`GET /api/health`（状态 + 版本）与 `GET /api/config`
  （非敏感默认值/限额/缓存信息，绝不返回 API Key）。
- **磁盘缓存**：搜索结果与抓取结果默认缓存；SHA-256 键、TTL 1 天（86400 秒）、
  原子写入、Unix `0600`/`0700` 权限、启动与每 600 秒后台清理，
  按 2000 条 / 256 MiB / 单条 8 MiB 收敛；缓存失败一律降级为 miss。
- **前端单页应用**：Vite + React 19 + TypeScript；首页、搜索结果页、语法面板、
  高级设置、全文抓取抽屉、原始 JSON 折叠、复制/分享链接、空状态与错误提示。
- **搜索语法面板**：支持 `site:`、`-site:`、`-词`、`-"短语"`、`"精确短语"`、
  `lang:`、`after:`、`before:` 共 8 个操作符。
- **主题与响应式**：跟随系统 / 浅色 / 深色三态主题（localStorage 记忆），
  适配移动端与桌面端，触控目标与键盘可达性处理。
- **单二进制分发**：release 构建通过 `rust-embed` 把 `frontend/dist` 编译进二进制；
  debug 构建从磁盘读取前端产物，便于开发。
- **可观测性**：`tracing` 结构化日志（`RUST_LOG` 控制）、优雅关闭、
  健康检查端点。
- **开发工具链**：`Makefile` 常用命令、`scripts/build.sh` 一键构建、
  `scripts/mock_upstream.py` 本地 mock 上游、`scripts/smoke.sh` 端到端验收。
- **容器化与 CI**：多阶段 Docker 构建（distroless 运行时、非 root uid 65532）、
  docker compose 部署、GitHub Actions 持续集成与多架构镜像发布。

### 安全

- **CSRF 防护**：`POST /api/*` 强制 `X-Requested-With: ai-search-platform`、
  `Content-Type: application/json`，并校验 `Origin` 同源与 `Sec-Fetch-Site`。
- **Host / DNS Rebinding 防护**：拒绝重复 Host、非法字符与异常端口；
  绑定回环时只接受回环主机名；新增 `ALLOWED_HOSTS` 白名单（逗号分隔域名），
  用于公网/反向代理部署时强制校验 `Host`，防止攻击者域名指向本机后被当作同源。
- **严格 CSP 与安全响应头**：`default-src 'self'`、无 `unsafe-inline`/`unsafe-eval`、
  `object-src 'none'`、`frame-ancestors 'none'`、`form-action 'none'`；
  `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
  `Referrer-Policy: no-referrer`、COOP/CORP `same-origin`、权限策略收紧。
- **SSRF 防护**：`/api/fetch` 仅接受 `http/https`，拒绝内嵌凭据，
  拦截回环/私有网段/链路本地/CGNAT/ULA/IPv4-mapped IPv6 等目标；上游不跟随重定向。
- **限流与资源上限**：每 IP 每分钟 30 次（search/fetch 独立）、请求体 16 KiB、
  上游响应 16 MiB、上游并发 8、上游超时 30 秒、整请求超时 90 秒。
- **前端 XSS 防护**：上游 Markdown 使用 `react-markdown` + `skipHtml` 渲染，
  HTML 当作文本；链接/图片仅放行 `http(s)` 协议。
- **密钥保护**：`Config` 的 `Debug` 固定脱敏，`/api/config` 与日志不出现 API Key。
- **缓存隐私**：关键词以 Base64URL 折入缓存键，文件名只含 64 位 hex，不落明文关键词。

### 文档

- 新增 README（快速开始、配置、API、搜索语法、架构、安全、开发指南）。
- 新增 `LICENSE`（MIT）、`SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、
  `.env.example`。

### 已知限制

- 单实例设计：本地磁盘缓存，无分布式缓存与共享限流。
- 无多用户鉴权、API Token 与按用户配额；公网部署需反向代理访问控制。
- 无流式响应；长请求受 90 秒整请求超时约束。
- `need_content: true`（默认）会显著增大响应体，但不影响上游计费口径。
- 缓存上限、TTL、超时等均为编译期常量，不可通过环境变量调整。
