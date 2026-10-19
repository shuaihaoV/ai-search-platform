#!/usr/bin/env bash
#
# scripts/build.sh —— 一步构建 ai-search-platform 生产二进制
#
# 流程：
#   1. 安装前端依赖（frontend/node_modules 不存在时）
#   2. 构建前端（pnpm -C frontend build -> frontend/dist）
#   3. cargo build --release（rust-embed 在编译期把 frontend/dist 嵌入二进制）
#   4. 打印最终二进制路径
#
# 用法：
#   bash scripts/build.sh          # 完整构建
#   bash scripts/build.sh --help   # 查看帮助
#
# 环境变量：
#   CARGO_PROFILE   release（默认）；设为 debug 时改用 cargo build（便于调试）
#   SKIP_INSTALL=1  跳过前端依赖安装
#
# 网络需要代理时先 export http_proxy/https_proxy（见 README「故障排查」）。

set -euo pipefail

# --- 定位项目根目录（脚本可被任意 cwd 调用）---------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

# --- 输出辅助 ----------------------------------------------------------------
readonly C_RESET='\033[0m'
readonly C_BOLD='\033[1m'
readonly C_BLUE='\033[34m'
readonly C_GREEN='\033[32m'
readonly C_YELLOW='\033[33m'
readonly C_RED='\033[31m'

if [[ -t 1 ]]; then
  use_color=1
else
  use_color=0
fi

c() {
  local color="$1"
  shift
  if [[ "${use_color}" -eq 1 ]]; then
    printf '%b%s%b\n' "${color}" "$*" "${C_RESET}"
  else
    printf '%s\n' "$*"
  fi
}

step() { c "${C_BLUE}${C_BOLD}" "==> $*"; }
ok()   { c "${C_GREEN}" "  ✓ $*"; }
warn() { c "${C_YELLOW}" "  ! $*"; }
die()  { c "${C_RED}${C_BOLD}" "  ✗ $*" >&2; exit 1; }

# --- 参数 --------------------------------------------------------------------
PROFILE="${CARGO_PROFILE:-release}"
for arg in "$@"; do
  case "${arg}" in
    -h|--help)
      cat <<'EOF'
用法: bash scripts/build.sh

构建前端（Vite）与 Rust release 二进制，最终产物：
  target/release/ai-search-platform

可选环境变量:
  CARGO_PROFILE=debug   使用 cargo build（不优化，便于调试）
  SKIP_INSTALL=1        跳过 frontend 依赖安装步骤

依赖: node>=22.12, pnpm, cargo>=1.88
EOF
      exit 0
      ;;
    *)
      die "未知参数: ${arg}（用 --help 查看用法）"
      ;;
  esac
done

case "${PROFILE}" in
  release|debug) ;;
  *) die "CARGO_PROFILE 只能是 release 或 debug（当前: ${PROFILE}）" ;;
esac

# --- 前置检查 ----------------------------------------------------------------
step "检查构建依赖"

command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js >= 22.12"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm，请先安装 pnpm（npm i -g pnpm 或 corepack enable）"
command -v cargo >/dev/null 2>&1 || die "未找到 cargo，请先安装 Rust（rustup）"

NODE_VERSION="$(node --version)"
PNPM_VERSION="$(pnpm --version)"
CARGO_VERSION="$(cargo --version)"
ok "node ${NODE_VERSION}"
ok "pnpm ${PNPM_VERSION}"
ok "${CARGO_VERSION}"

[[ -f "frontend/package.json" ]] || die "缺少 frontend/package.json，前端工程尚未就绪"
[[ -f "Cargo.toml" ]] || die "缺少 Cargo.toml"

# --- 1. 前端依赖 -------------------------------------------------------------
step "安装前端依赖"

if [[ "${SKIP_INSTALL:-0}" == "1" ]]; then
  warn "SKIP_INSTALL=1，跳过依赖安装"
elif [[ -d "frontend/node_modules" ]]; then
  ok "frontend/node_modules 已存在，跳过安装"
else
  if [[ -f "frontend/pnpm-lock.yaml" ]]; then
    ok "检测到 pnpm-lock.yaml，使用 --frozen-lockfile"
    if ! (cd frontend && pnpm install --frozen-lockfile); then
      warn "pnpm install --frozen-lockfile 失败（lockfile 可能过期），回退为普通 install"
      (cd frontend && pnpm install) || die "前端依赖安装失败"
    fi
  else
    warn "未检测到 pnpm-lock.yaml，使用普通 pnpm install"
    (cd frontend && pnpm install) || die "前端依赖安装失败"
  fi
  ok "前端依赖安装完成"
fi

# --- 2. 构建前端 -------------------------------------------------------------
step "构建前端（Vite）"

[[ -f "frontend/package.json" ]] || die "缺少 frontend/package.json"
(cd frontend && pnpm build) || die "前端构建失败（pnpm -C frontend build）"

[[ -f "frontend/dist/index.html" ]] || die "前端构建产物缺失: frontend/dist/index.html"
DIST_FILES="$(find frontend/dist -type f | wc -l | tr -d ' ')"
ok "frontend/dist 就绪（${DIST_FILES} 个文件）"

# --- 3. 构建 Rust 后端 -------------------------------------------------------
step "构建 Rust 后端（profile=${PROFILE}）"

if [[ "${PROFILE}" == "release" ]]; then
  cargo build --release --locked || cargo build --release
  BIN_PATH="target/release/ai-search-platform"
else
  cargo build --locked || cargo build
  BIN_PATH="target/debug/ai-search-platform"
fi

[[ -x "${BIN_PATH}" ]] || die "编译成功但未找到二进制: ${BIN_PATH}"

BIN_SIZE="$(du -h "${BIN_PATH}" | cut -f1)"
ok "二进制: ${BIN_PATH} (${BIN_SIZE})"

# --- 4. 汇总 -----------------------------------------------------------------
step "构建完成"
c "${C_GREEN}${C_BOLD}" "最终二进制路径: $(pwd)/${BIN_PATH}"
cat <<EOF

接下来可以：
  make run                       # 加载 .env 后运行（默认 127.0.0.1:8080）
  make smoke                     # 端到端验收（需 mock 上游）
  ./${BIN_PATH} --help           # 直接运行（请先设置环境变量）

EOF
