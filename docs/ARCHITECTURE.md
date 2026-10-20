# 架构说明

AI 搜索平台是单二进制交付的 Web 服务：**Rust（axum）后端 + Vite/React 前端**，
前端构建产物在 release 编译期被 `rust-embed` 嵌入二进制。本文件说明请求链路、技术栈、
目录结构、缓存与并发/限流模型，以及编译期内置的常量。

- 快速开始与配置见 [README](../README.md)
- 完整 HTTP 契约见 [API 参考](API.md)
- 安全设计见[安全白皮书](SECURITY.md)，部署见[部署与运维](DEPLOYMENT.md)

---

## 目录

- [请求链路](#请求链路)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [单二进制与前端嵌入](#单二进制与前端嵌入)
- [缓存设计](#缓存设计)
- [并发与限流模型](#并发与限流模型)
- [编译期内置的默认值与限额](#编译期内置的默认值与限额)

---

## 请求链路

```
┌──────────────────────────────────────────────────────────────┐
│                        浏览器（同源）                         │
│   GET /                      → 嵌入的 React SPA               │
│   POST /api/auth/login       → 访问密码 → token（可选）        │
│   POST /api/search           → 搜索（带缓存）                 │
│   POST /api/fetch            → 网页正文抓取（Markdown）       │
│   GET  /api/health|/config   → 健康检查 / 非敏感配置          │
└──────────────────────────┬───────────────────────────────────┘
                           │ 同源 HTTP（默认 127.0.0.1:8080）
┌──────────────────────────▼───────────────────────────────────┐
│                      Rust 单二进制（axum）                    │
│  安全层     Host 校验 · CSRF 头 · Origin 同源 · CSP · 限流     │
│             Bearer token 校验（启用访问密码时）                │
│  校验层     query ≤128 · count 1–50 · URL 与 SSRF 过滤         │
│  缓存层     SHA-256 键 · TTL 1 天 · 原子写 · 后台清理          │
│  上游层     Bearer 鉴权 · 并发 8 · 重试 1 次 · 响应 ≤16 MiB    │
└──────────────────────────┬───────────────────────────────────┘
                           │ Authorization: Bearer {DEEPSEEK_API_KEY}
              ┌────────────▼────────────┐
              │  DeepSeek Search / Fetch │
              │  POST /v1/tools/search   │
              │  POST /v1/tools/fetch    │
              └─────────────────────────┘
```

请求进入后依次经过：安全响应头 → 整请求超时（90 秒）→ 压缩 → panic 兜底 →
路由；`/api` 子树额外套 Host/CSRF 守卫、请求体上限（16 KiB）与按路由的限流/鉴权中间件。
静态资源与 SPA fallback 由 `rust-embed` 提供，不经过 `/api` 守卫。

---

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端语言 | Rust 1.88+（edition 2024） | release 开启 `lto="thin"`、`strip`；panic 由 `CatchPanicLayer` 兜底 |
| Web 框架 | axum 0.8 + tokio + tower-http | 路由、中间件、超时、压缩、panic 兜底 |
| 上游客户端 | reqwest（rustls，不依赖系统 OpenSSL） | 超时、重试、限体积读取；回环上游自动绕过系统代理 |
| 静态资源 | rust-embed | release 编译期把 `frontend/dist` 嵌入二进制 |
| 配置 | 环境变量 + `dotenvy` | 4 个常规变量 + 2 个可选加固（其余编译期常量） |
| 前端 | React 19 + Vite 8 + TypeScript 5.9 | 纯静态产物，无 Node 运行时依赖 |
| Markdown | react-markdown 10 + remark-gfm | `skipHtml`，无 `rehype-raw`，协议白名单 |
| 测试 | cargo test + vitest + smoke 脚本 | 单元/集成/端到端三层 |

---

## 目录结构

```
ai-search-platform/
├── Cargo.toml                  # Rust 依赖与 release 优化配置
├── build.rs                    # 确保 frontend/dist 存在（缺失时写占位页）
├── Makefile                    # 开发/构建/验收/容器命令（默认目标 build）
├── Dockerfile                  # 多阶段构建：前端 → Rust → distroless 运行时（nonroot）
├── docker-compose.yml          # 单服务部署（只读根文件系统、命名卷、健康检查）
├── .github/workflows/          # CI（fmt/clippy/test/前端构建）、镜像发布、Release
├── README.md / LICENSE / SECURITY.md / CONTRIBUTING.md / CHANGELOG.md
├── .env.example                # 6 个环境变量模板
├── docs/                       # 深入文档
│   ├── API.md                  # 完整 API 参考
│   ├── ARCHITECTURE.md         # 本文件：架构与实现
│   ├── DEPLOYMENT.md           # 部署与运维
│   ├── SECURITY.md             # 安全白皮书（根目录 SECURITY.md 是漏洞报告流程）
│   └── screenshots/            # README 截图
├── src/                        # Rust 后端
│   ├── main.rs                 # 启动、子命令（generate-passwd / hash-password）
│   ├── lib.rs                  # Router 组装（中间件层序）
│   ├── config.rs               # 环境变量解析 + 全部内置常量
│   ├── auth.rs                 # 可选访问密码：Argon2 校验、无状态 Token
│   ├── types.rs                # 请求/响应结构
│   ├── error.rs                # 统一错误体 + 状态码映射
│   ├── validation.rs           # 参数校验 + SSRF 地址过滤
│   ├── security.rs             # Host/CSRF/Origin 校验、限流、鉴权、安全响应头
│   ├── cache.rs                # 磁盘缓存：SHA-256 键、原子写、TTL、清理
│   ├── upstream.rs             # DeepSeek 客户端：鉴权、重试、限体积读取
│   ├── assets.rs               # 嵌入资源 + SPA fallback
│   └── routes/                 # health/config/auth/search/fetch 处理器
├── frontend/                   # Vite + React + TypeScript 前端
│   └── src/                    # 组件、API 客户端、URL 状态、Markdown 渲染
├── scripts/
│   ├── mock_upstream.py        # 本地 mock 上游（仅标准库）
│   ├── build.sh                # 前端 + 后端一键构建
│   └── smoke.sh                # 端到端验收
├── tests/api_integration.rs    # 后端集成测试
└── .cache/                     # 运行时缓存（gitignore，相对进程 CWD）
```

---

## 单二进制与前端嵌入

- **release**：`rust-embed` 在编译期把 `frontend/dist` 的全部文件嵌入二进制，
  运行时从内存提供，无需任何外部静态目录。
- **debug**：从磁盘读取 `frontend/dist`，改前端只需重新 `pnpm -C frontend build`，
  不必重编 Rust。
- `build.rs` 在 `frontend/dist` 缺失时写入占位页，保证 `cargo check` / `cargo test` 总能通过。

分发形态与镜像构建见[部署与运维](DEPLOYMENT.md#docker-生产建议)。

---

## 缓存设计

搜索结果与抓取结果默认写入本地磁盘缓存，无需外部缓存服务。

| 维度 | 设计 |
|---|---|
| 键 | 小写 16 进制 **SHA-256**（64 字符），输入是规范化 JSON：上游身份（base URL）+ 响应类别 + 所有影响结果的请求字段 |
| 关键词处理 | query 以 **Base64URL** 折入键，**文件名不出现原文** |
| 路径 | `./.cache/search/<64hex>.json`、`./.cache/fetch/<64hex>.json`（相对**进程 CWD**） |
| 内容 | 只存上游返回的 `data` 与元信息；不存 API Key、不存请求头 |
| 写入 | 临时文件 + `rename` 原子替换；Unix 下文件 `0600`、目录 `0700` |
| 过期 | 读取时按当前 TTL 重算判定；到期即视为 miss 并删除 |
| 清理 | 启动时先扫一次，之后每 600 秒扫一次；按 **2000 条 / 256 MiB / 单条 8 MiB** 收敛 |
| 失败降级 | 任何缓存读写错误都退化为 miss，绝不因缓存问题导致请求失败 |
| 强制刷新 | `force_refresh: true` 跳过读取，回源后覆盖写入 |

缓存目录默认是项目根目录下的 `.cache/`（取决于启动时的工作目录）。
手动清理：`rm -rf .cache` 或 `make clean`。缓存内容属于公开网页数据，多副本部署时各自独立。

---

## 并发与限流模型

- **运行时**：tokio 多线程；上游请求通过 `Semaphore` 限制并发 **8**，避免打爆出口或上游配额。
- **超时**：上游连接超时 10 秒、请求超时 30 秒；整请求由 `tower_http::timeout` 限制 **90 秒**。
- **重试**：仅对瞬态失败（408/429/5xx/网络错误）重试 **1 次**，退避 200ms × 2^attempt，
  并尊重上游 `Retry-After`（上限 2 秒）；不跟随重定向。
- **限流**：进程内、按客户端 IP 的固定 60 秒窗口，使用独立桶：
  - `search`：30 次/分钟/IP；
  - `fetch`：30 次/分钟/IP；
  - `login`：10 次/分钟/IP（防暴力破解）。
  超限返回 `429 rate_limited` + `Retry-After`。客户端 IP 仅在直连对端为回环（同机反代）时
  才信任 `X-Forwarded-For`。
- **缓存清理**：启动时与每 600 秒在阻塞线程池（`spawn_blocking`）执行全目录扫描，
  不阻塞异步 worker；同时清理过期条目与残留临时文件。
- **内存与体积约束**：请求体 ≤ 16 KiB、上游响应 ≤ 16 MiB、单条缓存 ≤ 8 MiB；
  响应 Gzip/Brotli 压缩；panic 由 `CatchPanicLayer` 转成 `500`，进程保持存活。
- **无流式响应**：两个业务接口均为一次性 JSON，受 90 秒整请求超时约束。

---

## 编译期内置的默认值与限额

除 6 个环境变量外，**所有参数都是编译期常量**（`src/config.rs`），有意不开放运行时修改，
避免误操作削弱安全边界：

| 项 | 值 | 说明 |
|---|---|---|
| `count` 默认值 / 范围 | **50** / 1–50 | 上游按请求计费而非按结果计费，因此默认取满 50 条以充实首页。 |
| `need_content` 默认值 | `true` | 搜索即返回正文（上游默认是 `false`），阅读体验更完整。 |
| `query` 长度上限 | 128 个 Unicode 字符 | 超出返回 `400 invalid_request`。 |
| `ori_question` 长度上限 | 128 字符 | 可选字段。 |
| `fetch.url` 长度上限 | 8192 字符 | 可选字段之外，仅接受绝对 `http(s)` URL。 |
| 缓存 TTL | **86400 秒（1 天）** | search 与 fetch 相同。 |
| 缓存规模 | 2000 条 / 256 MiB / 单条 8 MiB | 超出不写入；后台清理时从最旧（按修改时间）开始淘汰。 |
| 缓存清理 | 启动时 + 每 600 秒 | 同时清理过期条目与残留临时文件。 |
| 请求体上限 | 16 KiB | 超出返回 `413`。 |
| 限流 | 30 次/分钟/IP（search/fetch）；10 次/分钟/IP（login） | 独立计数。 |
| 上游超时 / 整请求超时 | 30 秒 / 90 秒 | 上游并发上限 8，瞬态失败重试 1 次。 |
| 上游响应上限 | 16 MiB | 超出视为上游响应异常。 |
| 访问密码长度 | 8–256 个字符（`hash-password`） | `generate-passwd` 生成 16–64 字符随机密码。 |
| Token 有效期 | 7 天（604800 秒） | 无状态 HMAC token，改密码即全部失效。 |

---

## 相关文档

- [API 参考](API.md) —— 端点、请求/响应、错误码、curl 示例
- [部署与运维](DEPLOYMENT.md) —— 反向代理、systemd、Docker 生产建议、故障排查
- [安全白皮书](SECURITY.md) —— 防护措施、威胁模型、已知限制
