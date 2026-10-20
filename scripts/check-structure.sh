#!/usr/bin/env bash
#
# scripts/check-structure.sh —— 仓库结构 / 版本一致性 / 敏感文件发布前自检
#
# 用途：在 `make release-check`、CI 或发布前手工执行，确保开源仓库结构完整。
# 只读检查，不修改任何文件；发现问题时以非零码退出。
#
# 检查项：
#   1. 必含文件与目录（文档、构建、Docker、CI、脚本、核心源码）
#   2. 版本号一致性（Cargo.toml vs frontend/package.json vs CHANGELOG 最新版本）
#   3. 敏感文件未被 git 跟踪；.env 等被 .gitignore 正确忽略
#   4. .env.example 覆盖全部环境变量
#   5. Issue 模板 / workflow 的 YAML 基本可解析（有 PyYAML 时）
#
# 用法：
#   bash scripts/check-structure.sh
#   bash scripts/check-structure.sh --help
#
# 退出码：0 全部通过；1 存在失败项。
#
# 注意：在非 git 工作区（如解压后的源码包）运行时会跳过 git 相关检查并给出提示。

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}" || exit 1

# --- 输出辅助 ----------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET="$(printf '\033')[0m"
  C_RED="$(printf '\033')[31m"
  C_GREEN="$(printf '\033')[32m"
  C_YELLOW="$(printf '\033')[33m"
  C_BLUE="$(printf '\033')[34m"
  C_BOLD="$(printf '\033')[1m"
else
  C_RESET=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_BLUE=""
  C_BOLD=""
fi

PASS=0
FAIL=0
WARN=0
FAILURES=""
WARNINGS=""

section() { printf '\n%b%s%b\n' "${C_BLUE}${C_BOLD}" "$*" "${C_RESET}"; }
ok()      { PASS=$((PASS + 1)); printf '  %b✓%b %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn()    { WARN=$((WARN + 1)); WARNINGS="${WARNINGS}${WARNINGS:+$'\n'}  - $*"; printf '  %b!%b %s\n' "${C_YELLOW}" "${C_RESET}" "$*"; }
bad()     { FAIL=$((FAIL + 1)); FAILURES="${FAILURES}${FAILURES:+$'\n'}  - $*"; printf '  %b✗%b %s\n' "${C_RED}" "${C_RESET}" "$*"; }

# 解析版本号与 YAML 需要 Python。默认用 PATH 中的 python3；
# 如需用带 PyYAML 的解释器完整校验 YAML：
#   CHECK_PYTHON=/path/to/python bash scripts/check-structure.sh
PYTHON_BIN="${CHECK_PYTHON:-python3}"
command -v "${PYTHON_BIN}" >/dev/null 2>&1 || { printf '错误: 需要 python3（或设置 CHECK_PYTHON）解析版本号\n' >&2; exit 1; }

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
用法: bash scripts/check-structure.sh

检查内容：
  1. 必含文件与目录
  2. 版本号一致性（Cargo.toml / frontend/package.json / CHANGELOG.md）
  3. 敏感文件未被 git 跟踪，.env 等被 .gitignore 忽略
  4. .env.example 覆盖全部环境变量
  5. 发布脚手架 YAML 基本可解析（需 PyYAML）

退出码: 0 通过；1 有失败项
EOF
    exit 0
    ;;
  "")
    ;;
  *)
    printf '未知参数: %s（用 --help 查看用法）\n' "$1" >&2
    exit 1
    ;;
esac

printf '%b仓库结构检查%b（%s）\n' "${C_BOLD}" "${C_RESET}" "${ROOT_DIR}"

# =============================================================================
# 1. 必含文件与目录
# =============================================================================
section "1. 必含文件与目录"

REQUIRED_FILES="
README.md
LICENSE
CHANGELOG.md
SECURITY.md
CONTRIBUTING.md
CODE_OF_CONDUCT.md
Dockerfile
docker-compose.yml
.dockerignore
.env.example
.gitignore
Cargo.toml
Cargo.lock
Makefile
build.rs
.github/PULL_REQUEST_TEMPLATE.md
.github/dependabot.yml
.github/ISSUE_TEMPLATE/bug_report.yml
.github/ISSUE_TEMPLATE/feature_request.yml
.github/ISSUE_TEMPLATE/config.yml
.github/workflows/ci.yml
.github/workflows/docker.yml
.github/workflows/release.yml
docs/RELEASING.md
scripts/build.sh
scripts/check-structure.sh
scripts/mock_upstream.py
scripts/smoke.sh
src/main.rs
src/lib.rs
frontend/package.json
frontend/pnpm-lock.yaml
frontend/vite.config.ts
"

