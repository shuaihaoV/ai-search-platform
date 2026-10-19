# 贡献指南

感谢你愿意为 **AI 搜索平台**（ai-search-platform）贡献代码、文档或反馈！
本文档说明本地开发、代码规范与提交前检查，帮助你的 PR 更快被合并。

> 🔐 **发现安全漏洞？** 请不要开公开 Issue，按 [SECURITY.md](SECURITY.md) 走私密报告通道。

---

## 目录

- [行为准则](#行为准则)
- [环境要求](#环境要求)
- [本地开发](#本地开发)
- [分支与提交规范](#分支与提交规范)
- [代码规范](#代码规范)
- [测试](#测试)
- [提交前检查清单](#提交前检查清单)
- [Pull Request 流程](#pull-request-流程)
- [发布流程](#发布流程维护者)
- [License](#license)

---

## 行为准则

- 保持友善、就事论事；对事不对人。
- 尊重不同的经验水平与语言习惯（Issues/PR 可用中文或英文）。
- 不提交他人的私有信息、真实 API Key、生产环境数据。
- 不进行未经授权的安全测试；安全研究请遵守 [SECURITY.md](SECURITY.md)。

---

## 环境要求

| 依赖 | 版本 | 用途 |
|---|---|---|
| Rust | **1.88+**（edition 2024） | 后端 |
| Node.js | **≥ 20.19**（Vite 8 要求） | 前端构建 |
| pnpm | 9+（开发使用 11.x） | 前端包管理 |
| Python | 3.9+ | 仅 mock 上游与 smoke 脚本（纯标准库） |
| curl | 任意 | smoke 验收 |
| Docker（可选） | 20.10+ | 容器构建 / 本地验证 |

运行**已构建的二进制**不需要 Node/Python/pnpm。

---

## 本地开发

```bash
# 1. fork 后克隆
git clone https://github.com/<your-name>/ai-search-platform.git
cd ai-search-platform

# 2. 配置（至少填 DEEPSEEK_API_KEY；本地联调可指向 mock）
cp .env.example .env
$EDITOR .env

# 3. 安装依赖并构建
make install          # 前端依赖
make build            # 前端 → 嵌入 → release 二进制

# 4. 运行
make run              # http://127.0.0.1:8080
```

前后端分离开发（两个终端）：

```bash
make dev-backend      # 终端 1：cargo run，默认 127.0.0.1:8080
make dev-frontend     # 终端 2：Vite dev server，http://127.0.0.1:5173
```

前端开发期通过 Vite proxy 把 `/api` 转发到 `127.0.0.1:8080`（`changeOrigin: false`，
保持 Host 一致，避免触发 Host 校验）。

**无需真实 API Key 的联调**：

```bash
make mock             # 终端 0：本地 mock 上游 127.0.0.1:9000
DEEPSEEK_API_KEY=test-key \
DEEPSEEK_BASE_URL=http://127.0.0.1:9000 \
make run
```

**注意前端改动与嵌入**：

- `debug` 构建从磁盘读取 `frontend/dist`，重新 `pnpm -C frontend build` 即可生效；
- `release` 构建由 `rust-embed` 在编译期嵌入，**改前端后必须重新 `make build`**。

---

## 分支与提交规范

- 从 `main` 切出分支，命名建议：`feat/<topic>`、`fix/<topic>`、`docs/<topic>`、`chore/<topic>`。
- 一个 PR 只做一件事；避免混入无关格式化/重构。
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
feat(api): 新增 /api/config 的 fetch_url_max_chars
fix(cache): 修复过期条目在时钟回拨时被误删
docs(readme): 补充 Docker 部署说明
chore(ci): 升级 actions/checkout 到 v5
```

常用类型：`feat` / `fix` / `docs` / `refactor` / `test` / `perf` / `chore`。
破坏性变更请在提交信息 body 中写 `BREAKING CHANGE:`。

---

## 代码规范

### Rust（`src/`、`tests/`）

- 遵循 `cargo fmt`，不使用未格式化的代码。
- `cargo clippy --all-targets --all-features -- -D warnings` 必须零警告。
- **请求路径上禁止 `unwrap()` / `expect()`**（测试代码除外）：错误必须转成 `AppError`，
  不允许 panic 放大成 500。
- 新的输入必须校验长度/类型/协议；新的外部 URL 处理必须考虑 SSRF。
- 所有限制优先做成**编译期常量**（`src/config.rs`），不要随意增加环境变量——
  环境变量只保留必要项（当前 4 个常规变量 + 1 个可选加固 `ALLOWED_HOSTS`），
  这是项目的设计取舍。
- 新增日志避免输出密钥、请求头或缓存内容。

### 前端（`frontend/`）

- TypeScript strict；**禁止 `as any`、`@ts-ignore`**。
- 禁止内联 `style`（严格 CSP 不允许 `unsafe-inline`），样式统一写在 CSS。
- 渲染上游文本一律按文本/Markdown 安全链路处理，不得使用 `dangerouslySetInnerHTML`。
- 链接必须经过协议白名单（仅 `http/https`），`javascript:`/`data:` 等一律拒绝。
- 保持无障碍：可键盘操作、对话框焦点管理、必要的 `aria-*`。
- 修改后必须通过 `pnpm -C frontend typecheck`、`pnpm -C frontend test -- --run`、`pnpm -C frontend build`。

### 文档

- README/命令必须与实际 `Makefile`、`Cargo.toml` 保持一致。
- 新增接口/环境变量/错误码时，同步更新 README 的 API 与配置章节。

---

## 测试

```bash
make lint      # cargo fmt --check + clippy -D warnings + 前端 typecheck
make test      # cargo test + 前端 vitest
make smoke     # 端到端验收：自动起 mock 上游 + release 二进制，逐项断言
```

- 后端集成测试：`tests/api_integration.rs`（缓存、CSRF、SSRF、限流、错误映射、静态资源等）。
- 前端单测：`frontend/src/test/`（URL 状态、Base64、Markdown 安全、主题、校验等）。
- 涉及安全逻辑（`src/security.rs`、`src/validation.rs`、`src/cache.rs`、`src/assets.rs`）的改动
  **必须**补充或更新测试，尤其是拒绝路径（负向用例）。

---

## 提交前检查清单

- [ ] `make fmt`（或 `cargo fmt`）已执行
- [ ] `make lint` 通过
- [ ] `make test` 通过
- [ ] `make build` 通过（含前端构建）
- [ ] `make smoke` 通过（改动 API/缓存/安全逻辑时必跑）
- [ ] 没有提交 `.env`、密钥、`.cache/`、`target/`、`frontend/dist/`
- [ ] 新增/修改的行为已更新 README / CHANGELOG
- [ ] 提交信息符合 Conventional Commits

---

## Pull Request 流程

1. 先开 Issue 讨论较大改动（新功能、行为变更、破坏性变更），避免白做。
2. 在 PR 描述中说明：**做了什么、为什么、如何验证**，关联相关 Issue。
3. CI 必须全绿（Rust fmt/clippy/test、前端 typecheck/test/build、镜像构建）。
4. 至少一位维护者 review 通过后合并；维护者可能要求拆分 PR 或补充测试。
5. 合并后你的改动会出现在下一个版本的 [CHANGELOG](CHANGELOG.md) 中。

---

## 发布流程（维护者）

1. 更新 `CHANGELOG.md`，确认版本号与 `Cargo.toml` / `frontend/package.json` 一致。
2. 打 tag 并推送：`git tag v0.1.0 && git push origin v0.1.0`。
3. CI 自动构建多架构镜像（`linux/amd64`、`linux/arm64`）并推送 GHCR，创建 GitHub Release。
4. 发布后核对镜像 digest、健康检查与 Release 附件。

---

## License

本项目使用 [MIT License](LICENSE)。提交 Pull Request 即表示你同意以相同许可证授权你的贡献。
