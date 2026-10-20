# 发布流程

本文档描述 AI Search Platform 的版本规则、发布前检查、打 tag、镜像 tag 策略、
Release Notes 写法与回滚方式。适用于维护者；贡献者请优先阅读
[CONTRIBUTING.md](../CONTRIBUTING.md)。

- 仓库：<https://github.com/shuaihaoV/ai-search-platform>
- 镜像：`ghcr.io/shuaihaov/ai-search-platform`
- 相关 workflow：[`ci.yml`](../.github/workflows/ci.yml)、
  [`docker.yml`](../.github/workflows/docker.yml)、
  [`release.yml`](../.github/workflows/release.yml)

---

## 1. 发布模型

一次发布由**推送一个 `v*` 注解 tag** 触发，两条流水线并行：

| Workflow | 触发 | 产出 |
|---|---|---|
| `ci.yml` | push main / PR / 手动 | 质量门禁（不产出制品） |
| `docker.yml` | tag `v*`、push main、PR（仅 amd64 校验，不推送） | 多架构镜像推送到 GHCR |
| `release.yml` | tag `v*` 或手动指定已有 tag | GitHub Release + 各平台二进制 tar.gz 与 `.sha256` |

发布后可交付的内容：

- GitHub Release 附件（3 个平台）：
  - `ai-search-platform-<tag>-x86_64-unknown-linux-gnu.tar.gz`
  - `ai-search-platform-<tag>-aarch64-unknown-linux-gnu.tar.gz`
  - `ai-search-platform-<tag>-aarch64-apple-darwin.tar.gz`
- 多架构镜像 `ghcr.io/shuaihaov/ai-search-platform:<tag>`

> ⚠️ 本仓库**不开源 Windows 构建**，也不提供 macOS x86_64 二进制。

---

## 2. 版本号规则

遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/) `MAJOR.MINOR.PATCH`。

### 2.1 当前阶段

项目处于 **0.x**：`0.MINOR.PATCH`。

- `0.1.0` → `0.2.0`：新增功能或**破坏性变更**（0.x 阶段允许在 MINOR 中破坏兼容，但必须在
  CHANGELOG 与 Release Notes 中明确标注）。
- `0.2.0` → `0.2.1`：仅向后兼容的缺陷修复与安全修补。
- 进入 `1.0.0` 后切换为严格 SemVer：MAJOR 才允许破坏性变更。

### 2.2 什么算破坏性变更

满足任一条件即视为 breaking，**必须升 MINOR（0.x）或 MAJOR（1.x+）**：

- 修改或删除 `/api/*` 的请求/响应字段、错误码、状态码语义
- 修改缓存键构成导致旧缓存失效（可接受，但要说明）
- 删除或重命名环境变量；改变默认值（如 `BIND_ADDR`、`need_content`）
- 修改 `/api/config` 的结构或字段含义
- 修改 `?s=` URL 契约
- 改变镜像内的默认路径、端口、用户或 CMD/ENTRYPOINT

### 2.3 版本号必须同步的位置

`scripts/check-structure.sh` 会校验这三处一致，任一处不一致 `make release-check` 直接失败：

| 位置 | 字段 | 示例 |
|---|---|---|
| `Cargo.toml` | `[package] version` | `version = "0.1.0"` |
| `frontend/package.json` | `"version"` | `"version": "0.1.0"` |
| `CHANGELOG.md` | 最新已发布版本标题 | `## [0.1.0] - 2026-10-19` |

`Cargo.lock` 由 `cargo build` / `cargo update -p ai-search-platform` 自动更新，不要手改。
若 README 徽章或示例中出现版本号，发布时一并检查（不强制）。

发布时把 `CHANGELOG.md` 的 `## [Unreleased]` 内容整理为
`## [X.Y.Z] - YYYY-MM-DD`，并新建空的 `## [Unreleased]` 段。

---

## 3. 发布前检查清单

### 3.1 本地一键检查（推荐）

