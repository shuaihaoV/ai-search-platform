# API 参考

AI 搜索平台对外提供同源 JSON API，默认监听 `http://127.0.0.1:8080`。

- 响应均为 JSON（静态资源除外）；`/api/*` 响应统一带 `Cache-Control: no-store`。
- 所有请求都会校验 `Host`；`POST` 还需通过 CSRF 头校验（见[通用约定](#通用约定)）。
- 本文件是完整参考；快速上手与配置见 [README](../README.md)，安全设计见[安全白皮书](SECURITY.md)。

---

## 目录

- [通用约定](#通用约定)
- [`GET /api/health`](#get-apihealth)
- [`GET /api/config`](#get-apiconfig)
- [`POST /api/auth/login`](#post-apiauthlogin)
- [`POST /api/search`](#post-apisearch)
- [`POST /api/fetch`](#post-apifetch)
- [缓存元信息](#缓存元信息)
- [错误结构与错误码](#错误结构与错误码)
- [curl 示例](#curl-示例)

---

## 通用约定

**POST 请求必须同时满足**以下条件（满足 CSRF 防护）：

| 要求 | 请求头 | 不满足时 |
|---|---|---|
| 自定义头 | `X-Requested-With: ai-search-platform` | `403 forbidden` |
| JSON 内容类型 | `Content-Type: application/json` | `403 forbidden` |
| 同源 | `Origin` 若存在必须与 `Host` 同源 | `403 forbidden` |
| 非跨站 | `Sec-Fetch-Site` 若存在必须为 `same-origin`/`none` | `403 forbidden` |

其他约定：

- 所有 `/api/*` 请求都会校验 `Host`（拒绝重复 Host、非法字符；绑定回环时只接受回环主机名）。
- 请求体上限 **16 KiB**，超出返回 `413 payload_too_large`。
- 请求体**拒绝未知字段**（`deny_unknown_fields`），多余字段会返回 `400 invalid_request`。
- **鉴权（可选）**：`PLATFORM_PASSWD` 为空时无鉴权（适用于本机/内网或反代后场景）。启用后：
  - **公开**：`GET /api/health`、`GET /api/config`、`POST /api/auth/login` 与静态资源；
  - **受保护**：`POST /api/search`、`POST /api/fetch`，需带 `Authorization: Bearer <token>`
    （也接受 `X-Platform-Token: <token>`，便于调试）；缺失、无效或过期返回 `401 unauthorized`；
  - token 由登录接口签发，有效期 **7 天（604800 秒）**，服务端无状态；修改密码后全部旧 token 失效；
  - 单密码共享不替代多用户体系，公网部署仍建议由反向代理完成 TLS 与访问控制
    （见[安全白皮书](SECURITY.md)、[部署与运维](DEPLOYMENT.md)）。

---

## `GET /api/health`

```http
GET /api/health
```

```json
{ "status": "ok", "version": "0.1.0" }
```

适合作为容器/负载均衡的存活探针。

---

## `GET /api/config`

只返回非敏感运行信息，**绝不返回 API Key**：

```json
{
  "version": "0.1.0",
  "defaults": {
    "count": 50,
    "need_content": true,
    "ori_question": "",
    "localization": ""
  },
  "limits": {
    "count_min": 1,
    "count_max": 50,
    "query_max_chars": 128,
    "ori_question_max_chars": 128,
    "fetch_url_max_chars": 8192
  },
  "cache": {
    "search_enabled": true,
    "search_ttl_seconds": 86400,
    "fetch_enabled": true,
    "fetch_ttl_seconds": 86400
  },
  "upstream": { "configured": true },
  "auth": { "enabled": false }
}
```

`upstream.configured` 表示是否检测到 `DEEPSEEK_API_KEY`；`auth.enabled` 表示是否启用了访问密码
（只返回布尔值，**不泄露哈希**、不泄露 token）。

---

## `POST /api/auth/login`

访问密码**未启用**时该端点返回 `404 not_found`（不对外暴露自身）。

请求（同样需要 CSRF 头与 JSON Content-Type）：

```json
{ "password": "你的访问密码" }
```

成功响应 `200`：

```json
{
  "token": "v1.1766086400.<base64url-hmac-sha256>",
  "expires_at": 1766086400
}
```

- `token` 格式为 `v1.<expiry_unix>.<base64url_hmac_sha256>`，有效期 **7 天（604800 秒）**；
  示例中的 token 为占位符，不是可用凭证；
- 请求体只接受 `password` 字段（拒绝未知字段），密码不会写入日志或响应；
- 错误：密码错误 → `401 invalid_password`；登录过于频繁（10 次/分钟/IP）→ `429 rate_limited`；
- 成功响应带 `Cache-Control: no-store`。

如何生成访问密码哈希、写入 `.env` 并启用门禁，见 README 的
[启用访问密码](../README.md#启用访问密码可选)。

---

## `POST /api/search`

> 启用访问密码时，本接口需要 `Authorization: Bearer <token>`（或 `X-Platform-Token`），
> 否则返回 `401 unauthorized`（见[通用约定](#通用约定)）。

请求体（除 `query` 外均可省略）：

```json
{
  "query": "Rust 异步编程",
  "count": 10,
  "ori_question": "（可选）原始用户问题",
  "localization": "（可选）IPv4/IPv6 地址",
  "need_content": true,
  "force_refresh": false
}
```

成功响应 `200`：

```json
{
  "cached": false,
  "cache_status": "miss",
  "cache_age_seconds": 0,
  "stored_at": 1766000000,
  "expires_at": 1766086400,
  "upstream_status": 200,
  "elapsed_ms": 823,
  "data": {
    "results": [
      {
        "rerank_score": 0.97,
        "title": "Rust 异步编程完全指南",
        "url": "https://example.com/rust-async",
        "snippet": "搜索结果摘要……",
        "summary": "AI 生成的要点总结……",
        "content": "正文 Markdown（need_content=true 时返回）",
        "site_name": "Example 技术博客",
        "site_icon": "https://example.com/favicon.ico",
        "date": "2025-11-02",
        "authority": 3
      }
    ]
  }
}
```

`data` 原样透传上游响应；`results` 中各字段可能缺失或为 `null`，前端会做防御性归一化：

| 字段 | 类型 | 说明 |
|---|---|---|
| `rerank_score` | number | 上游重排分数（越大越相关，UI 以 ≥ 1.5 标记高质量）。 |
| `title` | string | 结果标题。 |
| `url` | string | 原文链接（仅 `http(s)` 可点击）。 |
| `snippet` | string | 搜索摘要。 |
| `summary` | string | AI 生成的要点总结（Markdown）。 |
| `content` | string | 正文（`need_content: true` 时返回，Markdown）。 |
| `site_name` | string | 站点名称。 |
| `site_icon` | string | 站点图标 URL。 |
| `date` | string | 发布时间（原始字符串）。 |
| `authority` | number | 权威度整数 `0–4`；`-1` 或缺失表示未知。 |

### 请求参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 搜索关键词，最长 128 个 Unicode 字符，支持 8 个搜索操作符（见 [README](../README.md#-使用)）。 |
| `count` | integer | **50** | 返回结果条数，范围 1–50。 |
| `need_content` | boolean | `true` | 是否返回正文（`content` 字段）。关闭可显著减小响应体。 |
| `ori_question` | string | 空 | 原始用户问题，供上游做查询改写/增强，最长 128 字符。 |
| `localization` | string | 空 | 本地化位置，**必须是合法的 IPv4/IPv6 地址**（例如 `1.2.3.4`），否则返回 `400`。 |
| `force_refresh` | boolean | `false` | 跳过缓存读取，强制回源并覆盖写入。 |

---

## `POST /api/fetch`

> 启用访问密码时同样需要 `Authorization: Bearer <token>`（或 `X-Platform-Token`），
> 否则返回 `401 unauthorized`。

请求体：

```json
{ "url": "https://example.com/page", "force_refresh": false }
```

成功响应 `200`，外层与 `/api/search` 相同，`data` 为：

```json
{ "title": "页面标题", "content": "# 标题\n\n正文 **Markdown**" }
```

`url` 必须是绝对 `http(s)` URL，且不能是内网/回环/保留地址（SSRF 防护，见[安全白皮书](SECURITY.md#ssrf-防护)）。

---

## 缓存元信息

`/api/search` 与 `/api/fetch` 的每个成功响应都带以下字段（`data` 之外）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `cached` | boolean | 本次是否命中缓存。 |
| `cache_status` | string | `hit` / `miss`。 |
| `cache_age_seconds` | number | 命中时为缓存已存活秒数，未命中为 0。 |
| `stored_at` / `expires_at` | number | Unix 秒；`expires_at - stored_at` 恒为 TTL（86400）。 |
| `upstream_status` | number | 上游 HTTP 状态码（命中缓存时为写入时的状态码）。 |
| `elapsed_ms` | number | 本次上游耗时；命中缓存时为 `0`。 |

`force_refresh: true` 会跳过读取缓存，强制回源并覆盖写入。

---

## 错误结构与错误码

所有错误（含 `403`/`404`/`429`/`5xx`）统一为：

```json
{
  "error": {
    "code": "upstream_rate_limited",
    "message": "上游限流，请稍后重试",
    "retryable": true,
    "upstream_status": 429,
    "retry_after_seconds": 2
  }
}
```

- `upstream_status` / `retry_after_seconds`：无对应信息时为 `null`。
- `message` 截断到 512 字符；上游 `error.message` 会被提取并截断到 300 字符。
- 存在 `retry_after_seconds` 时同时回写 `Retry-After` 响应头。

| HTTP | `code` | 触发场景 |
|---|---|---|
| `400` | `invalid_request` | 参数缺失/越界（query 空或 >128 字符、count 不在 1–50、url 非法、未知字段等）。 |
| `401` | `unauthorized` | 启用访问密码时，搜索/抓取缺少、无效或过期的 token。 |
| `401` | `invalid_password` | 登录接口密码错误。 |
| `403` | `forbidden` | 缺 `X-Requested-With`、非 JSON Content-Type、Origin 跨站、Host 校验失败、SSRF 目标（内网/回环/保留地址）。 |
| `403` | `upstream_forbidden` | 上游返回 403。 |
| `404` | `not_found` | 未知 API 路径；或访问密码未启用时的 `/api/auth/login`（均返回 JSON 错误体）。 |
| `404` | `upstream_not_found` | 上游返回 404 / 页面无法获取。 |
| `402` | `upstream_payment_required` | 上游返回 402（余额不足）。 |
| `413` | `payload_too_large` | 请求体 > 16 KiB 或上游返回 413。 |
| `429` | `rate_limited` | 本地限流（search/fetch 30 次/分钟/IP；登录 10 次/分钟/IP）。 |
| `429` | `upstream_rate_limited` | 上游限流（带 `retry_after_seconds`）。 |
| `502` | `upstream_not_configured` | 未设置 `DEEPSEEK_API_KEY`。 |
| `502` | `upstream_auth_failed` | 上游 401（Key 无效或过期）。 |
| `502` | `upstream_invalid_response` | 上游返回非 JSON、结构异常或响应体超限。 |
| `502` | `upstream_error` | 其它上游错误（含网络错误、上游 4xx/5xx）。 |
| `504` | `upstream_timeout` | 上游 408/504 或上游超时（30 秒）。 |
| `500` | `internal_error` | 未预期的内部错误。 |

`retryable` 为 `true` 的只有：`rate_limited`、`upstream_rate_limited`、`upstream_timeout`、
`upstream_error`、`internal_error`。

> 整请求超过 90 秒时由超时中间件直接返回 `504`（无 JSON 错误体），这属于兜底行为。

---

## curl 示例

```bash
# 健康检查
curl -s http://127.0.0.1:8080/api/health

# 读取公开配置
curl -s http://127.0.0.1:8080/api/config

# 搜索（POST 必须带 CSRF 头 + JSON Content-Type）
curl -s -X POST http://127.0.0.1:8080/api/search \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-With: ai-search-platform' \
  -d '{"query":"Rust 异步编程","count":3}'

# 启用访问密码时：先登录换取 token，再在搜索/抓取请求中携带
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-With: ai-search-platform' \
  -d '{"password":"你的访问密码"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -s -X POST http://127.0.0.1:8080/api/search \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-With: ai-search-platform' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"Rust 异步编程","count":3}'

# 抓取网页全文
curl -s -X POST http://127.0.0.1:8080/api/fetch \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-With: ai-search-platform' \
  -d '{"url":"https://example.com"}'
```

---

## 相关文档

- [README](../README.md) —— 项目简介、快速开始、配置与搜索语法
- [架构说明](ARCHITECTURE.md) —— 请求链路、技术栈、缓存与并发/限流模型
- [部署与运维](DEPLOYMENT.md) —— 反向代理、systemd、Docker 生产建议、排障
- [安全白皮书](SECURITY.md) —— 防护措施、威胁模型、已知限制
- [漏洞报告流程](../SECURITY.md) —— 私密报告安全漏洞