MISSING=""
for f in ${REQUIRED_FILES}; do
  if [ ! -f "${f}" ]; then
    MISSING="${MISSING} ${f}"
    bad "缺少文件: ${f}"
  fi
done
if [ -z "${MISSING}" ]; then
  ok "全部必含文件存在（$(printf '%s' "${REQUIRED_FILES}" | grep -c . ) 项）"
fi

for d in src tests frontend scripts docs; do
  if [ -d "${d}" ]; then
    ok "目录存在: ${d}/"
  else
    bad "缺少目录: ${d}/"
  fi
done

# 截图（README 引用）——缺失不阻塞，但会提示
for shot in docs/screenshots/home.png docs/screenshots/search.png; do
  if [ -f "${shot}" ]; then
    ok "截图存在: ${shot}"
  else
    warn "截图缺失: ${shot}（README 引用将失效）"
  fi
done

# =============================================================================
# 2. 版本号一致性
# =============================================================================
section "2. 版本号一致性"

VERSIONS="$("${PYTHON_BIN}" - <<'PY' 2>/dev/null
import json
import re
import sys

cargo = ""
try:
    text = open("Cargo.toml", encoding="utf-8").read()
    # 只在 [package] 段内查找 version，避免匹配到依赖或 [workspace.package]
    package = re.search(r"^\[package\]\s*$(.*?)(?=^\[|\Z)", text, re.M | re.S)
    if package:
        match = re.search(r'^version\s*=\s*"([^"]+)"', package.group(1), re.M)
        if match:
            cargo = match.group(1)
except OSError:
    pass

frontend = ""
try:
    with open("frontend/package.json", encoding="utf-8") as fh:
        frontend = json.load(fh).get("version", "")
except (OSError, ValueError):
    pass

changelog = ""
try:
    text = open("CHANGELOG.md", encoding="utf-8").read()
    # 最新「已发布」版本：第一个 ## [X.Y.Z]（跳过 [Unreleased]）
    for match in re.finditer(r"^##\s+\[(\d+\.\d+\.\d+)\]", text, re.M):
        changelog = match.group(1)
        break
except OSError:
    pass

print(cargo)
print(frontend)
print(changelog)
PY
)"

CARGO_V="$(printf '%s\n' "${VERSIONS}" | sed -n '1p')"
FRONTEND_V="$(printf '%s\n' "${VERSIONS}" | sed -n '2p')"
CHANGELOG_V="$(printf '%s\n' "${VERSIONS}" | sed -n '3p')"

SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+$'

if [ -z "${CARGO_V}" ]; then
  bad "无法从 Cargo.toml 解析版本号（需 [package] version）"
elif printf '%s' "${CARGO_V}" | grep -qE "${SEMVER_RE}"; then
  ok "Cargo.toml version = ${CARGO_V}"
else
  bad "Cargo.toml 版本号不是合法 SemVer: ${CARGO_V}"
fi

if [ -z "${FRONTEND_V}" ]; then
  bad "无法从 frontend/package.json 解析 version"
elif printf '%s' "${FRONTEND_V}" | grep -qE "${SEMVER_RE}"; then
  ok "frontend/package.json version = ${FRONTEND_V}"
else
  bad "frontend/package.json 版本号不是合法 SemVer: ${FRONTEND_V}"
fi

if [ -z "${CHANGELOG_V}" ]; then
  bad "CHANGELOG.md 中找不到形如 '## [X.Y.Z]' 的已发布版本标题"
else
  ok "CHANGELOG.md 最新已发布版本 = ${CHANGELOG_V}"
  if grep -qE '^## \[Unreleased\]' CHANGELOG.md; then
    ok "CHANGELOG.md 含 [Unreleased] 段"
  else
    warn "CHANGELOG.md 缺少 '## [Unreleased]' 段（建议保留以沉淀下个版本变更）"
  fi
fi