```bash
git switch main
git pull --ff-only

# 一条命令跑完全部发布前检查（结构 + 后端强检查 + 前端全套）
make release-check
```

`make release-check` 依次执行：

1. `bash scripts/check-structure.sh`（必含文件、版本一致性、敏感文件未被跟踪）
2. `cargo fmt --all -- --check`
3. `cargo clippy --all-targets --all-features --locked -- -D warnings`
4. `cargo test --locked --all-targets`
5. `pnpm -C frontend typecheck`
6. `pnpm -C frontend test -- --run`
7. `pnpm -C frontend build`

### 3.2 手工补充检查

这些项不在 `release-check` 里（耗时或依赖环境），发版前请人工确认：

```bash
# 端到端验收（真实启动服务 + mock 上游，验证缓存/CSRF/CSP 等 52 项断言）
make build && make smoke

# Docker 构建与健康检查（本机 Docker 可用时）
docker build -t ai-search-platform:rc .
docker run --rm -d --name aisp-rc -p 18080:8080 \
  -e DEEPSEEK_API_KEY=dummy -e BIND_ADDR=0.0.0.0:8080 ai-search-platform:rc
curl -fsS http://127.0.0.1:18080/api/health   # {"status":"ok","version":"X.Y.Z"}
docker rm -f aisp-rc

# 多架构镜像配置语法
docker compose config -q

# MSRV 门禁（CI 用 1.88.0；本机没装该工具链时 CI 会兜底）
rustup toolchain install 1.88.0 --profile minimal
cargo +1.88.0 check --locked
```

### 3.3 CI 门禁（必须全绿）

| Job | 内容 |
|---|---|
| `Rust（fmt / clippy / test）` | Rust 1.97.1：fmt、clippy -D warnings、全部测试 |
| `Rust MSRV（1.88.0）` | `cargo check --locked` 在最低支持版本通过 |
| `Frontend（typecheck / test / build）` | Node 24 + pnpm 11.22.0，frozen lockfile |
| `Docker / PR` | 仅 amd64 构建验证 Dockerfile，不推送 |

### 3.4 发版前人工确认

- [ ] `CHANGELOG.md` 的 `[Unreleased]` 已整理为本次版本号与日期
- [ ] 三处版本号一致（`make release-check` 已覆盖）
- [ ] `.env.example` 覆盖全部环境变量且注释准确
- [ ] 若新增环境变量：`README.md` / `docs/` 已更新，且未泄露任何真实值
- [ ] 若改 API：`docs/API.md` 与前端调用同步
- [ ] 若改安全逻辑（CSRF/CSP/SSRF/鉴权/限流）：已单独复核并有测试覆盖
- [ ] `git status` 干净，没有误提交 `.env`、`.cache/`、`frontend/dist/`、`target/`
- [ ] 已确认本次版本号未在远端被占用：`git ls-remote --tags origin | grep vX.Y.Z`
- [ ] 破坏性变更已在 PR / CHANGELOG 中标注迁移方式

---

## 4. 打 tag 与推送

打 **annotated tag**（附注 tag），不要打 lightweight tag——`git describe`、签名与
Release Notes 都依赖附注信息。

```bash
# 1) 确认在干净的最新 main 上
git switch main
git pull --ff-only
git status --short          # 应为空

# 2) 打附注 tag（消息用一句话说明本次发布主题）
git tag -a v0.1.0 -m "AI Search Platform v0.1.0"

# 3) 推送 tag（只推这一个 tag，避免误推其它本地 tag）
git push origin v0.1.0
```

推送后 GitHub Actions 自动开始：

1. `release.yml` 先创建 GitHub Release（已存在则跳过），再按平台矩阵构建并上传附件
   （`--clobber`，同一 tag 可重复运行补传）；
2. `docker.yml` 构建 amd64 + arm64 镜像，按 digest 推送后用 `imagetools` 合并为多架构 manifest。

### 4.1 手工补发 / 重跑

