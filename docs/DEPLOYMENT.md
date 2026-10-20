# 部署与运维

本文件面向生产部署：反向代理、systemd、Docker 建议、备份升级与故障排查。
本地开发与快速开始见 [README](../README.md)，安全设计见[安全白皮书](SECURITY.md)。

> ⚠️ **不要直接把本服务暴露到公网。** 默认 `BIND_ADDR=127.0.0.1:8080` 是有意为之；
> 本服务默认无鉴权，可选的 `PLATFORM_PASSWD` 只是**单密码共享门禁**，不替代反向代理的
> TLS 与访问控制。

---

## 目录

- [部署拓扑与安全默认值](#部署拓扑与安全默认值)
- [Docker 生产建议](#docker-生产建议)
- [systemd（裸机/虚拟机）](#systemd裸机虚拟机)
- [反向代理配置示例](#反向代理配置示例)
- [备份与升级](#备份与升级)
- [监控与日志](#监控与日志)
- [故障排查](#故障排查)

---

## 部署拓扑与安全默认值

推荐拓扑：

```
浏览器 ──TLS──> 反向代理（Caddy/nginx/Traefik）
                     │ 127.0.0.1:8080（保持真实 Host）
                     ▼
              ai-search-platform（单二进制 / 容器）
                     │ Bearer DEEPSEEK_API_KEY
                     ▼
              DeepSeek Search / Fetch API
```

部署前请确认：

1. **只监听回环**：`BIND_ADDR=127.0.0.1:8080`（默认），由反代对外；不要直接暴露 `0.0.0.0`。
2. **保持 `Host` 为对外域名**并设置 `ALLOWED_HOSTS=<对外域名>`：绑定回环时非回环 Host 默认被拒绝，
   白名单是「反代保持真实域名」场景的必要配置（见[安全白皮书](SECURITY.md#host-校验与-dns-rebinding)）。
3. **反代层访问控制**：Basic Auth / OAuth2 Proxy / mTLS / IP 白名单任选其一；
   内网场景也可启用应用内访问密码（`PLATFORM_PASSWD`）作为第二层。
4. **反代读写超时**：应用自身没有 HTTP 头部/请求体读取超时（仅限制解析完成后的处理时长 90s），
   裸奔在公网时存在 slowloris 风险，务必在反代配置 `read_header`/`read_body` 超时。
5. **密钥注入**：`DEEPSEEK_API_KEY`、`PLATFORM_PASSWD` 通过环境变量或密钥管理注入，
   不要把 `.env` 提交到仓库；`.env` 权限建议 `600`。

---

## Docker 生产建议

镜像与 compose 文件见仓库根目录的 `Dockerfile` / `docker-compose.yml`。

### 镜像

- 多阶段构建：Node 24 + pnpm 11 构建前端 → Rust 1.88 release 编译并 `rust-embed` 嵌入 `dist`
  → **distroless** 运行时（`gcr.io/distroless/cc-debian12:nonroot`，uid/gid **65532**，
  无 shell/包管理器，内置静态 busybox 便于排障）。
- 多架构：`linux/amd64` + `linux/arm64`；镜像实测约 **44.5 MB**（同 commit 两次构建有数十 KB
  ThinLTO 浮动，属正常）。
- 镜像 tag（CI 推送至 `ghcr.io/shuaihaov/ai-search-platform`）：
  `latest`（默认分支）、分支名、`vX.Y.Z` / `X.Y.Z` / `X.Y`（Git tag）、`sha-<short>`。

### 标准启动

```bash
cp .env.example .env
$EDITOR .env                 # 至少填入 DEEPSEEK_API_KEY
docker compose up -d --build
docker compose ps            # 期望 healthy
```

`docker-compose.yml` 已包含的生产默认值：

| 项 | 值 |
|---|---|
| 服务名 / 容器名 | `ai-search` |
| 宿主端口 | `127.0.0.1:8080`（`HOST_BIND` / `PORT` 可覆盖） |
| 容器内监听 | `BIND_ADDR=0.0.0.0:8080`（compose 强制覆盖，无需改 `.env`） |
| 缓存持久化 | 命名卷 `ai-search-cache` → `/app/.cache` |
| 权限 | 非 root（uid 65532）、只读根文件系统、`cap_drop: ALL`、`no-new-privileges` |
| 可写位置 | 仅缓存卷与 tmpfs `/tmp` |
| 健康检查 | 镜像内 busybox 请求 `/api/health` |
| 日志 | json-file 轮转（10 MB × 3） |
| 环境变量 | `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `RUST_LOG` / `ALLOWED_HOSTS` / `PLATFORM_PASSWD` |

常用操作：

```bash
docker compose logs -f ai-search      # 日志
docker compose down                   # 停止（缓存卷保留）
docker exec -it ai-search sh          # 进容器排障（busybox applet）
```

### 公网 / 自定义端口

```bash
HOST_BIND=0.0.0.0 PORT=8080 \
ALLOWED_HOSTS=search.example.com,www.example.com \
docker compose up -d
```

- 非回环绑定时，**只有设置了 `ALLOWED_HOSTS` 才会强制校验 `Host`**（未设置不校验，但启动日志会告警）。
- 公网部署请保留回环 + 反向代理，或在反代层完成 TLS 与访问控制。

### 启用访问密码（可选）

```bash
# 推荐：生成随机密码 + 可直接粘贴的配置行（不启动服务，仅一次性容器）
docker run --rm ghcr.io/shuaihaov/ai-search-platform:latest generate-passwd
# 或只输出配置行（适合脚本）
docker run --rm ghcr.io/shuaihaov/ai-search-platform:latest generate-passwd --hash-only

# 自定义密码：从 stdin 读取
printf '%s' '你的访问密码' | docker run --rm -i ghcr.io/shuaihaov/ai-search-platform:latest hash-password
```

把输出的 `PLATFORM_PASSWD='$argon2id$...'`（**含单引号**）写入 `.env`，然后重启：

```bash
docker compose up -d
```

> Argon2 哈希含 `$`，`.env` 中必须用单引号包裹，否则 dotenvy 会把它当变量替换导致启动失败。
> 通过容器 `-e` 或 systemd `EnvironmentFile` 注入时按字面值传递。详见
> README 的[启用访问密码](../README.md#启用访问密码可选)。

---

## systemd（裸机/虚拟机）

以专用用户运行（示例用户 `ai-search`，目录 `/opt/ai-search`）：

```ini
[Unit]
Description=AI Search Platform
After=network-online.target

[Service]
Type=simple
User=ai-search
WorkingDirectory=/opt/ai-search
EnvironmentFile=/etc/ai-search.env
ExecStart=/opt/ai-search/ai-search-platform
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/ai-search/.cache

[Install]
WantedBy=multi-user.target
```

要点：

- `EnvironmentFile=/etc/ai-search.env` 建议权限 `600`、属主为运行用户；
  systemd 不做 shell 变量展开，哈希中的 `$` 按字面值传递（加引号也可，但不要依赖 shell 转义）。
- `WorkingDirectory` 决定缓存目录 `./.cache` 的位置，必须对运行用户可写。
- 加固项可按需追加：`ProtectHome=true`、`RestrictAddressFamilies=AF_INET AF_INET6`、
  `MemoryMax=`、`LimitNOFILE=` 等。
- 升级：替换 BINARY 后 `systemctl restart ai-search`；缓存无需清理（键含上游身份）。

---

## 反向代理配置示例

通用要求：

- 反代把请求转发到 `127.0.0.1:8080`，并**保留对外真实 `Host`**；
- 设置 `ALLOWED_HOSTS=<对外域名>`（逗号分隔）；
- 反代与后端同机时，应用会信任 `X-Forwarded-For` 识别客户端 IP（仅直连对端为回环时）；
- 配置 `read_header` / `read_body` 超时，防范 slowloris。

### Caddy

```caddyfile
search.example.com {
    encode gzip zstd

    # 基础认证（可选；也可换成 OAuth2 Proxy / mTLS / IP 白名单）
    # basic_auth {
    #     user $2a$14$...  # caddy hash-password 生成的 bcrypt 哈希
    # }

    reverse_proxy 127.0.0.1:8080 {
        header_up Host {host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    timeouts {
        read_header 10s
        read_body   10s
    }
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name search.example.com;

    ssl_certificate     /etc/letsencrypt/live/search.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/search.example.com/privkey.pem;

    client_header_timeout 10s;
    client_body_timeout   10s;
    client_max_body_size  32k;   # 应用自身限制为 16 KiB

    # 可选访问控制
    # auth_basic           "AI Search";
    # auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 100s;   # 略大于应用整请求超时 90s
    }
}
```

### Traefik

```yaml
# 静态配置（traefik.yml）
entryPoints:
  websecure:
    address: ":443"
    transport:
      respondingTimeouts:
        readTimeout:  10s
        writeTimeout: 100s
        idleTimeout:  120s
```

```yaml
# 动态配置（file provider）
http:
  routers:
    ai-search:
      rule: "Host(`search.example.com`)"
      entryPoints: [websecure]
      service: ai-search
      tls: {}
  services:
    ai-search:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:8080"
```

> Traefik 默认保留原始 `Host`；若使用中间件改写 Host，请同步调整 `ALLOWED_HOSTS`。

---

## 备份与升级

### 需要备份

| 内容 | 是否必须 | 说明 |
|---|---|---|
| 环境变量 / secret（`DEEPSEEK_API_KEY`、`PLATFORM_PASSWD` 哈希、`ALLOWED_HOSTS`） | **是** | 丢失后需重新配置；密码哈希丢失只能重新生成（旧 token 失效） |
| `.cache/`（或容器命名卷） | 否 | 丢了只会变慢，不会丢数据；内容为公开网页缓存 |
| 日志 | 视需求 | 默认输出 stdout，由系统/容器日志驱动负责轮转 |

### 升级步骤

1. 备份当前环境变量/secret 与（可选）缓存卷；
2. 替换二进制（或拉取新镜像 `docker compose pull && docker compose up -d`）；
3. 重启并健康检查：`curl -s http://127.0.0.1:8080/api/health`；
4. 检查 `/api/config` 的 `upstream.configured` 与 `auth.enabled` 是否符合预期；
5. 缓存键包含上游身份与请求参数，升级无需手动清理。

### 回滚

单二进制 + 无数据库，回滚只需换回旧二进制/镜像 tag 并重启；若同时回滚了
`PLATFORM_PASSWD`，此前签发的 token 会失效，用户需重新输入密码。

---

## 监控与日志

- **存活探针**：`GET /api/health` → `{"status":"ok","version":"0.1.0"}`；
  Docker 镜像与 compose 已内置 healthcheck。
- **日志**：stdout，`RUST_LOG` 控制（默认 `info`）；容器 compose 已配置文件轮转。
- **关键指标**（建议在反代/日志层采集）：
  - 本地 `429 rate_limited` 与上游 `429 upstream_rate_limited` 比例；
  - 上游 `5xx` / `upstream_timeout` 比例；
  - 缓存命中率（响应中的 `cache_status`）。
- **审计安全事件**：启用访问密码后，`401 unauthorized` / `401 invalid_password` 与登录
  限流触发次数值得关注（日志中不会出现密码或 token）。

```bash
RUST_LOG=debug ./ai-search-platform
RUST_LOG=ai_search_platform=debug,tower_http=info ./ai-search-platform
```

---

## 故障排查

### 构建相关

| 现象 | 原因与处理 |
|---|---|
| 找不到 `frontend/dist` / `rust-embed` 编译失败 | 先 `make frontend`；`build.rs` 只在缺失时写占位页 |
| `pnpm install --frozen-lockfile` 失败 | lockfile 与 `package.json` 不一致；`scripts/build.sh` 会自动回退普通 `pnpm install`，也可手动 `make install` |
| `cargo build` 卡在下载依赖 | 需要代理：`export http_proxy=... https_proxy=...`（按本机实际代理端口） |
| `cargo build --release` 很慢 | release 开启 `lto="thin"` + `codegen-units=1`，首次全量编译偏慢属正常；日常迭代用 `cargo check` |
| Node 版本报错 | Vite 8 需要 Node ≥ 20.19，`node --version` 确认并升级 |

### 运行相关

| 现象 | 原因与处理 |
|---|---|
| 访问返回 403「服务仅绑定回环地址」 | 绑定回环时只接受 loopback Host；反向代理保持真实域名时需设置 `ALLOWED_HOSTS=<域名>` |
| 访问返回 403「Host 不在 ALLOWED_HOSTS 白名单内」 | `ALLOWED_HOSTS` 与反代传入的 `Host` 不一致；确认域名拼写、是否带端口/末尾点，或临时清空该变量 |
| `/api/search` 返回 `502 upstream_not_configured` | 没设置 `DEEPSEEK_API_KEY`；填入 `.env` 后重启（`.env` 只在启动时加载一次） |
| 明明没配 Key 却 `configured=true` | `env \| grep DEEPSEEK` 确认当前 shell 是否已导出变量（环境变量优先于 `.env`）；服务只读 CWD 的 `./.env` |
| `/api/search` 返回 `502 upstream_auth_failed` | Key 无效或过期；确认空格/引号，以及是否指向期望的上游 |
| 返回 `429 rate_limited` | 本地限流 30 次/分钟/IP；等待或降低频率，重启进程可清零 |
| 返回 `429 upstream_rate_limited` | 上游限流，按 `retry_after_seconds` / `Retry-After` 退避 |
| 返回 `504 upstream_timeout` | 上游慢或网络不通；用 mock 的 `slow` 场景复现；检查代理与出口 |
| 搜索永远 `cached=false` | 缓存目录不可写（权限/只读文件系统），或请求带了 `force_refresh`；看日志「缓存目录就绪」的路径 |
| 二次请求仍回源 | 两次请求体不完全一致（`force_refresh`、`count`、`need_content` 等均进键）；确认是同一 CWD 的缓存目录 |
| 页面是「前端尚未构建」占位页 | debug 构建且 `frontend/dist` 只有占位页；执行 `make frontend` 后重启 |
| 页面样式丢失 / 资源 404 | release 二进制嵌入的是构建时的 `dist`；前端改动后必须重新构建后端 |
| 启动报「PLATFORM_PASSWD 必须是以 `$argon2id$` 开头…」 | `.env` 中哈希未加单引号被 dotenvy 展开，或误填了明文；用 `generate-passwd` 或 `hash-password` 重新生成，并以 `PLATFORM_PASSWD='$argon2id$...'` 写入 |
| 首页一直停在密码框 / 搜索返回 `401 unauthorized` | token 已过期或密码已更换；重新输入密码即可。若确认密码正确仍失败，检查服务端 `/api/config` 的 `auth.enabled` |
| 登录返回 `429 rate_limited` | 登录限流 10 次/分钟/IP；按 `retry_after_seconds` / `Retry-After` 等待后重试 |
| 忘记访问密码 | Argon2 哈希不可逆；重新执行 `generate-passwd` 生成新密码与哈希替换后重启（旧 token 全部失效） |
| 需要进入容器排障 | 运行镜像是 distroless，但内置 busybox applet：`docker exec -it ai-search sh` 即可获得 sh/ls/cat/grep 等常用命令 |

### 验收相关

| 现象 | 原因与处理 |
|---|---|
| `make smoke` 提示「未找到可执行文件」 | 先 `make build`（smoke 默认用 `target/release/ai-search-platform`） |
| `make smoke` 在启动应用处失败 | 端口占用或配置错误；脚本会打印应用日志尾部，也可手动指定 `BIND_ADDR` 复现 |
| mock 上游端口冲突 | 默认自动选空闲端口；手动指定 `MOCK_PORT` 时需确保未被占用 |

---

## 相关文档

- [README](../README.md) —— 项目简介、快速开始、配置与搜索语法
- [API 参考](API.md) —— 端点、请求/响应、错误码、curl 示例
- [架构说明](ARCHITECTURE.md) —— 请求链路、技术栈、缓存与并发/限流模型
- [安全白皮书](SECURITY.md) —— 防护措施、威胁模型、已知限制
- [漏洞报告流程](../SECURITY.md) —— 私密报告安全漏洞
