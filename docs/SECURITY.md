# 安全白皮书

本文件说明 AI 搜索平台的安全设计、威胁模型与已知限制。
**漏洞报告流程**见根目录的 [SECURITY.md](../SECURITY.md)（请勿公开 Issue）。

- 快速开始与配置见 [README](../README.md)
- HTTP 契约见 [API 参考](API.md)
- 部署加固见[部署与运维](DEPLOYMENT.md)

---

## 目录

- [威胁模型与信任边界](#威胁模型与信任边界)
- [防护措施总览](#防护措施总览)
- [Host 校验与 DNS Rebinding](#host-校验与-dns-rebinding)
- [CSRF 防护](#csrf-防护)
- [SSRF 防护](#ssrf-防护)
- [CSP 与安全响应头](#csp-与安全响应头)
- [限流与资源上限](#限流与资源上限)
- [访问密码安全设计](#访问密码安全设计)
- [已知限制](#已知限制)

---

## 威胁模型与信任边界

以下设计是**有意的**，发现与这些前提相关的问题时请一并说明：

- **默认只听回环**：`BIND_ADDR` 默认为 `127.0.0.1:8080`。绑定回环时，所有请求的
  `Host` 必须是 `localhost` / `127.0.0.1` / `[::1]` 等回环名，否则返回 `403`。
- **默认无鉴权**：可选启用**单密码访问门禁**（`PLATFORM_PASSWD`，Argon2id 哈希，
  非多用户账号体系）。未设置时行为与 0.1.0 完全一致；公网部署仍应叠加反向代理访问控制。
- **可选的 Host 白名单**：`ALLOWED_HOSTS`（逗号分隔域名）用于公网/反向代理部署防 DNS rebinding。
  绑定回环时非回环 Host 只有命中白名单才放行（因此反代保持真实域名时必须设置）；
  绑定非回环时，设置后才强制校验（回环 Host 始终放行，保证同机健康检查可用）。
  未设置且绑定非回环时，启动日志会告警「Host 头无法校验」。
- **密钥处理**：`DEEPSEEK_API_KEY` 只用于向上游发送 `Authorization: Bearer`，不会出现在
  `/api/config`、日志或错误响应中；`PLATFORM_PASSWD` 的哈希同样在 `Config` 的 `Debug`
  输出中固定脱敏，`/api/config` 只返回 `auth.enabled` 布尔值。
- **缓存**：仅保存上游返回的公开网页/搜索结果数据（不含 API Key、请求头），
  文件权限 `0600`、目录 `0700`；缓存键为 SHA-256，关键词以 Base64URL 折入键中，
  **文件名不含明文关键词**。
- **部署边界**：应用自身不终止 TLS、不做多用户鉴权、不保证抗 DDoS；这些由反向代理与
  基础设施承担（见[部署与运维](DEPLOYMENT.md)）。

---

## 防护措施总览

| 风险 | 缓解措施 |
|---|---|
| **CSRF** | ① POST 必须带自定义头 `X-Requested-With: ai-search-platform`（跨站表单无法设置）；② 必须 `Content-Type: application/json`；③ `Origin` 存在时必须与 `Host` 同源（拒绝 `null`/空/带路径/带凭据）；④ `Sec-Fetch-Site` 存在时只接受 `same-origin`/`none`。 |
| **Host 头攻击 / DNS Rebinding** | 解析并校验 `Host`：拒绝重复 Host、非法端口/控制字符/异常标签；绑定回环时只接受 loopback 主机名；`ALLOWED_HOSTS` 可配置域名白名单（绑定非回环时设置后强制校验，回环 Host 始终放行）。 |
| **XSS** | 严格 CSP（无 `unsafe-inline`/`unsafe-eval`，详见下节）；`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、COOP/CORP `same-origin`、`Permissions-Policy` 收紧、`X-Robots-Tag: noindex`。 |
| **上游内容 XSS** | 搜索结果的 `title`/`snippet`/`summary` 按文本渲染；`content` 与 fetch 的 Markdown 用 `react-markdown` + `skipHtml`，HTML 当文本不执行；`javascript:`/`data:` 等链接被过滤。 |
| **SSRF** | `/api/fetch` 只接受 `http/https`，拒绝 URL 内嵌凭据；拦截回环、私有网段、链路本地（含 `169.254.169.254` 云元数据）、CGNAT、ULA、IPv4-mapped IPv6 等，命中返回 `403`；上游客户端**不跟随重定向**。 |
| **限流** | 每 IP 每分钟 **30 次**（search/fetch 独立计数）；登录接口独立 **10 次/分钟**；客户端 IP 仅在直连对端为回环（同机反代）时才信任 `X-Forwarded-For`。 |
| **资源耗尽** | 请求体 ≤ 16 KiB；上游响应 ≤ 16 MiB；上游并发 ≤ 8；上游超时 30 秒、整请求 90 秒；query ≤ 128 字符；错误 `message` 截断。 |
| **访问控制（可选）** | 设置 `PLATFORM_PASSWD` 后启用访问密码：只存 Argon2id PHC 哈希（非明文，启动时校验格式，非法即拒绝启动）；登录用常量时间校验；成功后签发 7 天有效的无状态 token；token 仅保存在浏览器 localStorage，不落 URL/日志；登录接口独立限流；不使用 Cookie，CSRF 暴露面不变。**未设置时该功能完全惰性**。 |
| **信息泄露** | `/api/config` 只暴露非敏感项（`auth.enabled` 仅布尔值）；错误信息不透出内部路径；API Key 与密码哈希在 `Config` 的 `Debug` 输出中固定脱敏；`.env`、`.cache`、`target`、`frontend/dist` 均在 `.gitignore`。 |
| **panic 隔离** | `CatchPanicLayer` 把 handler panic 转成 `500`，进程保持存活继续服务（release profile 未启用 `panic = "abort"`）。 |

---

## Host 校验与 DNS Rebinding

- `Host` 会被完整解析：拒绝重复 Host、非法端口、控制字符/空白、异常 DNS 标签；
  支持 `host:port` 与 `[IPv6]:port` 形式。
- **绑定回环**时：只接受回环主机名，或命中 `ALLOWED_HOSTS` 白名单的域名。
- **绑定非回环**时：未设置白名单则不校验（启动日志告警）；设置后强制校验，
  回环 Host 始终放行（保证同机健康检查）。
- 典型场景：反向代理保持对外真实域名 → 必须设置 `ALLOWED_HOSTS=<对外域名>`，否则返回 `403`。

相关排障见[部署与运维](DEPLOYMENT.md#故障排查)。

---

## CSRF 防护

应用不使用 Cookie，鉴权 token 由前端显式附加到请求头，因此 CSRF 暴露面不因启用访问密码而变化。
所有 `POST /api/*`（含 `/api/auth/login`）必须同时满足：

| 要求 | 请求头 | 不满足时 |
|---|---|---|
| 自定义头 | `X-Requested-With: ai-search-platform` | `403 forbidden` |
| JSON 内容类型 | `Content-Type: application/json` | `403 forbidden` |
| 同源 | `Origin` 若存在必须与 `Host` 同源 | `403 forbidden` |
| 非跨站 | `Sec-Fetch-Site` 若存在必须为 `same-origin`/`none` | `403 forbidden` |

请求体上限 16 KiB，且拒绝未知字段（`deny_unknown_fields`）。

---

## SSRF 防护

`/api/fetch` 的 `url` 在转发给上游前会做严格校验：

- 仅接受绝对 `http` / `https` URL，拒绝 URL 内嵌用户名/密码；
- 拦截：回环地址、私有网段（`10/8`、`172.16/12`、`192.168/16`）、链路本地（含
  `169.254.169.254` 云元数据）、CGNAT `100.64/10`、ULA `fc00::/7`、链路本地 IPv6 `fe80::/10`、
  IPv4-mapped IPv6、文档/保留/组播地址等；
- 内部域名后缀（`.local`、`.internal`、`.home.arpa`、`.localdomain` 等）同样拒绝；
- 命中返回 `403 forbidden`；上游客户端**不跟随重定向**（避免 3xx 绕过）。

---

## CSP 与安全响应头

所有响应（含错误响应、静态资源）都会带上：

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' https: data:; font-src 'self'; connect-src 'self';
  object-src 'none'; base-uri 'none'; frame-ancestors 'none';
  form-action 'none'; media-src 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(),
  magnetometer=(), microphone=(), payment=(), usb=()
X-Robots-Tag: noindex, nofollow
X-Dns-Prefetch-Control: off
```

前端不使用内联 `style`/`script`，也不需要 `unsafe-inline`/`unsafe-eval`；
上游 Markdown 通过 `react-markdown` + `skipHtml` 渲染，HTML 一律当作文本。

---

## 限流与资源上限

- 进程内、按客户端 IP 的固定 60 秒窗口，独立桶：search 30 次/分钟、fetch 30 次/分钟、
  登录 10 次/分钟；超限返回 `429 rate_limited` + `Retry-After`。
- 客户端 IP 仅在直连对端为回环（同机反代）时才信任 `X-Forwarded-For`；
  多副本部署时各副本独立计数（不共享）。
- 请求体 ≤ 16 KiB、上游响应 ≤ 16 MiB、单条缓存 ≤ 8 MiB、上游并发 ≤ 8；
  上游超时 30 秒、整请求超时 90 秒；query ≤ 128 字符。

---

## 访问密码安全设计

可选功能，未设置 `PLATFORM_PASSWD` 时完全惰性。

- **凭据存储**：只保存 **Argon2id PHC 哈希**（m=19456, t=2, p=1，随机盐），不保存明文；
  启动时校验哈希格式，非法即启动失败（不会静默降级为无密码）。
- **登录**：`POST /api/auth/login` 用常量时间校验密码，成功后签发 token；
  密码错误返回 `401 invalid_password`，登录限流 10 次/分钟/IP。
- **Token**：`v1.<expiry_unix>.<base64url(HMAC-SHA256)>`，有效期 7 天（604800 秒）；
  无状态，服务端不保存会话，重启不失效；签名密钥由密码哈希派生，**改密码即全部旧 token 失效**。
- **传输与存储**：token 仅通过请求头 `Authorization: Bearer`（或 `X-Platform-Token`）传递，
  不写 URL、不写日志；浏览器端存于 `localStorage`（键 `ai-search-platform:auth-token`），
  明文密码不落任何持久化存储。CSP 与渲染防护用于缓解 XSS 窃取 token 的风险。
- **吊销**：无服务端登出/吊销接口；登出 = 清除浏览器 localStorage，或改密码使全部 token 失效。
- **使用方式**：`generate-passwd`（推荐，随机生成密码+哈希）或 `hash-password`（自定义密码，
  从 stdin 读取）。写入 `.env` 时哈希必须用**单引号**包裹，避免 dotenvy 的 `$` 变量替换。
  完整步骤见 [README](../README.md#启用访问密码可选)。

---

## 已知限制

1. **单实例**：缓存是本地目录，没有分布式锁与共享；多副本部署时各副本独立缓存、
   不共享限流计数。
2. **单密码共享，非多用户体系**：启用 `PLATFORM_PASSWD` 后所有访问者共用一个密码，
   没有账号、角色、按用户配额或审计日志；公网部署仍需反向代理访问控制。
3. **`need_content: true` 响应更大但计费不变**：默认返回全文使响应体显著变大
   （受 16 MiB 上游上限与 8 MiB 单条缓存上限约束），带宽敏感场景可显式传 `need_content: false`。
4. **Base64 不是加密**：URL 里的 `?s=` 可被任何人解码，等同于明文关键词。
5. **限流是进程内、按 IP 的固定窗口**：重启即清零；`X-Forwarded-For` 仅在直连对端为回环时可信。
6. **缓存上限硬编码**（2000 条 / 256 MiB / 单条 8 MiB），不可通过环境变量调整。
7. **无流式响应**：两个业务接口都是一次性 JSON，受 90 秒整请求超时约束。
8. **不跟随重定向**：上游或抓取目标返回 3xx 时按失败处理（安全优先，避免 SSRF 绕过）。
9. **Host 白名单依赖部署拓扑**：反向代理保持真实域名时，`BIND_ADDR` 绑定回环也必须设置
   `ALLOWED_HOSTS`，否则请求会因 Host 校验返回 `403`。
10. **token 存储在浏览器 localStorage**：CSP 与前端渲染防护已降低 XSS 风险，但一旦发生 XSS，
    token 可被读取（有效期最长 7 天）；修改密码可立即使全部 token 失效。
11. **无服务端登出/吊销接口**：token 是无状态的，只能等过期或修改 `PLATFORM_PASSWD` 使全部失效；
    登录限流是进程内固定窗口，重启清零、多副本不共享。
12. **应用自身无 TLS/抗 DDoS/多用户鉴权**：这些能力必须由反向代理与基础设施提供，
    并注意配置反代读写超时以防范 slowloris（见[部署与运维](DEPLOYMENT.md#反向代理配置示例)）。

---

## 相关文档

- [漏洞报告流程](../SECURITY.md) —— GitHub Security Advisory 私密报告
- [部署与运维](DEPLOYMENT.md) —— 反向代理、systemd、Docker 生产建议、排障
- [API 参考](API.md) —— 鉴权相关端点与错误码
- [架构说明](ARCHITECTURE.md) —— 请求链路与并发/限流模型