- 只想补二进制：Actions → **Release** → Run workflow，输入已存在的 tag（如 `v0.1.0`）。
- 只想重建镜像：重跑 **Docker** workflow 的对应 tag run（或在本地构建后手动推送）。
- **不要**删除并重建同名 tag：会破坏已发布附件与镜像 tag 的对应关系；确需修正请发新补丁版本。

### 4.2 Release Notes 生成方式

`release.yml` 的 `create-release` job 会基于 git 历史生成基础 notes（如 `--generate-notes`），
上传附件不覆盖描述。建议在推送 tag 前先准备好正文（§6），tag 推送后到 Release 页面补充。

---

## 5. 镜像 tag 策略

`docker.yml` 用 `docker/metadata-action@v5` 生成标签，最终推送到
`ghcr.io/shuaihaov/ai-search-platform`：

| 触发 | 生成的 tag | 说明 |
|---|---|---|
| push `main` | `latest` | 仅默认分支，表示最新稳定开发态 |
| push `main` | `main` | 分支名 tag，便于固定到分支快照 |
| push tag `v0.1.0` | `v0.1.0` | 与 git tag 完全一致 |
| push tag `v0.1.0` | `0.1.0` | semver 全量版本 |
| push tag `v0.1.0` | `0.1` | semver major.minor，自动跟随该系列最新补丁 |
| 任意 push | `sha-<短哈希>` | 不可变，适合精确回溯 |
| PR | 不推送 | 仅构建 amd64 验证 Dockerfile |

使用建议：

```bash
# 生产：固定到精确版本（推荐，可复现）
docker pull ghcr.io/shuaihaov/ai-search-platform:0.1.0

# 只跟随 0.1 系列补丁（含安全修复）
docker pull ghcr.io/shuaihaov/ai-search-platform:0.1

# 开发体验最新
docker pull ghcr.io/shuaihaov/ai-search-platform:latest
```

> `latest` **不保证**向后兼容，生产环境请使用精确版本或 `major.minor`。
> 镜像同时支持 `linux/amd64` 与 `linux/arm64`（原生 arm64 runner 构建，非 QEMU）。

---

## 6. Release Notes 写法

面向**使用者**，不是 commit log。结构建议：

```markdown
# vX.Y.Z

一句话说明本次发布主题（例如：新增可选访问密码，修复缓存并发写问题）。

## 亮点

- 用 2–4 条说明最值得升级的功能，每条附使用方式或截图链接

## 新增

- ...（对应 CHANGELOG 的「新增」）

## 变更 / 修复

- ...（行为变化、缺陷修复、性能优化）

## 安全

- ...（安全加固或漏洞修复；修复类漏洞**发布后**再披露细节）

## 升级说明

- 是否有破坏性变更？如何迁移（命令、配置、API 调用示例）
- 是否需要清理缓存（`rm -rf .cache`）？是否需要重建镜像？
- 环境变量是否有新增/删除

## 校验

- 镜像：`ghcr.io/shuaihaov/ai-search-platform:X.Y.Z`
- 二进制附件：`ai-search-platform-vX.Y.Z-<target>.tar.gz` + 同名 `.sha256`
- 校验示例：`sha256sum -c ai-search-platform-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz.sha256`

**完整变更**：<https://github.com/shuaihaoV/ai-search-platform/compare/vPREV...vX.Y.Z>
```

要点：

- 标题就是版本号，不加日期前缀。
- 「升级说明」必须存在，哪怕是「无破坏性变更，直接替换二进制/镜像即可」。
- 安全修复不要贴可直接利用的 PoC；先让用户升级。
- 与 `CHANGELOG.md` 保持一致，但 Release Notes 可以更面向使用者、更精简。

---

## 7. 回滚

### 7.1 镜像回滚（最快）

```bash
# compose：把 IMAGE_TAG 固定回上一个稳定版本
IMAGE_TAG=0.1.0 docker compose up -d
# 或直接指定更早的 sha tag（完全不可变）
IMAGE_TAG=sha-abc1234 docker compose up -d
```

