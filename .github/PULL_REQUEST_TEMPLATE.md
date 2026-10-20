# Pull Request

感谢贡献！请先确认本 PR 聚焦单一目的（一个功能 / 一个修复 / 一次文档改进），
并在提交前完成下方自测清单。详细规范见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 变更描述

<!-- 用一两句话说明「改了什么」以及「为什么改」。关联 Issue 请写 Closes #123。 -->

- 关联 Issue：Closes #
- 变更摘要：

## 变更类型

<!-- 勾选一项或多项（把 [ ] 改成 [x]） -->

- [ ] 🐛 Bug 修复（向后兼容）
- [ ] ✨ 新功能（向后兼容）
- [ ] 💥 破坏性变更（需要同步更新文档、CHANGELOG 与 API 契约）
- [ ] ♻️ 重构 / 性能优化（不改变外部行为）
- [ ] 📝 文档（README / docs/ / 注释）
- [ ] 🔧 构建、CI 或发布流程
- [ ] 🔒 安全加固

## 影响面

<!-- 勾选本 PR 触及的部分，便于 reviewer 判断审查范围 -->

- [ ] 后端 Rust（`src/`）
- [ ] 后端测试（`tests/`）
- [ ] 前端（`frontend/`）
- [ ] API 契约（端点、字段、错误码、状态码）
- [ ] 环境变量 / 配置项（`.env.example`）
- [ ] 缓存行为（键构造、TTL、清理策略）
- [ ] 安全相关（CSRF / CSP / SSRF / 限流 / 鉴权 / Host 白名单）
- [ ] Docker / Compose / CI（`Dockerfile`、`docker-compose.yml`、`.github/`）
- [ ] 文档（`README.md`、`docs/`、`CHANGELOG.md`）

## 自测清单（与 CI 对齐）

> 在本地逐项执行并勾选；CI 会跑同样的命令，未通过不会合并。

### 后端

- [ ] `cargo fmt --all -- --check` 通过（或已执行 `cargo fmt`）
- [ ] `cargo clippy --all-targets --locked -- -D warnings` 通过
- [ ] `cargo test --locked --all-targets` 通过（新增逻辑已补测试）
- [ ] 如涉及 MSRV 敏感语法或依赖，已验证 `cargo check --locked` 在 Rust 1.88 下通过

### 前端

- [ ] `pnpm -C frontend install --frozen-lockfile`（依赖无变化可跳过）
- [ ] `pnpm -C frontend typecheck` 通过
- [ ] `pnpm -C frontend test -- --run` 通过（新增组件/逻辑已补测试）
- [ ] `pnpm -C frontend build` 通过

### 结构 / 集成

- [ ] `bash scripts/check-structure.sh` 通过
- [ ] 涉及端到端行为时，`make smoke` 通过（需先 `make build`）
- [ ] 涉及 Docker 时，`docker build` 与容器内 `/api/health` 实测通过

## 安全相关检查

<!-- 只要 PR 触及网络、认证、渲染或文件系统，就必须逐项确认 -->

- [ ] 没有把任何密钥、token、密码哈希或真实 `.env` 内容提交进仓库 / 测试 / 截图 / 日志
- [ ] 新增的用户输入或上游数据在渲染前经过转义或白名单校验（无 `innerHTML` / `dangerouslySetInnerHTML` 新增滥用）
- [ ] 新增的对外请求考虑过 SSRF（目标校验、不跟随重定向）
- [ ] 新增端点或状态变更操作沿用了现有的 CSRF（`X-Requested-With` + `Origin`）、限流与请求体大小限制
- [ ] 错误响应不会泄露内部路径、堆栈、上游原始凭据或配置值
- [ ] 如修复了安全问题，**未在 PR 标题/描述中公开可直接利用的细节**（发布后再补充说明）

## 文档与变更记录

- [ ] 用户可见的行为变化已更新 `README.md` 和/或 `docs/`
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 段落已补充（按 Keep a Changelog 分类）
- [ ] 新增/变更的环境变量已同步 `.env.example`
- [ ] 破坏性变更已明确标注迁移方式

## Reviewer 提示

<!-- 需要 reviewer 重点关注的地方、设计取舍、已知限制、后续 TODO 等 -->

## 截图 / 录屏（界面类变更必填）

<!-- 前端变更请提供修改前后对比，并说明在 375 / 768 / 1440 宽度与深色模式下的表现 -->
