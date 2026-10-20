# =============================================================================
# ai-search-platform —— 常用开发 / 构建 / 测试 / 发布命令
#
# 快速上手：
#   make build         # 构建前端 + Rust release 二进制（默认目标）
#   make run           # 启动服务（默认 127.0.0.1:8080，自动读取 ./.env）
#   make release-check # 发布前一把梭：结构 + fmt/clippy/test + 前端全套
#   make help          # 按分组查看全部命令
#
# 约定：所有 target 都在项目根目录（Makefile 所在目录）执行。
# 分组通过在 Makefile 内使用 "##@ 组名" 标记，help 会自动汇总。
# =============================================================================

SHELL := /bin/bash
.DEFAULT_GOAL := build

# --- 项目参数 ----------------------------------------------------------------
CARGO        ?= cargo
PNPM         ?= pnpm
FRONTEND_DIR := frontend
BIN          := target/release/ai-search-platform
SCRIPTS_DIR  := scripts

# 注意：这里刻意不使用 `-include .env`。
#   1) 服务二进制自身会加载当前工作目录的 ./.env（dotenvy::from_path）；
#   2) PLATFORM_PASSWD 的 Argon2 哈希含 `$`，被 make 读入会当作变量展开而损坏。
# docker compose 也会自动读取 ./.env，无需 make 转发。

export CARGO_TERM_COLOR ?= always

# =============================================================================
# 元信息
# =============================================================================
.PHONY: help
help: ## 显示可用命令（按分组）
	@printf '\n\033[1mai-search-platform 常用命令\033[0m\n'
	@awk 'BEGIN {FS = ":.*## "} \
		/^##@ / { printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next } \
		/^[a-zA-Z0-9_-]+:.*## / { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' \
		$(firstword $(MAKEFILE_LIST))
	@printf '\n更多文档：docs/RELEASING.md（发布流程）、CONTRIBUTING.md（贡献指南）\n\n'

.PHONY: version
version: ## 显示版本号、提交与工作区状态
	@printf '应用版本 : %s\n' "$$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n 1)"
	@printf '前端版本 : %s\n' "$$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' $(FRONTEND_DIR)/package.json | head -n 1)"
	@printf '最新发布 : %s\n' "$$(sed -n 's/^## \[\([0-9][0-9.]*\)\].*/\1/p' CHANGELOG.md | head -n 1)"
	@if git rev-parse --git-dir >/dev/null 2>&1; then \
		printf '提交     : %s\n' "$$(git rev-parse --short HEAD)"; \
		printf '分支     : %s\n' "$$(git rev-parse --abbrev-ref HEAD)"; \
		if [ -n "$$(git status --porcelain)" ]; then printf '工作区   : 有未提交改动\n'; else printf '工作区   : 干净\n'; fi; \
	else \
		printf '提交     : （非 git 仓库）\n'; \
	fi

# =============================================================================
##@ 开发与运行
# =============================================================================

.PHONY: install
install: ## 安装前端依赖（node_modules 缺失时才安装）
	@if [ -d "$(FRONTEND_DIR)/node_modules" ]; then \
		echo "==> frontend/node_modules 已存在，跳过"; \
	elif [ -f "$(FRONTEND_DIR)/pnpm-lock.yaml" ]; then \
		echo "==> pnpm install --frozen-lockfile"; \
		$(PNPM) -C $(FRONTEND_DIR) install --frozen-lockfile \
			|| $(PNPM) -C $(FRONTEND_DIR) install; \
	else \
		echo "==> pnpm install"; \
		$(PNPM) -C $(FRONTEND_DIR) install; \
	fi

.PHONY: run
run: ## 运行 release 二进制（读 ./.env，默认 127.0.0.1:8080）
	@if [ ! -x "$(BIN)" ]; then \
		echo "错误: 未找到 $(BIN)"; \
		echo "请先执行: make build"; \
		exit 1; \
	fi
	@if [ ! -f .env ]; then \
		echo "提示: 未找到 ./.env，将使用当前环境变量（需要 DEEPSEEK_API_KEY）"; \
	fi
	@echo "==> 启动 $(BIN)"
	./$(BIN)

.PHONY: dev-backend
dev-backend: ## 开发模式后端（cargo run，读取 ./.env）
	@echo "==> cargo run（debug 构建）"
	$(CARGO) run

.PHONY: dev-frontend
dev-frontend: ## 开发模式前端（Vite dev server，/api 代理到 8080）
	@echo "==> pnpm -C $(FRONTEND_DIR) dev"
	$(PNPM) -C $(FRONTEND_DIR) dev

.PHONY: mock
mock: ## 启动本地 mock 上游（默认 127.0.0.1:9000）
	@echo "==> mock 上游: http://127.0.0.1:9000（Ctrl-C 退出）"
	python3 $(SCRIPTS_DIR)/mock_upstream.py --port 9000