if [ -n "${CARGO_V}" ] && [ -n "${FRONTEND_V}" ] && [ -n "${CHANGELOG_V}" ]; then
  if [ "${CARGO_V}" = "${FRONTEND_V}" ] && [ "${CARGO_V}" = "${CHANGELOG_V}" ]; then
    ok "三处版本号一致: ${CARGO_V}"
  else
    bad "版本号不一致: Cargo.toml=${CARGO_V} / frontend/package.json=${FRONTEND_V} / CHANGELOG=${CHANGELOG_V}"
  fi
fi

# Cargo.lock 中的本包版本（构建时自动更新，只作提示）
if [ -n "${CARGO_V}" ] && [ -f Cargo.lock ]; then
  LOCK_V="$("${PYTHON_BIN}" - "${CARGO_V}" <<'PY' 2>/dev/null
import re
import sys

target = sys.argv[1]
text = open("Cargo.lock", encoding="utf-8").read()
for block in re.split(r"\n\[\[package\]\]\n", text):
    if re.search(r'^name = "ai-search-platform"$', block, re.M):
        match = re.search(r'^version = "([^"]+)"$', block, re.M)
        if match:
            print(match.group(1))
            break
PY
)"
  if [ -z "${LOCK_V}" ]; then
    warn "Cargo.lock 中未找到 ai-search-platform 条目（可能尚未构建）"
  elif [ "${LOCK_V}" != "${CARGO_V}" ]; then
    warn "Cargo.lock 版本 ${LOCK_V} 与 Cargo.toml ${CARGO_V} 不一致，执行 cargo build 自动同步"
  else
    ok "Cargo.lock 版本一致: ${LOCK_V}"
  fi
fi

# =============================================================================
# 3. git 跟踪状态与敏感文件
# =============================================================================
section "3. 敏感文件与 git 跟踪状态"

if git -C "${ROOT_DIR}" rev-parse --git-dir >/dev/null 2>&1; then
  TRACKED="$(git -C "${ROOT_DIR}" ls-files)"

  # 3.1 明确不允许被跟踪的路径 / 模式
  FORBIDDEN_TRACKED="$(printf '%s\n' "${TRACKED}" | grep -E \
    '(^|/)\.env$|(^|/)\.env\.local$|(^|/)\.env\.[^/]*\.local$|(^|/)\.cache/|(^|/)target/|(^|/)node_modules/|(^|/)frontend/dist/|(^|/)docker-data/|(^|/)\.tmp/|(^|/)id_rsa$|\.pem$|\.p12$|\.pfx$|(^|/)\.DS_Store$' \
    || true)"

  if [ -z "${FORBIDDEN_TRACKED}" ]; then
    ok "没有敏感文件 / 构建产物被 git 跟踪"
  else
    bad "以下敏感文件或产物被跟踪："
    printf '%s\n' "${FORBIDDEN_TRACKED}" | sed 's/^/      /'
    printf '    修复: git rm --cached <file> 并确认 .gitignore 已覆盖\n'
  fi

  # 3.2 .env.example 必须被跟踪（开源仓库需要模板）
  if printf '%s\n' "${TRACKED}" | grep -qx '.env.example'; then
    ok ".env.example 已被跟踪"
  else
    bad ".env.example 未被 git 跟踪（开源仓库必须提供模板）"
  fi

  # 3.3 本机若存在 .env，必须被忽略
  if [ -f .env ]; then
    if git -C "${ROOT_DIR}" check-ignore -q .env; then
      ok "本机 .env 已被 .gitignore 忽略"
    else
      bad "本机 .env 未被忽略，存在误提交风险（检查 .gitignore）"
    fi
  else
    ok "本机无 .env（无需检查忽略规则）"
  fi

  # 3.4 .gitignore 关键规则
  for pattern in '.env' '/.cache' '/target'; do
    if grep -qF -- "${pattern}" .gitignore; then
      ok ".gitignore 覆盖: ${pattern}"
    else
      bad ".gitignore 缺少关键规则: ${pattern}"
    fi
  done

  # 3.5 工作区是否有未提交改动（发布前应为干净）
  DIRTY="$(git -C "${ROOT_DIR}" status --porcelain | grep -vE '^\?\? \.tmp/|^\?\? \.cache/' || true)"
  if [ -z "${DIRTY}" ]; then
    ok "git 工作区干净（可发布）"
  else
    DIRTY_COUNT="$(printf '%s\n' "${DIRTY}" | grep -c .)"
    warn "git 工作区有 ${DIRTY_COUNT} 项未提交改动（发布前请先提交）"
    printf '%s\n' "${DIRTY}" | sed -n '1,10p' | sed 's/^/      /'
    if [ "${DIRTY_COUNT}" -gt 10 ]; then
      printf '      ...（共 %s 项）\n' "${DIRTY_COUNT}"
    fi
  fi
