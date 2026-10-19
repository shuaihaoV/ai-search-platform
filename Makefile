# ai-search-platform —— 常用开发 / 构建 / 验收命令
#
# 快速上手：
#   make install     # 安装前端依赖
#   make build       # 构建前端 + Rust release 二进制（默认目标）
#   make run         # 启动服务（默认 127.0.0.1:8080）
#   make smoke       # 端到端验收（自动起 mock 上游）
#   make docker-up   # Docker Compose 一键启动（需先准备 .env）
#
# 约定：所有 target 都在项目根目录执行（Makefile 所在目录）。

SHELL := /bin/bash
.DEFAULT_GOAL := build

# --- 项目参数 ----------------------------------------------------------------
CARGO        ?= cargo
PNPM         ?= pnpm
FRONTEND_DIR := frontend
BIN          := target/release/ai-search-platform
SHELL_CHECKS := scripts/build.sh scripts/smoke.sh

# .env 存在时加载（make run / dev-backend 使用），不存在也不报错
-include .env
export

# 便于 DeepSeek 上报 / 构建脚本识别；不改变行为
export CARGO_TERM_COLOR ?= always

# --- 元信息 ------------------------------------------------------------------
.PHONY: help
help: ## 显示可用命令
	@printf '\n\033[1mai-search-platform 可用命令\033[0m\n\n'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@printf '\n示例：\n  make build        构建前端并编译 release 二进制\n  make smoke        端到端验收（约 1 分钟）\n\n'

# --- 依赖 --------------------------------------------------------------------
.PHONY: install
install: ## 安装前端依赖（node_modules 缺失时）
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

# --- 构建 --------------------------------------------------------------------
.PHONY: frontend
frontend: ## 构建前端（Vite → frontend/dist）
	@echo "==> 构建前端 ($(FRONTEND_DIR))"
	@if [ ! -d "$(FRONTEND_DIR)/node_modules" ]; then \
		echo "==> 前端依赖未安装，先执行 install"; \
		$(MAKE) install; \
	fi
	$(PNPM) -C $(FRONTEND_DIR) build

.PHONY: build
build: ## 构建前端 + Rust release 二进制（默认目标）
	@echo "==> 构建 ai-search-platform"
	@bash scripts/build.sh

.PHONY: build-backend
build-backend: ## 仅构建 Rust 后端（前端产物已存在时更快）
	@echo "==> cargo build --release"
	$(CARGO) build --release
	@echo "==> 二进制: $(BIN)"

# --- 运行 --------------------------------------------------------------------
.PHONY: run
run: ## 运行 release 二进制（读取 .env，默认 127.0.0.1:8080）
	@if [ ! -x "$(BIN)" ]; then \
		echo "错误: 未找到 $(BIN)"; \
		echo "请先执行: make build"; \
		exit 1; \
	fi
	@if [ ! -f .env ]; then \
		echo "提示: 未找到 .env，将使用当前环境变量（需要 DEEPSEEK_API_KEY）"; \
	fi
	@echo "==> 启动 $(BIN)"
	./$(BIN)

.PHONY: dev-backend
dev-backend: ## 开发模式后端（cargo run，热重载需自行加 cargo-watch）
	@echo "==> cargo run（debug 构建，读取 .env）"
	$(CARGO) run

.PHONY: dev-frontend
dev-frontend: ## 开发模式前端（Vite dev server + /api 代理）
	@echo "==> pnpm -C $(FRONTEND_DIR) dev"
	$(PNPM) -C $(FRONTEND_DIR) dev

# --- 质量检查 ----------------------------------------------------------------
.PHONY: fmt
fmt: ## 格式化 Rust 代码（cargo fmt）
	$(CARGO) fmt

.PHONY: lint
lint: ## 静态检查：cargo fmt --check + clippy -D warnings + 前端 typecheck
	@echo "==> cargo fmt --check"
	$(CARGO) fmt --all -- --check
	@echo "==> cargo clippy"
	$(CARGO) clippy --all-targets --all-features -- -D warnings
	@echo "==> 前端 typecheck"
	$(PNPM) -C $(FRONTEND_DIR) typecheck

.PHONY: test
test: ## 运行后端单测 + 前端单测
	@echo "==> cargo test"
	$(CARGO) test
	@echo "==> 前端单测"
	$(PNPM) -C $(FRONTEND_DIR) test -- --run

# --- 本地联调 / 验收 ---------------------------------------------------------
.PHONY: mock
mock: ## 启动 mock 上游（默认 127.0.0.1:9000）
	@echo "==> mock 上游: http://127.0.0.1:9000（Ctrl-C 退出）"
	python3 scripts/mock_upstream.py --port 9000

.PHONY: smoke
smoke: ## 端到端验收（自动启动 mock 上游 + 被测二进制）
	@bash scripts/smoke.sh

# --- 容器 --------------------------------------------------------------------
.PHONY: docker-build
docker-build: ## 构建本地 Docker 镜像（ai-search-platform:local）
	docker build -t ai-search-platform:local .

.PHONY: docker-up
docker-up: ## docker compose 一键启动（构建镜像；需先准备 .env）
	docker compose up -d --build

.PHONY: docker-down
docker-down: ## 停止 docker compose
	docker compose down

# --- 清理 --------------------------------------------------------------------
.PHONY: clean
clean: ## 清理构建产物（target/、frontend/dist、缓存）
	@echo "==> cargo clean"
	$(CARGO) clean
	@echo "==> 清理 frontend/dist"
	rm -rf $(FRONTEND_DIR)/dist
	@echo "==> 清理本地缓存 .cache/"
	rm -rf .cache
	@echo "==> 完成"
