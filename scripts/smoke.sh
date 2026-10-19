#!/usr/bin/env bash
#
# scripts/smoke.sh —— 端到端验收脚本
#
# 启动本地 mock 上游（scripts/mock_upstream.py）与被测 release 二进制，
# 用 curl 逐项断言 API 契约、缓存、CSRF、CSP、404 等行为。
#
# 用法：
#   make smoke                 # 推荐
#   bash scripts/smoke.sh      # 等价
#
# 前置：先 `make build` 生成 target/release/ai-search-platform。
# 环境变量（一般无需设置）：
#   BIN          被测二进制路径，默认 target/release/ai-search-platform
#   MOCK_PORT    mock 端口，默认 0（随机空闲端口）
#   APP_PORT     应用端口，默认随机空闲端口
#
# 退出码：0 全部通过；1 有断言失败或环境未就绪。
#
# 注意：脚本会以项目根目录为 CWD 启动应用，因此缓存写入 ./.cache/。
#       每次运行使用唯一 query，避免历史缓存干扰缓存命中断言。

set -uo pipefail

# --- 定位项目根目录 ----------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

BIN="${BIN:-${ROOT_DIR}/target/release/ai-search-platform}"
MOCK_SCRIPT="${ROOT_DIR}/scripts/mock_upstream.py"
MOCK_PORT="${MOCK_PORT:-0}"
APP_PORT="${APP_PORT:-}"

# --- 输出辅助 ----------------------------------------------------------------
# 非 tty 时把所有颜色变量置空，避免输出里出现字面量 "[32m"。
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
info()    { printf '  %b%s%b\n' "${C_YELLOW}" "$*" "${C_RESET}"; }
pass()    { PASS=$((PASS + 1)); printf '  %b✓%b %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn()    { WARN=$((WARN + 1)); WARNINGS="${WARNINGS}${WARNINGS:+$'\n'}  - $*"; printf '  %b!%b %s\n' "${C_YELLOW}" "${C_RESET}" "$*"; }

dump_last() {
  [ -n "${LAST_BODY:-}" ] && [ -f "${LAST_BODY}" ] || return 0
  printf '    --- 最后一次响应 ---\n'
  printf '    HTTP 状态: %s\n' "${CODE:-?}"
  [ -f "${LAST_HDR}" ] && sed -n '1,12p' "${LAST_HDR}" | sed 's/^/    /'
  printf '    body: '
  head -c 1200 "${LAST_BODY}" | tr '\n' ' '
  printf '\n    --------------------\n'
}

fail() {
  FAIL=$((FAIL + 1))
  FAILURES="${FAILURES}${FAILURES:+$'\n'}  - $*"
  printf '  %b✗%b %s\n' "${C_RED}" "${C_RESET}" "$*"
  dump_last
}

# --- 断言辅助 ----------------------------------------------------------------
assert_code() { # expected desc
  if [ "${CODE}" = "$1" ]; then
    pass "$2（HTTP ${CODE}）"
  else
    fail "$2：期望 HTTP $1，实际 ${CODE}"
  fi
}

json_pred() { # expr -> true / false / ERR:...
  python3 - "${LAST_BODY:-/dev/null}" "$1" <<'PY'
"""在受限命名空间中求值断言表达式。

注意：不能用 eval(expr, globals, locals) —— genexp / 推导式只查 globals，
      会看不到 locals 里的 d。这里把表达式包进函数体，参数 d 正常可见。
"""
import json
import sys

path, expr = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
except Exception as exc:  # noqa: BLE001
    print("ERR:响应不是合法 JSON: %s" % exc)
    sys.exit(0)

# 白名单内置：够写断言，又不暴露 open/__import__ 等能力。
safe_builtins = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "float": float,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
}

namespace: dict = {}
try:
    exec(
        "def _check(d):\n    return (%s)\n" % expr,
        {"__builtins__": safe_builtins},
        namespace,
    )
    ok = bool(namespace["_check"](data))
except Exception as exc:  # noqa: BLE001
    print("ERR:表达式求值失败: %s" % exc)
    sys.exit(0)
print("true" if ok else "false")
PY
}