else
  warn "当前目录不是 git 仓库，跳过敏感文件跟踪检查"
fi

# =============================================================================
# 4. .env.example 环境变量覆盖
# =============================================================================
section "4. .env.example 环境变量"

if [ -f .env.example ]; then
  MISSING_ENV=""
  for var in DEEPSEEK_API_KEY DEEPSEEK_BASE_URL BIND_ADDR RUST_LOG ALLOWED_HOSTS PLATFORM_PASSWD; do
    if grep -qE "^${var}=" .env.example; then
      ok ".env.example 含 ${var}"
    else
      MISSING_ENV="${MISSING_ENV} ${var}"
      bad ".env.example 缺少 ${var}"
    fi
  done
  if [ -z "${MISSING_ENV}" ]; then
    ok "6 个环境变量齐全"
  fi

  # 只看真正的赋值行（忽略注释里的示例），应为空模板
  if grep -qE '^PLATFORM_PASSWD=.+' .env.example; then
    warn ".env.example 的 PLATFORM_PASSWD 非空，确认未写入真实哈希（应为空模板）"
  else
    ok ".env.example 的 PLATFORM_PASSWD 为空模板"
  fi
else
  bad "缺少 .env.example"
fi

# =============================================================================
# 5. 发布脚手架 YAML 解析
# =============================================================================
section "5. 发布脚手架 YAML"

YAML_TARGETS=".github/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/feature_request.yml .github/ISSUE_TEMPLATE/config.yml .github/workflows/ci.yml .github/workflows/docker.yml .github/workflows/release.yml .github/dependabot.yml"

if "${PYTHON_BIN}" -c 'import yaml' >/dev/null 2>&1; then
  for f in ${YAML_TARGETS}; do
    if [ ! -f "${f}" ]; then
      continue  # 文件缺失已在上文报错
    fi
    if "${PYTHON_BIN}" -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1], encoding="utf-8"))' "${f}" >/dev/null 2>&1; then
      ok "YAML 可解析: ${f}"
    else
      bad "YAML 解析失败: ${f}"
    fi
  done

  # Issue form 的必填结构（name/description/body），避免模板在 GitHub 上不生效
  for f in .github/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/feature_request.yml; do
    [ -f "${f}" ] || continue
    MISSING_KEYS="$("${PYTHON_BIN}" - "${f}" <<'PY' 2>/dev/null
import sys
import yaml

data = yaml.safe_load(open(sys.argv[1], encoding="utf-8")) or {}
missing = [key for key in ("name", "description", "body") if key not in data]
print(" ".join(missing))
PY
)"
    if [ -z "${MISSING_KEYS}" ]; then
      ok "Issue 模板结构完整: ${f}"
    else
      bad "Issue 模板缺少字段 ${MISSING_KEYS}: ${f}"
    fi
  done
else
  warn "未安装 PyYAML，跳过 YAML 解析检查（可 pip install pyyaml，或用 CHECK_PYTHON 指定带 PyYAML 的解释器）"
fi

# =============================================================================
# 汇总
# =============================================================================
section "汇总"

printf '  PASS: %d    FAIL: %d    WARN: %d\n' "${PASS}" "${FAIL}" "${WARN}"

if [ "${WARN}" -gt 0 ]; then
  printf '\n%b警告（不阻塞）：%b\n%s\n' "${C_YELLOW}" "${C_RESET}" "${WARNINGS}"
fi

if [ "${FAIL}" -gt 0 ]; then
  printf '\n%b失败项：%b\n%s\n' "${C_RED}${C_BOLD}" "${C_RESET}" "${FAILURES}"
  printf '\n%bSTRUCTURE: FAIL%b（%d 项失败）\n' "${C_RED}${C_BOLD}" "${C_RESET}" "${FAIL}"
  exit 1
fi

printf '\n%bSTRUCTURE: PASS%b（%d 项检查通过）\n' "${C_GREEN}${C_BOLD}" "${C_RESET}" "${PASS}"
exit 0
