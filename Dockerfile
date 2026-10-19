# =============================================================================
# AI 搜索平台 —— 生产级多阶段镜像
#
# 阶段 1 (frontend): Node 24 + pnpm 构建 Vite SPA → frontend/dist
# 阶段 2 (backend):  Rust 1.88 构建 release 二进制，rust-embed 编译期嵌入 dist
# 阶段 3 (runtime):  Debian slim，非 root、只读根文件系统友好，仅暴露 8080
#
# 多架构说明：
#   * 前端产物与 CPU 架构无关，固定在构建机平台 ($BUILDPLATFORM) 只构建一次；
#   * Rust 阶段跟随目标平台 ($TARGETPLATFORM)，buildx 会自动选择对应架构的
#     rust 基础镜像，因此无需交叉工具链即可产出 linux/amd64 与 linux/arm64；
#   * 依赖 aws-lc-rs（reqwest 的 rustls 加密后端），它是 C 实现，构建阶段
#     需要 cmake + make + C 编译器（rust:slim 自带 gcc）。
#
# 本地构建：
#   docker build -t ai-search-platform:dev .
# 多架构构建并推送：
#   docker buildx build --platform linux/amd64,linux/arm64 -t <image> --push .
#
# 注意：本文件使用 BuildKit 的缓存挂载（RUN --mount=type=cache）加速依赖编译，
# 需要 BuildKit。Docker 23+ / buildx 默认启用；旧版本请设置 DOCKER_BUILDKIT=1。
# =============================================================================

ARG NODE_VERSION=24
ARG RUST_VERSION=1.88
ARG DEBIAN_CODENAME=bookworm
ARG PNPM_VERSION=11.22.0

# -----------------------------------------------------------------------------
# 阶段 1：前端构建（Vite + React + TypeScript）
# -----------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-${DEBIAN_CODENAME}-slim AS frontend

ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

# 安装与 pnpm-lock.yaml 匹配的 pnpm 主版本，保证 --frozen-lockfile 可复现
RUN npm install --global "pnpm@${PNPM_VERSION}" \
 && pnpm --version

WORKDIR /build/frontend

# 先只拷贝清单文件：依赖未变时可复用 pnpm 缓存层
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile

# 再拷贝源码并构建（pnpm build = typecheck + vite build）
COPY frontend/ ./
RUN pnpm build \
 && test -f dist/index.html

# -----------------------------------------------------------------------------
# 阶段 2：Rust 后端构建（release；前端产物在编译期被 rust-embed 嵌入）
# -----------------------------------------------------------------------------
FROM rust:${RUST_VERSION}-slim-${DEBIAN_CODENAME} AS backend

ARG TARGETARCH

# aws-lc-rs（rustls 的加密实现）需要 cmake / make / C 编译器；
# rust:slim 已自带 gcc 与 perl，这里只补缺失的两项。
# 版本不固定：基础镜像已固定 Debian 发行版，构建阶段依赖无需逐个 pin。
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake make \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# 依赖清单先入层，配合 cargo 缓存挂载加速重复构建
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY tests ./tests

# build.rs 要求 frontend/dist 存在；release 编译时 rust-embed 读取并嵌入它
COPY --from=frontend /build/frontend/dist ./frontend/dist

RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-target-${TARGETARCH},target=/src/target \
    cargo build --release --locked --bin ai-search-platform \
 && install -D -m 0755 target/release/ai-search-platform /out/ai-search-platform

# -----------------------------------------------------------------------------
# 阶段 3：运行时（distroless）
#
# 选择 gcr.io/distroless/cc-debian12:nonroot 的原因：
#   * 只含 glibc / libgcc / CA 证书，没有 shell 与包管理器，攻击面最小；
#   * 自带 ca-certificates（/etc/ssl/certs/ca-certificates.crt），
#     rustls-platform-verifier 在 Linux 上依赖它校验上游 HTTPS（必需）；
#   * 默认非 root（nonroot = uid/gid 65532）；
#   * 本机实测约 34MB，显著小于 debian:bookworm-slim（约 97MB）。
# 代价：镜像内没有 shell，HEALTHCHECK 借助静态 busybox；排障时执行
#   docker exec -it <container> /busybox sh
# -----------------------------------------------------------------------------

# 静态 busybox：提供 healthcheck 用的 wget，以及一个最小排障 shell。
# 常用 applet 软链到 /usr/local/bin，使 `docker exec -it <container> sh` 直接可用；
# 所有软链都指向同一个 /busybox 二进制，几乎不增加镜像体积。
FROM busybox:1.37.0-musl AS tools

RUN mkdir -p /app/.cache/search /app/.cache/fetch /debug-bin \
 && for applet in sh cat ls grep sed awk id ps wget rm cp mv mkdir touch \
      head tail tar gzip find chmod chown df du sleep date env; do \
      ln -s /busybox "/debug-bin/${applet}"; \
    done

FROM gcr.io/distroless/cc-debian12:nonroot AS runtime

ARG APP_UID=65532
ARG APP_GID=65532

LABEL org.opencontainers.image.title="AI 搜索平台" \
      org.opencontainers.image.description="AI-powered web search / fetch platform (Rust + embedded SPA)" \
      org.opencontainers.image.source="https://github.com/shuaihaoV/ai-search-platform" \
      org.opencontainers.image.licenses="MIT"

COPY --from=tools /bin/busybox /busybox
# 排障用 applet 软链（全部指向 /busybox）：sh/cat/ls/grep/wget/ps/... 可直接用
COPY --from=tools /debug-bin/ /usr/local/bin/

# 缓存目录：CWD=/app 且 src/config.rs 中 CACHE_DIR="./.cache" => /app/.cache。
# 预先创建并授权给非 root 用户，空命名卷首次创建时会继承该属主。
# （若改用 bind mount，需要宿主侧 chown -R 65532:65532。）
COPY --from=tools --chown=${APP_UID}:${APP_GID} /app /app

WORKDIR /app
COPY --from=backend /out/ai-search-platform /usr/local/bin/ai-search-platform

# 应用配置全部通过环境变量注入（共 5 个，详见 README）：
#   DEEPSEEK_API_KEY  上游 API Key（缺失时服务可启动，搜索/抓取返回 503）
#   DEEPSEEK_BASE_URL 上游 Base URL（默认官方地址）
#   RUST_LOG          日志级别
#   BIND_ADDR        监听地址；容器内默认 0.0.0.0:8080，否则端口映射不可达
#   ALLOWED_HOSTS     可选，逗号分隔的 Host 白名单（公网/反代部署建议设置）
ENV BIND_ADDR=0.0.0.0:8080 \
    RUST_LOG=info

EXPOSE 8080
USER 65532:65532

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/busybox", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/api/health"]

ENTRYPOINT ["/usr/local/bin/ai-search-platform"]