assert_json() { # expr desc
  local out
  out="$(json_pred "$1")"
  if [ "${out}" = "true" ]; then
    pass "$2"
  else
    fail "$2（断言: $1 -> ${out}）"
  fi
}

assert_body_not_contains() { # needle desc
  if grep -qiF -- "$1" "${LAST_BODY}" 2>/dev/null; then
    fail "$2（响应体出现了敏感串: $1）"
  else
    pass "$2"
  fi
}

assert_header_contains() { # header needle desc
  local value
  value="$(grep -i "^$1:" "${LAST_HDR}" 2>/dev/null | tail -n 1)"
  if [ -n "${value}" ] && printf '%s' "${value}" | grep -qiF -- "$2"; then
    pass "$3"
  else
    fail "$3（未匹配到响应头 $1 含 $2；实际: ${value:-<缺失>}）"
  fi
}

# --- HTTP 请求封装 -----------------------------------------------------------
# 说明：macOS 自带 bash 3.2，避免使用关联数组 / mapfile 等 bash4 特性；
#       curl 参数直接展开，不加空数组（set -u 下 bash 3.2 会报 unbound）。
CODE=""
LAST_BODY=""
LAST_HDR=""

do_curl() { # method path [curl args...]
  local method="$1" path="$2"
  shift 2
  if ! CODE="$(curl -sS --max-time 30 -X "${method}" "$@" \
      -o "${LAST_BODY}" -D "${LAST_HDR}" -w '%{http_code}' "${BASE}${path}")"; then
    CODE="000"
  fi
}

get_json() { # path [extra args]
  local path="$1"
  shift
  do_curl GET "${path}" -H "Accept: application/json" "$@"
}

post_json() { # path body [extra args]
  local path="$1" body="$2"
  shift 2
  do_curl POST "${path}" \
    -H "Content-Type: application/json" \
    -H "X-Requested-With: ai-search-platform" \
    -d "${body}" "$@"
}

post_json_no_csrf() { # path body
  do_curl POST "$1" -H "Content-Type: application/json" -d "$2"
}

post_json_bad_origin() { # path body
  do_curl POST "$1" \
    -H "Content-Type: application/json" \
    -H "X-Requested-With: ai-search-platform" \
    -H "Origin: https://evil.com" \
    -d "$2"
}

mkjson_search() { # query [force_refresh]
  python3 - "${1}" "${2:-false}" <<'PY'
import json
import sys

query, force = sys.argv[1], sys.argv[2]
payload = {"query": query, "count": 3, "need_content": True}
if force == "true":
    payload["force_refresh"] = True
else:
    payload["force_refresh"] = False
print(json.dumps(payload, ensure_ascii=False))
PY
}

mkjson_fetch() { # url
  python3 - "${1}" <<'PY'
import json
import sys

print(json.dumps({"url": sys.argv[1]}, ensure_ascii=False))
PY
}

stats_search() {
  curl -sS --max-time 5 "${MOCK_BASE}/__stats" 2>/dev/null \
    | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("search", -1))
except Exception:
    print(-1)' 2>/dev/null
}

stats_fetch() {
  curl -sS --max-time 5 "${MOCK_BASE}/__stats" 2>/dev/null \
    | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("fetch", -1))
except Exception:
    print(-1)' 2>/dev/null
}

# --- 端口与进程管理 ----------------------------------------------------------
pick_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

MOCK_PID=""
APP_PID=""
TMP=""
MOCK_BASE=""
BASE=""

cleanup() {
  local pid
  for pid in "${APP_PID}" "${MOCK_PID}"; do
    if [ -n "${pid}" ]; then
      kill "${pid}" 2>/dev/null || true
      wait "${pid}" 2>/dev/null || true
    fi
  done
  if [ -n "${TMP}" ] && [ -d "${TMP}" ]; then
    rm -rf "${TMP}"
  fi
}
trap cleanup EXIT INT TERM

# --- 前置检查 ----------------------------------------------------------------
section "0. 前置检查"

