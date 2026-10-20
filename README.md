<div align="center">

# 🔎 AI 搜索平台

**可自托管的 AI 搜索与网页抓取平台 —— Rust + React，构建后只有一个二进制文件。**

把 DeepSeek Search & Fetch API 变成你自己的搜索界面：没有数据库、没有 Redis、没有独立前端服务器；
默认开启磁盘缓存，默认只监听本机，默认拒绝跨站请求。

[![CI](https://github.com/shuaihaoV/ai-search-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/shuaihaoV/ai-search-platform/actions/workflows/ci.yml)
[![Image Size](https://img.shields.io/badge/image%20size-~44%20MB-2496ED?logo=docker&logoColor=white)](https://github.com/shuaihaoV/ai-search-platform/pkgs/container/ai-search-platform)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.88%2B-orange?logo=rust&logoColor=white)](Cargo.toml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[✨ 功能特性](#-功能特性) · [🚀 快速开始](#-快速开始) · [⚙️ 配置](#-配置) · [🔍 使用](#-使用) · [🛡 安全](#-安全) · [📚 文档](#-文档) · [💻 开发](#-开发) · [📄 License](#-license)

</div>

---

> **项目状态**：`v0.1.0`，功能与接口仍可能小幅调整；欢迎 Issue / PR 参与共建。

**它适合**：想自托管一个 AI 搜索界面、又不想维护数据库/Redis/前端服务器的个人或小团队；
内网知识检索、给团队做一个带访问密码的搜索入口；以及想学习 Rust Web 服务安全默认值的开发者。

**它不适合**：需要多用户账号体系、按用户配额、分布式缓存的多人 SaaS 场景
（见[安全白皮书 · 已知限制](docs/SECURITY.md#已知限制)）。

---

## ✨ 功能特性

- **🔍 关键词搜索**：接入 DeepSeek Search API，返回标题、链接、摘要、AI 摘要、正文、
  站点信息、发布时间、权威度与重排分数；单次最多 50 条结果。
- **📄 抓取网页全文**：接入 DeepSeek Fetch API，把公开网页转成 Markdown，在站内直接阅读。
- **🧩 搜索语法**：`site:`、`-site:`、`-词`、`-"短语"`、`"精确短语"`、`lang:`、`after:`、
  `before:` 共 8 个操作符。
- **⚡ 内置磁盘缓存**：搜索/抓取结果默认缓存 1 天，SHA-256 键 + 原子写入 + 后台清理；
  命中缓存不消耗上游额度，无需 Redis。
- **🧾 安全渲染**：`react-markdown` + `skipHtml`，HTML 当文本；链接/图片仅放行 `http(s)`。
- **🌗 三态主题 + 响应式**：跟随系统 / 浅色 / 深色，移动端与桌面端自适应，键盘可操作。
- **📦 单二进制分发**：release 构建用 `rust-embed` 把前端**编译进二进制**，只需一个可执行文件。
- **🛡 安全默认值**：CSRF 同源校验、严格 CSP、SSRF 过滤、Host 校验、按 IP 限流、
  体积上限、密钥脱敏，可选访问密码门禁。
- **🐳 容器化**：多阶段构建、distroless 运行时（非 root）、多架构镜像（amd64/arm64）、
  `docker compose` 一键启动、内置健康检查。

---

## 📸 界面截图

<div align="center">

![首页：搜索框、示例问题与语法提示](docs/screenshots/home.png)

*首页 —— 搜索框 + 示例问题与使用提示，支持 `/` 聚焦、语法面板、高级设置与主题切换。*

![搜索结果页：AI 摘要、正文操作与来源信息](docs/screenshots/search.png)

*搜索结果页 —— 标题、站点/时间信息、优质与权威度徽标、AI 摘要，以及「抓取全文 / 长摘要 / 正文 / 原始 JSON」操作。*

</div>

---

## 🚀 快速开始

你只需要 **Docker**（推荐），或者 **Rust 1.88+ / Node.js ≥ 20.19 / pnpm 9+** 从源码构建；
另需一个 [DeepSeek API Key](https://platform.deepseek.com)（没有 Key 也可先用 mock 上游体验界面）。

### 方式一：Docker Compose（推荐）

```bash
git clone https://github.com/shuaihaoV/ai-search-platform.git
cd ai-search-platform

cp .env.example .env
$EDITOR .env                 # 至少填入 DEEPSEEK_API_KEY

docker compose up -d --build # 构建镜像并后台启动
```

打开 <http://127.0.0.1:8080>，验证安装成功：

```bash
docker compose ps                                  # STATUS 应显示 healthy
curl -s http://127.0.0.1:8080/api/health           # {"status":"ok","version":"0.1.0"}
```

`docker-compose.yml` 已按生产安全默认值配置：仅映射 `127.0.0.1:8080`、非 root（uid 65532）、
只读根文件系统、丢弃全部 capability、缓存命名卷 `/app/.cache`、内置健康检查与日志轮转。

<details>
<summary>展开：compose 关键设计与验证说明</summary>

- 服务名 `ai-search`，默认仅映射 `127.0.0.1:8080`；可用 `HOST_BIND` / `PORT` 覆盖。
- 容器内 `BIND_ADDR` 由 compose 固定为 `0.0.0.0:8080`（**无需修改 `.env`**）。
- 缓存目录 `/app/.cache` 由命名卷 `ai-search-cache` 持久化，`docker compose down` 不会丢缓存。
- `ALLOWED_HOSTS` 默认 `localhost,127.0.0.1`；公网/反代部署时改为对外域名。
- 可选访问密码 `PLATFORM_PASSWD` 已透传（默认空 = 不启用）。
- 镜像为多架构（`linux/amd64`、`linux/arm64`）、distroless 运行时，实测体积约 **44.5 MB**；
  可用 `IMAGE_TAG` 指定镜像 tag，例如 `IMAGE_TAG=v0.1.0 docker compose up -d`。

</details>

公网部署、自定义端口、启用访问密码等见[部署与运维](docs/DEPLOYMENT.md)、下方[配置](#-配置)与
[启用访问密码](#启用访问密码可选)。

### 方式二：docker run

```bash
docker run -d --name ai-search --restart unless-stopped --init \
  -p 127.0.0.1:8080:8080 \
  -e DEEPSEEK_API_KEY=sk-xxxxxxxx \
  -v ai-search-cache:/app/.cache \
  --read-only --tmpfs /tmp:size=16m,noexec,nosuid \
  --security-opt no-new-privileges:true --cap-drop ALL \
  ghcr.io/shuaihaov/ai-search-platform:latest
```

> **必须挂载 `/app/.cache` 卷**（只读根文件系统下缓存需要可写卷）。
> 公网部署追加 `-e ALLOWED_HOSTS=...`；启用访问密码追加 `-e PLATFORM_PASSWD='$argon2id$...'`。
> 镜像无 shell，但内置 busybox：`docker exec -it ai-search sh` 可进容器排障。

### 方式三：源码构建 / Release 二进制 / mock 联调

| 方式 | 说明 |
|---|---|
| **docker run** | 单条命令启动，需挂载 `/app/.cache` 卷；完整参数见[部署与运维](docs/DEPLOYMENT.md#docker-生产建议) |
| **源码构建** | `make build` 生成 `target/release/ai-search-platform`，`make run` 启动 |
| **Release 二进制** | 从 [GitHub Releases](https://github.com/shuaihaoV/ai-search-platform/releases) 下载对应平台压缩包，解压即用 |
| **本地 mock 联调** | `make mock` 启动 mock 上游（127.0.0.1:9000），无需真实 Key |

<details>
<summary>展开：源码构建 / Release 二进制 / mock 联调</summary>

```bash
# 源码构建
cp .env.example .env && $EDITOR .env
make build                   # 前端 → 编译期嵌入 → release 二进制
make run                     # 读取 ./.env，默认 127.0.0.1:8080

# Release 二进制
chmod +x ai-search-platform
cp .env.example .env && ./ai-search-platform

# 无 API Key 联调：终端 1 起 mock，终端 2 指向 mock 启动
make mock
DEEPSEEK_API_KEY=test-key DEEPSEEK_BASE_URL=http://127.0.0.1:9000 make run
```

</details>

---

## ⚙️ 配置

### 环境变量（6 个）

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 否\* | 空 | DeepSeek API Key，以 `Authorization: Bearer <key>` 转发给上游。 |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | 上游 Base URL。可带或不带 `/v1` 后缀（不会重复拼接）；自建反代或本地 mock 时改这里。仅支持 `http/https`；非回环地址必须使用 `https`，且不得携带凭据、query 或 fragment。 |
| `BIND_ADDR` | 否 | `127.0.0.1:8080` | HTTP 监听地址。默认仅本机可访问。 |
| `RUST_LOG` | 否 | `info` | tracing 日志过滤。例：`debug`、`ai_search_platform=debug,tower_http=info`。 |
| `ALLOWED_HOSTS` | 否 | 空（不限制） | 可选的 `Host` 白名单，逗号分隔（如 `search.example.com,www.example.com`）。用于公网/反向代理部署防 DNS rebinding：绑定回环时，回环 Host 之外只放行白名单；绑定非回环时，**设置后才校验**（回环 Host 始终放行）。条目不区分大小写，忽略端口与末尾的点。 |
| `PLATFORM_PASSWD` | 否 | 空（不启用） | **可选访问密码**，值为 **Argon2id PHC 哈希**（不是明文）。设置后首页显示密码框，未验证无法调用搜索/抓取；登录换取 7 天有效 token。推荐用 `generate-passwd` 生成（或 `hash-password` 哈希自定义密码）。**写入 `.env` 时必须用单引号包裹**；留空 = 关闭该功能，行为与之前完全一致。详见[启用访问密码](#启用访问密码可选)。 |

\* 缺失 `DEEPSEEK_API_KEY` 时服务仍能启动：`/api/health`、`/api/config` 与静态页面正常，
但 `/api/search`、`/api/fetch` 返回 `502 upstream_not_configured`。

**`.env` 加载规则**：

- 只读取**当前工作目录**下的 `./.env`，不会向上级目录查找；缺失时静默跳过。
- 已存在的同名**环境变量优先于 `.env`**，不会被覆盖。
- `PLATFORM_PASSWD` 的哈希含 `$`，**在 `.env` 中必须用单引号包裹**
  （如 `PLATFORM_PASSWD='$argon2id$v=19$...'`），否则 dotenvy 会把 `$argon2id` 当变量展开。
- 生产环境建议直接注入环境变量（systemd `EnvironmentFile` / 容器 `-e` / 密钥管理）。

`.env` 最小示例：

```dotenv
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
BIND_ADDR=127.0.0.1:8080
RUST_LOG=info
# ALLOWED_HOSTS=search.example.com,www.example.com
# PLATFORM_PASSWD='$argon2id$v=19$m=19456,t=2,p=1$...$...'
```

**关键内置限额（节选）**：

- 缓存：TTL **1 天（86400 秒）**，最多 2000 条 / 256 MiB / 单条 8 MiB；
- 请求：请求体 ≤ 16 KiB、上游响应 ≤ 16 MiB、上游并发 8、上游超时 30 秒、整请求超时 90 秒；
- 限流：search / fetch 各 30 次/分钟/IP，登录 10 次/分钟/IP；
- `count` 默认 **50**、范围 1–50；`query` 最长 128 字符。

> 全部常量清单（含缓存清理间隔、各字段上限等）见
> [架构说明 · 编译期内置的默认值与限额](docs/ARCHITECTURE.md#编译期内置的默认值与限额)。

---

## 🔍 使用

### 搜索语法（8 个操作符）

在关键词中直接书写，可组合使用（示例中的引号为英文双引号 `"`）：

| # | 操作符 | 作用 | 示例 |
|---|---|---|---|
| 1 | `site:` | 限定站点 | `site:example.com 产品文档` |
| 2 | `-site:` | 排除站点 | `AI 搜索 -site:zhihu.com` |
| 3 | `-词` | 排除包含该词的结果 | `机器学习 -广告` |
| 4 | `-"短语"` | 排除完整短语 | `部署方案 -"限时优惠"` |
| 5 | `"精确短语"` | 要求完整包含该短语且顺序一致 | `"向量数据库 选型"` |
| 6 | `lang:` | 限定语言代码 | `lang:zh 大模型 应用` |
| 7 | `after:` | 只保留该日期之后发布的内容（`YYYY-MM-DD`） | `after:2025-01-01 前端框架` |
| 8 | `before:` | 只保留该日期之前发布的内容（`YYYY-MM-DD`） | `before:2026-01-01 人工智能` |

操作符由上游 DeepSeek 解析，本站只做长度与空值校验。界面「搜索语法」面板可一键插入示例。

### 高级参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `count` | integer | **50** | 返回结果条数，范围 1–50。 |
| `need_content` | boolean | `true` | 是否返回正文（`content` 字段）。关闭可显著减小响应体。 |
| `ori_question` | string | 空 | 原始用户问题，供上游做查询改写/增强，最长 128 字符。 |
| `localization` | string | 空 | 本地化位置，**必须是合法 IPv4/IPv6 地址**（如 `1.2.3.4`）。 |
| `force_refresh` | boolean | `false` | 跳过缓存读取，强制回源并覆盖写入。 |

完整请求/响应与错误码见 [API 参考 · POST /api/search](docs/API.md#post-apisearch)。

### URL 状态与分享

搜索状态同步到地址栏，格式为：

```
/?s=<Base64URL(UTF-8 关键词)>
```

- **Base64URL、无填充**（`-`/`_` 替代 `+/`，去掉尾部 `=`）。例：`人工智能` → `/?s=5Lq65bel5pm66IO9`。
- 打开带合法 `s` 的链接会**自动搜索**；提交新搜索用 `pushState` 更新地址栏，前进/后退可恢复。
- `s` 缺失 → 落地页；`s` 非法（解码失败、空串、原始参数 >4096 字符、解码后 >128 字符）→ 提示错误。
- 结果卡片的「复制分享链接」可直接复制当前搜索链接。

> ⚠️ **Base64 不是加密**：`?s=` 可被任何人解码，请勿把密钥或隐私放入搜索关键词
> （本站通过 `Referrer-Policy: no-referrer` 抑制外发 Referer）。

### 界面小技巧

- 按 <kbd>/</kbd> 快速聚焦搜索框；主题按钮在「跟随系统 → 浅色 → 深色」之间循环。
- 结果支持「抓取全文 / 长摘要 / 正文 / 原始 JSON」多种视图，正文与摘要按 Markdown 渲染。
- 单次最多展示 50 条结果（上游 `count` 上限，接口不支持分页）。

### 启用访问密码（可选）

默认不启用；启用后所有访问者共用一个密码（**单密码共享门禁，不是多用户账号体系**）。

**1. 生成密码与哈希**（推荐 `generate-passwd`：程序生成强随机密码，你只需保存）：

```bash
./target/release/ai-search-platform generate-passwd          # 源码构建
docker run --rm ghcr.io/shuaihaov/ai-search-platform:latest generate-passwd   # Docker
```

输出会同时给出**明文密码**和可直接粘贴的配置行（`PLATFORM_PASSWD='$argon2id$...'`）：

- 默认 20 个字符，可用 `--length 16-64` 调整；字符集排除易混字符（`0/O/o`、`1/l/I`）；
- 使用操作系统 CSPRNG + 拒绝采样；脚本场景可加 `--hash-only` 只输出配置行；
- 明文只显示这一次，请立即保存到密码管理器。

如要使用**自定义密码**（8–256 个字符），改为从 stdin 生成哈希：

```bash
printf '%s' '你的访问密码' | ./target/release/ai-search-platform hash-password
```

**2. 写入 `.env` 并重启**：

```dotenv
PLATFORM_PASSWD='$argon2id$v=19$m=19456,t=2,p=1$...$...'
```

> 哈希含大量 `$`，**必须用单引号包裹**，否则 dotenvy 会展开 `$argon2id` 导致启动失败。
> 通过容器 `-e`、systemd `EnvironmentFile` 注入时按字面值传递，不需要额外引号。

**3. 行为**：首页出现密码框，验证后进入；登录状态默认保持 **7 天**
（token 存于浏览器 localStorage 的 `ai-search-platform:auth-token`）。
登录接口独立限流 10 次/分钟/IP；token 过期后自动回到密码框；服务端无状态、改密码即全部失效。
完整的安全设计与行为细节见[安全白皮书 · 访问密码安全设计](docs/SECURITY.md#访问密码安全设计)、
[API 参考 · 登录](docs/API.md#post-apiauthlogin)。

## 🛡 安全

- **默认只监听回环**，默认无鉴权；公网部署必须置于 TLS 反向代理之后并加访问控制。
- 内置 CSRF 同源校验、严格 CSP（无 `unsafe-inline`）、SSRF 过滤、Host 白名单（`ALLOWED_HOSTS`）、
  按 IP 限流、请求/响应体积上限、密钥与密码哈希脱敏、panic 隔离。
- 可选**访问密码**门禁：Argon2id 哈希配置、7 天无状态 token、登录独立限流；
  token 存浏览器 localStorage（CSP 缓解 XSS 风险），单密码共享、**非多用户体系**。
- 已知限制（单实例缓存、token 存储、无服务端登出等）见
  [安全白皮书 · 已知限制](docs/SECURITY.md#已知限制)。

完整护栏明细与威胁模型：[docs/SECURITY.md](docs/SECURITY.md)；
漏洞**私密**报告流程：[SECURITY.md](SECURITY.md)。

---

## 📚 文档

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 项目简介、快速开始、配置与搜索语法（本文件） |
| [docs/API.md](docs/API.md) | **完整 API 参考**：端点、请求/响应示例、错误码表、curl 示例 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **架构说明**：请求链路、技术栈、目录结构、缓存设计、并发/限流模型、内置常量 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | **部署与运维**：反向代理示例（Caddy/nginx/Traefik）、systemd、Docker 生产建议、备份升级、故障排查 |
| [docs/SECURITY.md](docs/SECURITY.md) | **安全白皮书**：CSRF/SSRF/CSP/限流/Host 白名单/访问密码、威胁模型、已知限制 |
| [docs/AUDIT.md](docs/AUDIT.md) | 三轮安全审计摘要与修复记录 |
| [docs/RELEASING.md](docs/RELEASING.md) | 发布流程：版本号规则、发布前检查、打 tag、镜像策略、回滚 |
| [SECURITY.md](SECURITY.md) | 安全漏洞**私密报告流程**（请勿公开 Issue） |
| [CONTRIBUTING.md](CONTRIBUTING.md) / [CHANGELOG.md](CHANGELOG.md) | 贡献指南 / 版本变更记录 |

---

## 💻 开发

前置要求：Rust **1.88+**（edition 2024）、Node.js **≥ 20.19**、pnpm 9+；
Python 3.9+ 仅 mock/smoke 脚本需要。运行已构建的二进制不依赖 Node/Python。

```bash
make build      # 前端 + release 二进制（默认目标）
make run        # 运行 release 二进制（读取 ./.env）
make lint       # cargo fmt --check + clippy -D warnings + 前端 typecheck
make test       # cargo test + 前端 vitest
make smoke      # 端到端验收（自动起 mock 上游 + 被测二进制）
```

- 前后端分离开发：`make dev-backend`（:8080）+ `make dev-frontend`（Vite :5173，已配置 `/api` 代理）。
- 只会改后端时可 `make build-backend`；未装前端依赖也能 `cargo check`（`build.rs` 写占位页）。
- 修改前端后，release 嵌入的产物需重新 `make build`。
- 更多命令（`mock`、`docker-*`、`clean` 等）见 [CONTRIBUTING.md](CONTRIBUTING.md)、
  [架构说明](docs/ARCHITECTURE.md)。
- **遇到问题**：先看[部署与运维 · 故障排查](docs/DEPLOYMENT.md#故障排查)。

---

## 🤝 参与贡献

- 贡献流程、代码规范与提交前检查清单见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 发现安全漏洞请**不要**开公开 Issue，按 [SECURITY.md](SECURITY.md) 私密报告。
- 版本变更记录见 [CHANGELOG.md](CHANGELOG.md)；发布流程见 [docs/RELEASING.md](docs/RELEASING.md)。
- 欢迎 Issue / PR / Star ⭐

---

## 📄 License

本项目基于 [MIT License](LICENSE) 开源。

Copyright (c) 2026 shuaihaoV