注意事项：

- 回滚镜像**不会**回滚 `.cache/` 中的缓存。若新版本改了缓存键/结构，旧版本会自然 miss
  并重建；若出现异常，`rm -rf .cache` 后重启即可（缓存是纯加速层，删除无数据损失）。
- `docker-compose.yml` 以 `IMAGE_TAG` 变量选择镜像；生产建议固定精确版本。

### 7.2 二进制回滚

```bash
# 下载上一个版本的附件，校验后替换
tar -xzf ai-search-platform-v0.1.0-x86_64-unknown-linux-gnu.tar.gz
sudo install -m 0755 ai-search-platform /opt/ai-search/ai-search-platform
sudo systemctl restart ai-search
```

### 7.3 代码回滚

```bash
# 推荐：为回滚发一个补丁版本（不改写历史、不影响已发布 tag）
git revert --no-commit <bad-commit> && git commit -m "revert: ..."
# 然后按 §4 发 vX.Y.(Z+1)
```

**不要** `git push --force` 到 `main`，**不要**移动或删除已发布的 tag——会破坏
镜像 tag、Release 附件与用户锁定的版本对应关系。

### 7.4 发布事故处理

1. 立刻在 GitHub Release 页面顶部标注「⚠️ 该版本存在严重问题，请升级到 vX.Y.Z+1」。
2. 修复后在 CHANGELOG / Release Notes 中说明影响范围与补救措施。
3. 若是安全漏洞：按 [SECURITY.md](../SECURITY.md) 走私密流程，修复发布后再公开细节。

---

## 8. 发布后验证

```bash
# 1) Release 附件存在且校验文件可用
gh release view vX.Y.Z --repo shuaihaoV/ai-search-platform

# 2) 镜像 manifest 同时包含 amd64 与 arm64
docker buildx imagetools inspect \
  ghcr.io/shuaihaov/ai-search-platform:X.Y.Z

# 3) 拉取并验证版本号与健康检查
docker run --rm -d --name aisp-verify -p 18081:8080 \
  -e DEEPSEEK_API_KEY=dummy -e BIND_ADDR=0.0.0.0:8080 \
  ghcr.io/shuaihaov/ai-search-platform:X.Y.Z
curl -fsS http://127.0.0.1:18081/api/health
curl -fsS http://127.0.0.1:18081/api/config | head -c 300
docker rm -f aisp-verify

# 4) 页面可用（前端确实被嵌入）
curl -fsS http://127.0.0.1:18081/ | grep -q '<div id="root"' && echo "frontend embedded OK"
```

验证无误后，在 Release 页面把预发布标记（如勾选了 Pre-release）摘掉。

---

## 9. 常见问题

| 现象 | 原因与处理 |
|---|---|
| `release-check` 报版本不一致 | 三处版本号未同步，见 §2.3 |
| `release-check` 报敏感文件被跟踪 | 误 `git add` 了 `.env` / `.cache`，执行 `git rm --cached <file>` 并确认 `.gitignore` 覆盖 |
| `release.yml` 报 already exists | Release 已创建；附件用 `--clobber` 覆盖，重跑即可 |
| 镜像 tag 没有 `0.1` | 只有 `v*` tag 才生成 semver tag；分支构建只有 `main`/`latest`/`sha-*` |
| arm64 镜像构建失败 | 确认仓库可用 `ubuntu-24.04-arm` runner；私有仓库配额不足时按 `docker.yml` 注释裁剪矩阵 |
| MSRV job 失败 | 新依赖抬高了最低 Rust 版本；要么换依赖，要么同步提高 `Cargo.toml` 的 `rust-version` 并更新 CI 与 Dockerfile |
| 发布后发现漏了文档 | 文档可单独提交 PR 更新，不必为此重发版本；涉及行为说明时才补发补丁版本 |