command -v python3 >/dev/null 2>&1 || { printf '缺少 python3\n' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { printf '缺少 curl\n' >&2; exit 1; }
[ -f "${MOCK_SCRIPT}" ] || { printf '缺少 %s\n' "${MOCK_SCRIPT}" >&2; exit 1; }

if [ ! -x "${BIN}" ]; then
  printf '\n%b未找到可执行文件: %s%b\n' "${C_RED}${C_BOLD}" "${BIN}" "${C_RESET}" >&2
  printf '请先执行构建：\n\n    make build\n\n' >&2
  printf '或只构建后端（前端已构建过）：\n\n    cargo build --release\n\n' >&2
  exit 1
fi
pass "二进制存在: ${BIN}"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ai-search-smoke.XXXXXX")" || { printf '无法创建临时目录\n' >&2; exit 1; }
LAST_BODY="${TMP}/last_body"
LAST_HDR="${TMP}/last_hdr"

RUN_ID="$(date +%s)-$$-${RANDOM:-0}"
QUERY="smoke-${RUN_ID}"
info "本次唯一 query: ${QUERY}"

# --- 启动 mock 上游 ----------------------------------------------------------
section "1. 启动 mock 上游"

python3 "${MOCK_SCRIPT}" --port "${MOCK_PORT}" --host 127.0.0.1 \
  >"${TMP}/mock.out" 2>"${TMP}/mock.err" &
MOCK_PID=$!

MOCK_BASE=""
i=0
while [ "${i}" -lt 100 ]; do
  MOCK_BASE="$(sed -n 's/^MOCK_UPSTREAM_READY //p' "${TMP}/mock.out" 2>/dev/null | tail -n 1)"
  [ -n "${MOCK_BASE}" ] && break
  kill -0 "${MOCK_PID}" 2>/dev/null || break
  sleep 0.1
  i=$((i + 1))
done

if [ -z "${MOCK_BASE}" ]; then
  printf '%b mock 上游启动失败，日志：%b\n' "${C_RED}" "${C_RESET}" >&2
  sed -n '1,40p' "${TMP}/mock.err" >&2
  exit 1
fi
pass "mock 上游就绪: ${MOCK_BASE}"

# --- 启动被测应用 ------------------------------------------------------------
section "2. 启动被测应用"

start_app() {
  local attempt
  for attempt in 1 2 3; do
    if [ -z "${APP_PORT}" ]; then APP_PORT="$(pick_port)"; fi
    if [ "${APP_PORT}" = "${MOCK_PORT}" ]; then APP_PORT="$(pick_port)"; fi

    env \
      DEEPSEEK_API_KEY="test-key" \
      DEEPSEEK_BASE_URL="${MOCK_BASE}" \
      BIND_ADDR="127.0.0.1:${APP_PORT}" \
      RUST_LOG="${RUST_LOG:-warn}" \
      "${BIN}" >"${TMP}/app.log" 2>&1 &
    APP_PID=$!

    BASE="http://127.0.0.1:${APP_PORT}"
    local j=0
    while [ "${j}" -lt 120 ]; do
      if curl -sS -o /dev/null --max-time 2 "${BASE}/api/health" 2>/dev/null; then
        return 0
      fi
      kill -0 "${APP_PID}" 2>/dev/null || break
      sleep 0.15
      j=$((j + 1))
    done

    info "第 ${attempt} 次启动未就绪，应用日志尾部："
    tail -n 20 "${TMP}/app.log" 2>/dev/null | sed 's/^/    /' >&2
    kill "${APP_PID}" 2>/dev/null || true
    wait "${APP_PID}" 2>/dev/null || true
    APP_PID=""
    APP_PORT=""
    sleep 0.3
  done
  return 1
}

if ! start_app; then
  printf '\n%b应用启动失败（已重试 3 次）%b\n' "${C_RED}${C_BOLD}" "${C_RESET}" >&2
  printf '排查：端口是否被占用？请确认 make build 已成功、%s 可执行。\n' "${BIN}" >&2
  exit 1
fi
pass "应用就绪: ${BASE}（pid ${APP_PID}）"

# --- 3. 健康检查 -------------------------------------------------------------
section "3. /api/health"

get_json "/api/health"
assert_code 200 "health 返回 200"
assert_json 'isinstance(d, dict) and d.get("status") == "ok"' "health.status == ok"
assert_json '"version" in d and isinstance(d["version"], str) and d["version"]' "health 含非空 version"
assert_json 'd.get("version") == "0.1.0"' "health.version == 0.1.0"

# --- 4. /api/config 不泄露密钥 ----------------------------------------------
section "4. /api/config"

get_json "/api/config"
assert_code 200 "config 返回 200"
assert_json 'isinstance(d, dict)' "config 是 JSON 对象"
assert_json 'isinstance(d.get("upstream"), dict) and d["upstream"].get("configured") is True' \
  "config.upstream.configured == true（已配置 API Key）"
assert_body_not_contains "test-key" "config 未回显 DEEPSEEK_API_KEY 明文"
assert_body_not_contains "DEEPSEEK_API_KEY" "config 未包含 DEEPSEEK_API_KEY 变量名"
assert_json '"defaults" in d and "limits" in d and "cache" in d' "config 含 defaults/limits/cache 段"

# --- 5. 搜索与缓存 -----------------------------------------------------------
section "5. /api/search：首次未命中 → 第二次命中缓存"

BEFORE_SEARCH="$(stats_search)"
info "mock 当前 search 计数: ${BEFORE_SEARCH}"

SEARCH_BODY="$(mkjson_search "${QUERY}")"
post_json "/api/search" "${SEARCH_BODY}"
assert_code 200 "首次搜索返回 200"
assert_json 'isinstance(d.get("data"), dict) and isinstance(d["data"].get("results"), list)' \
  "响应 data.results 是数组"
assert_json 'len(d["data"]["results"]) > 0' "results 非空"
assert_json 'd.get("cached") is False' "首次搜索 cached == false"
assert_json 'isinstance(d.get("cache_status"), str)' "响应含 cache_status"
assert_json 'isinstance(d.get("upstream_status"), int) and d["upstream_status"] == 200' \
  "upstream_status == 200"
assert_json 'isinstance(d.get("stored_at"), int) and isinstance(d.get("expires_at"), int)' \
  "stored_at / expires_at 为整数"
assert_json '86000 <= d["expires_at"] - d["stored_at"] <= 86800' \
  "缓存 TTL 约 86400 秒（1 天）"
FIRST_RESULT_KEYS='["rerank_score","title","url","snippet","summary","content","site_name","site_icon","date","authority"]'
assert_json "all(k in d['data']['results'][0] for k in ${FIRST_RESULT_KEYS})" \
  "结果含全部契约字段（rerank_score/title/url/.../authority）"
assert_json 'isinstance(d["data"]["results"][0].get("content"), str) and d["data"]["results"][0]["content"]' \
  "need_content 默认 true，结果含 content 正文"

AFTER_SEARCH="$(stats_search)"
if [ "${AFTER_SEARCH}" -eq "$((BEFORE_SEARCH + 1))" ]; then
  pass "首次搜索调用上游 1 次（计数 ${BEFORE_SEARCH} -> ${AFTER_SEARCH}）"
else
  fail "首次搜索应调用上游 1 次，实际 ${BEFORE_SEARCH} -> ${AFTER_SEARCH}"
fi

# 缓存文件断言
CACHE_DIR="${ROOT_DIR}/.cache/search"
if [ ! -d "${CACHE_DIR}" ]; then
  FOUND_CACHE="$(find "${ROOT_DIR}" -maxdepth 3 -type d -path '*/.cache/search' 2>/dev/null | head -n 1)"
  [ -n "${FOUND_CACHE}" ] && CACHE_DIR="${FOUND_CACHE}"
fi
if [ -d "${CACHE_DIR}" ]; then
  pass "缓存目录存在: ${CACHE_DIR}"
  CACHE_FILES="$(find "${CACHE_DIR}" -maxdepth 1 -type f 2>/dev/null)"
  CACHE_COUNT="$(printf '%s\n' "${CACHE_FILES}" | grep -c . )"
  if [ "${CACHE_COUNT}" -gt 0 ]; then
    pass "缓存目录含 ${CACHE_COUNT} 个文件"
  else
    fail "缓存目录为空，首次搜索应写入缓存文件"
  fi
  BAD_NAME=0
  BAD_NAME_SAMPLE=""
  NON_HEX_SAMPLE=""
  while IFS= read -r f; do
    [ -n "${f}" ] || continue
    base="$(basename "${f}")"
    # 允许实现附加固定后缀（如 .json）：sha256 主体必须是 64 位小写 hex。
    if ! printf '%s' "${base}" | grep -qE '^[0-9a-f]{64}(\.[A-Za-z0-9]+)?$'; then
      BAD_NAME=$((BAD_NAME + 1))
      [ -z "${NON_HEX_SAMPLE}" ] && NON_HEX_SAMPLE="${base}"
    fi
    if printf '%s' "${base}" | grep -qF -- "${QUERY}"; then
      BAD_NAME_SAMPLE="${base}"
    fi
  done <<EOF
${CACHE_FILES}
EOF
  if [ "${BAD_NAME}" -eq 0 ]; then
    pass "缓存文件名为 64 位小写 hex（sha256，允许固定后缀）"
  else
    fail "有 ${BAD_NAME} 个缓存文件名不以 64 位 hex 为主体，样例: ${NON_HEX_SAMPLE}"
  fi
  if [ -z "${BAD_NAME_SAMPLE}" ]; then
    pass "缓存文件名不包含 query 原文"
  else
    fail "缓存文件名包含 query 原文: ${BAD_NAME_SAMPLE}"
  fi
  if grep -qF -- "${QUERY}" "${CACHE_DIR}"/* 2>/dev/null; then
    warn "缓存文件内容包含 query 原文（README 声称不落原文，请确认是否预期）"
  else
    pass "缓存文件内容不包含 query 原文"
  fi
else
  fail "未找到缓存目录 .cache/search（应用可能未以项目根为 CWD 运行）"
fi

# 第二次相同请求应命中缓存
post_json "/api/search" "${SEARCH_BODY}"
assert_code 200 "第二次搜索返回 200"
assert_json 'd.get("cached") is True' "第二次相同请求 cached == true（命中缓存）"
assert_json 'len(d["data"]["results"]) > 0' "命中缓存时仍返回 results"

AFTER_CACHED="$(stats_search)"
if [ "${AFTER_CACHED}" -eq "${AFTER_SEARCH}" ]; then
  pass "命中缓存未再调用上游（计数保持 ${AFTER_CACHED}）"
else
  fail "命中缓存不应调用上游，实际 ${AFTER_SEARCH} -> ${AFTER_CACHED}"
fi

# force_refresh 应重新调用上游
FORCE_BODY="$(mkjson_search "${QUERY}" true)"
post_json "/api/search" "${FORCE_BODY}"
assert_code 200 "force_refresh 搜索返回 200"
assert_json 'd.get("cached") is False' "force_refresh 响应 cached == false"
AFTER_FORCE="$(stats_search)"
if [ "${AFTER_FORCE}" -eq "$((AFTER_CACHED + 1))" ]; then
  pass "force_refresh 再次调用上游（计数 ${AFTER_CACHED} -> ${AFTER_FORCE}）"
else
  fail "force_refresh 应再次调用上游，实际 ${AFTER_CACHED} -> ${AFTER_FORCE}"
fi

# --- 6. /api/fetch -----------------------------------------------------------
section "6. /api/fetch"

FETCH_URL="https://example.com/smoke-${RUN_ID}"
BEFORE_FETCH="$(stats_fetch)"
post_json "/api/fetch" "$(mkjson_fetch "${FETCH_URL}")"
assert_code 200 "fetch 返回 200"
assert_json 'isinstance(d.get("data"), dict)' "fetch data 是对象"
assert_json 'isinstance(d["data"].get("title"), str) and d["data"]["title"]' "fetch data.title 非空"
assert_json 'isinstance(d["data"].get("content"), str) and len(d["data"]["content"]) > 0' \
  "fetch data.content 非空（Markdown）"
assert_json 'isinstance(d.get("cached"), bool)' "fetch 响应含 cached 布尔字段"
AFTER_FETCH="$(stats_fetch)"
if [ "${AFTER_FETCH}" -eq "$((BEFORE_FETCH + 1))" ]; then
  pass "fetch 调用上游 1 次（计数 ${BEFORE_FETCH} -> ${AFTER_FETCH}）"
else
  fail "fetch 应调用上游 1 次，实际 ${BEFORE_FETCH} -> ${AFTER_FETCH}"
fi

# --- 7. CSRF 防护 ------------------------------------------------------------
section "7. CSRF 防护"

post_json_no_csrf "/api/search" "${SEARCH_BODY}"
assert_code 403 "缺少 X-Requested-With 头 → 403"

post_json_bad_origin "/api/search" "${SEARCH_BODY}"
assert_code 403 "Origin: https://evil.com → 403"

do_curl POST "/api/search" \
  -H "Content-Type: application/json" \
  -H "Origin: http://127.0.0.1:${APP_PORT}" \
  -d "${SEARCH_BODY}"
assert_code 403 "缺少 X-Requested-With（合法 Origin）仍 → 403"

# --- 8. 安全响应头：CSP ------------------------------------------------------
section "8. 安全响应头"

do_curl GET "/" -H "Accept: text/html"
if [ "${CODE}" = "200" ] || [ "${CODE}" = "304" ]; then
  pass "首页返回 ${CODE}"
else
  fail "首页期望 200/304，实际 ${CODE}"
fi
assert_header_contains "content-security-policy" "default-src 'self'" \
  "CSP 头存在且含 default-src 'self'"
# 下面两项属于加固建议而非硬性契约，缺失只告警不失败。
if grep -qi '^x-content-type-options:.*nosniff' "${LAST_HDR}" 2>/dev/null; then
  pass "X-Content-Type-Options: nosniff"
else
  warn "缺少 X-Content-Type-Options: nosniff（建议添加，非阻塞）"
fi
if grep -qi '^x-frame-options:' "${LAST_HDR}" 2>/dev/null \
   || grep -qi "frame-ancestors" "${LAST_HDR}" 2>/dev/null; then
  pass "点击劫持防护（X-Frame-Options 或 CSP frame-ancestors）"
else
  warn "未见 X-Frame-Options / CSP frame-ancestors（建议添加，非阻塞）"
fi

# --- 9. 404 返回 JSON --------------------------------------------------------
section "9. 未知路由返回 JSON"

get_json "/api/nope"
assert_code 404 "GET /api/nope 返回 404"
assert_json 'isinstance(d.get("error"), dict)' "404 响应体为 {\"error\": {...}} 结构"
assert_json '"code" in d.get("error", {}) and "message" in d.get("error", {})' \
  "错误对象含 code 与 message"

# --- 10. 汇总 ----------------------------------------------------------------
section "10. 验收汇总"

printf '  PASS: %d    FAIL: %d    WARN: %d\n' "${PASS}" "${FAIL}" "${WARN}"

if [ "${WARN}" -gt 0 ]; then
  printf '\n%b警告：%b\n%s\n' "${C_YELLOW}" "${C_RESET}" "${WARNINGS}"
fi

if [ "${FAIL}" -gt 0 ]; then
  printf '\n%b失败项：%b\n%s\n' "${C_RED}${C_BOLD}" "${C_RESET}" "${FAILURES}"
  printf '\n%bSMOKE: FAIL%b（%d 项失败）\n' "${C_RED}${C_BOLD}" "${C_RESET}" "${FAIL}"
  printf '应用日志: %s/app.log（临时目录已清理，如需保留请手动启动复核）\n' "${TMP}"
  exit 1
fi

printf '\n%bSMOKE: PASS%b（%d 项断言全部通过）\n' "${C_GREEN}${C_BOLD}" "${C_RESET}" "${PASS}"
exit 0