# =============================================================================
##@ 构建
# =============================================================================

.PHONY: build
build: ## 构建前端 + Rust release 二进制（默认目标）
	@echo "==> 构建 ai-search-platform"
	@bash $(SCRIPTS_DIR)/build.sh

.PHONY: frontend
frontend: ## 仅构建前端（Vite → frontend/dist）
	@echo "==> 构建前端 ($(FRONTEND_DIR))"
	@if [ ! -d "$(FRONTEND_DIR)/node_modules" ]; then \
		echo "==> 前端依赖未安装，先执行 install"; \
		$(MAKE) install; \
	fi
	$(PNPM) -C $(FRONTEND_DIR) build

.PHONY: build-backend
build-backend: ## 仅构建 Rust 后端（前端产物已存在时更快）
	@echo "==> cargo build --release"
	$(CARGO) build --release
	@echo "==> 二进制: $(BIN)"

# =============================================================================
##@ 质量检查与测试
# =============================================================================

.PHONY: fmt
fmt: ## 格式化 Rust 代码（cargo fmt）
	$(CARGO) fmt

.PHONY: lint
lint: ## 快速检查：fmt --check + clippy -D warnings + 前端 typecheck
	@echo "==> cargo fmt --check"
	$(CARGO) fmt --all -- --check
	@echo "==> cargo clippy"
	$(CARGO) clippy --all-targets --all-features -- -D warnings
	@echo "==> 前端 typecheck"
	$(PNPM) -C $(FRONTEND_DIR) typecheck

.PHONY: test
test: ## 运行后端测试 + 前端测试
	@echo "==> cargo test"
	$(CARGO) test
	@echo "==> 前端单测"
	$(PNPM) -C $(FRONTEND_DIR) test -- --run

# --- 与 CI 完全一致的严格版本（供 release-check 使用）-----------------------
.PHONY: lint-ci
lint-ci: ## [CI] fmt --check + clippy --locked -D warnings
	@echo "==> [CI] cargo fmt --all -- --check"
	$(CARGO) fmt --all -- --check
	@echo "==> [CI] cargo clippy --all-targets --all-features --locked -- -D warnings"
	$(CARGO) clippy --all-targets --all-features --locked -- -D warnings

.PHONY: test-ci
test-ci: ## [CI] cargo test --locked --all-targets
	@echo "==> [CI] cargo test --locked --all-targets"
	$(CARGO) test --locked --all-targets

.PHONY: frontend-ci
frontend-ci: ## [CI] 前端 typecheck + test --run + build
	@echo "==> [CI] pnpm typecheck"
	$(PNPM) -C $(FRONTEND_DIR) typecheck
	@echo "==> [CI] pnpm test -- --run"
	$(PNPM) -C $(FRONTEND_DIR) test -- --run
	@echo "==> [CI] pnpm build"
	$(PNPM) -C $(FRONTEND_DIR) build

.PHONY: structure
structure: ## 仓库结构检查（必含文件/版本一致性/敏感文件未被跟踪）
	@bash $(SCRIPTS_DIR)/check-structure.sh

# =============================================================================
##@ 端到端验收
# =============================================================================

.PHONY: smoke
smoke: ## 端到端验收（自动起 mock 上游 + 被测二进制，52 项断言）
	@bash $(SCRIPTS_DIR)/smoke.sh

# =============================================================================
##@ 发布
# =============================================================================

.PHONY: release-check
release-check: structure install lint-ci test-ci frontend-ci ## 发布前完整检查（结构 + Rust + 前端，对齐 CI）
	@printf '\n\033[32m\033[1m✅ 发布前检查全部通过\033[0m\n'
	@printf '   版本: %s\n' "$$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n 1)"
	@printf '   下一步: 按 docs/RELEASING.md 更新 CHANGELOG → 打 tag → push tag\n'
	@printf '   提示: MSRV（1.88）与多架构 Docker 由 CI 覆盖，本地可选跑 make smoke\n\n'

# =============================================================================
##@ 容器
# =============================================================================

.PHONY: docker-build
docker-build: ## 构建本地 Docker 镜像（ai-search-platform:local）
	docker build -t ai-search-platform:local .

.PHONY: docker-up
docker-up: ## docker compose 一键启动（构建镜像；自动读取 ./.env）
	docker compose up -d --build

.PHONY: docker-down
docker-down: ## 停止 docker compose
	docker compose down

# =============================================================================
##@ 清理
# =============================================================================

.PHONY: clean
clean: ## 清理构建产物（target/、frontend/dist、本地缓存）
	@echo "==> cargo clean"
	$(CARGO) clean
	@echo "==> 清理 frontend/dist"
	rm -rf $(FRONTEND_DIR)/dist
	@echo "==> 清理本地缓存 .cache/"
	rm -rf .cache
	@echo "==> 完成"
