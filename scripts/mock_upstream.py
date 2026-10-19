#!/usr/bin/env python3
"""本地 mock 上游服务：模拟 DeepSeek Search / Fetch API。

仅使用 Python 3 标准库（http.server.ThreadingHTTPServer），用于本地开发与
scripts/smoke.sh 端到端验收，避免测试时真实消耗上游额度。

提供的端点
----------
POST /v1/tools/search       搜索（Bearer 鉴权）
POST /v1/tools/fetch        抓取单页（Bearer 鉴权）
GET  /__stats               调用计数（JSON）
POST /__reset               清零计数（JSON）

Search 场景（按 query 子串匹配，优先级从高到低）
------------------------------------------------
    ratelimit     429 + Retry-After: 2 + OpenAI 兼容错误体
    unauthorized  401
    notfound      404
    badjson       200 但返回非 JSON 纯文本
    boom          500
    slow          先 sleep 3 秒再正常返回（用于超时验证）
    nasty         带 XSS payload 的结果（验证前端不执行）
    empty         {"results": []}
    其它          3 条全字段结果（含 Markdown content）

Fetch 场景（按 url 子串匹配）
-----------------------------
    fail          404
    nasty         含 XSS payload 的 Markdown
    其它          {"title", "content"}，content 为 Markdown

鉴权
----
所有 /v1/* 端点要求 ``Authorization: Bearer <token>``，缺失或格式错误返回 401。

用法
----
    python3 scripts/mock_upstream.py                       # 127.0.0.1:9000
    python3 scripts/mock_upstream.py --port 0              # 随机空闲端口
    python3 scripts/mock_upstream.py --port 9000 --host 0.0.0.0

每个请求都会向 stderr 打一行日志，便于人工统计上游调用次数；
脚本化统计请使用 GET /__stats。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9000
MAX_BODY_BYTES = 4 * 1024 * 1024  # 4 MiB，防止本地误用时被打爆
SLOW_SECONDS = 3.0

# OpenAI 兼容错误体（上游 /v1/tools/* 的错误结构）
OPENAI_ERROR_TYPES = {
    400: "invalid_request_error",
    401: "authentication_error",
    402: "insufficient_quota",
    403: "permission_error",
    404: "not_found_error",
    408: "timeout_error",
    413: "payload_too_large",
    429: "rate_limit_error",
    500: "server_error",
    504: "upstream_timeout",
}


# ---------------------------------------------------------------------------
# 请求计数（线程安全）
# ---------------------------------------------------------------------------


class CallCounter:
    """记录各端点的调用次数，供 /__stats 与 smoke 断言使用。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.search = 0
        self.fetch = 0
        self.other = 0
        self.started_at = time.time()

    def hit(self, kind: str) -> int:
        with self._lock:
            if kind == "search":
                self.search += 1
                return self.search
            if kind == "fetch":
                self.fetch += 1
                return self.fetch
            self.other += 1
            return self.other

    def reset(self) -> None:
        with self._lock:
            self.search = 0
            self.fetch = 0
            self.other = 0
            self.started_at = time.time()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "search": self.search,
                "fetch": self.fetch,
                "other": self.other,
                "total": self.search + self.fetch + self.other,
                "uptime_seconds": round(time.time() - self.started_at, 3),
                "pid": os.getpid(),
            }


COUNTER = CallCounter()


# ---------------------------------------------------------------------------
# 场景数据
# ---------------------------------------------------------------------------


def full_field_results() -> list[dict[str, Any]]:
    """默认场景：3 条全字段结果，覆盖前端渲染需要的所有字段。"""
    return [
        {
            "rerank_score": 0.9731,
            "title": "Rust 异步编程完全指南：从 Future 到 Tokio",
            "url": "https://example.com/rust-async-guide",
            "snippet": "本文系统讲解 Rust 异步编程模型，包括 Future trait、状态机、waker 机制以及 Tokio 运行时的调度策略。",
            "summary": "从 Future 到 Tokio 的 Rust 异步编程体系化讲解，适合已掌握所有权与生命周期的读者。",
            "content": (
                "# Rust 异步编程完全指南\n\n"
                "## 1. Future 是什么\n\n"
                "`Future` 是一个可以处于「未完成」状态的**状态机**，其核心方法为 `poll`。\n\n"
                "```rust\npub trait Future {\n    type Output;\n    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>;\n}\n```\n\n"
                "## 2. Waker 与唤醒\n\n"
                "- Waker 由执行器注入\n"
                "- 状态就绪时调用 `wake()`\n"
                "- Tokio 使用工作窃取（work-stealing）调度\n\n"
                "## 3. 常见陷阱\n\n"
                "1. 在 async 块里做 CPU 密集计算会阻塞执行器\n"
                "2. 跨 `await` 持有 `MutexGuard` 会导致死锁风险\n"
            ),
            "site_name": "Example 技术博客",
            "site_icon": "https://example.com/favicon.ico",
            "date": "2025-11-02",
            "authority": "high",
        },
        {
            "rerank_score": 0.8842,
            "title": "axum 0.8 中间件与提取器实践",
            "url": "https://docs.example.org/axum-0-8-middleware",
            "snippet": "axum 0.8 的 Router、Layer、提取器组合技巧，含自定义中间件与错误处理示例。",
            "summary": "通过实例演示 axum 0.8 中 tower 中间件栈的组装方式与提取器设计。",
            "content": (
                "# axum 0.8 中间件与提取器实践\n\n"
                "## 中间件顺序\n\n"
                "`layer` 是**自下而上**生效的：先添加的 layer 位于更外层。\n\n"
                "```rust\nlet app = Router::new()\n    .route(\"/api/health\", get(health))\n    .layer(TraceLayer::new_for_http())\n    .layer(SetResponseHeaderLayer::overriding(\n        header::CONTENT_SECURITY_POLICY,\n        HeaderValue::from_static(\"default-src 'self'\"),\n    ));\n```\n\n"
                "## 提取器\n\n"
                "- `Json<T>` 要求 `Content-Type: application/json`\n"
                "- `State<S>` 常与 `FromRef` 搭配做状态拆分\n"
            ),
            "site_name": "Example Docs",
            "site_icon": "https://docs.example.org/assets/icon.png",
            "date": "2026-01-18",
            "authority": "medium",
        },
        {
            "rerank_score": 0.6120,
            "title": "搜索引擎排序指标入门：NDCG、MRR 与 Recall@K",
            "url": "https://blog.example.net/ranking-metrics",
            "snippet": "介绍常用检索排序评估指标，并给出计算示例与适用场景。",
            "summary": "对比 NDCG、MRR、Recall@K 三类排序指标的适用边界。",
            "content": (
                "# 搜索引擎排序指标入门\n\n"
                "## NDCG\n\n"
                "归一化折损累计增益，强调**位置越靠前权重越大**。\n\n"
                "## MRR\n\n"
                "平均倒数排名，只关心第一个相关结果出现的位置。\n\n"
                "## Recall@K\n\n"
                "前 K 个结果中命中的相关文档占比，常用于召回阶段。\n"
            ),
            "site_name": "Example Blog",
            "site_icon": "https://blog.example.net/favicon.svg",
            "date": "2024-06-30",
            "authority": "low",
        },
    ]


XSS_TITLE = (
    "XSS 测试标题 <script>alert('mock-xss-title')</script>"
    "<img src=x onerror=\"alert('mock-xss-img')\">"
)

XSS_SNIPPET = (
    "片段中的 XSS：<script>alert('mock-xss-snippet')</script> "
    "<img src=x onerror=alert('mock-xss-snippet-img')> "
    "<a href=\"javascript:alert('mock-xss-snippet-link')\">点我</a>"
)

XSS_SUMMARY = (
    "摘要注入：<svg/onload=alert('mock-xss-summary')> "
    "<iframe src=\"javascript:alert('mock-xss-iframe')\"></iframe>"
)

XSS_CONTENT = (
    "# 含 XSS payload 的正文\n\n"
    "下面包含多种注入向量，用于验证前端渲染时**不会执行**脚本。\n\n"
    "<script>alert('mock-xss-content')</script>\n\n"
    "<img src=x onerror=\"alert('mock-xss-content-img')\">\n\n"
    "<svg/onload=alert('mock-xss-content-svg')>\n\n"
    "[危险链接](javascript:alert('mock-xss-content-link'))\n\n"
    "> <iframe src=\"javascript:alert('mock-xss-content-iframe')\"></iframe>\n\n"
    "SQL 注入样式字符串（应原样显示）：`' OR '1'='1`\n"
)

XSS_URL = "javascript:alert('mock-xss-url')"


def nasty_results() -> list[dict[str, Any]]:
    """XSS 场景：所有可渲染字段都塞入 payload。"""
    base = full_field_results()
    base[0].update(
        {
            "title": XSS_TITLE,
            "url": XSS_URL,
            "snippet": XSS_SNIPPET,
            "summary": XSS_SUMMARY,
            "content": XSS_CONTENT,
            "site_name": "<script>alert('mock-xss-site-name')</script>",
            "site_icon": "javascript:alert('mock-xss-icon')",
            "authority": "<svg/onload=alert('mock-xss-authority')>",
        }
    )
    # 第二条给一个正常的 https 链接但标题含 payload，便于对比
    base[1].update(
        {
            "title": "<img src=x onerror=alert('mock-xss-title-2')>axum 中间件",
            "snippet": "正常文本 + <script>alert('mock-xss-snippet-2')</script>",
            "summary": "<a href=\"javascript:alert('mock-xss-summary-2')\">摘要链接</a>",
        }
    )
    return base


def nasty_markdown() -> str:
    """fetch 的 XSS Markdown 场景。"""
    return (
        "# 含 XSS 的 Markdown 页面\n\n"
        "<script>alert('mock-xss-fetch')</script>\n\n"
        "<img src=x onerror=\"alert('mock-xss-fetch-img')\">\n\n"
        "[点击](javascript:alert('mock-xss-fetch-link'))\n\n"
        "<iframe src=\"javascript:alert('mock-xss-fetch-iframe')\"></iframe>\n\n"
        "正常段落：这是一段应当被正常渲染的 **加粗** 文本。\n\n"
        "- 列表项 A\n- 列表项 B\n"
    )


DEFAULT_FETCH_MARKDOWN = "# 标题\n\n正文 **bold**\n\n- a\n- b"


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------


def openai_error(
    message: str,
    err_type: str,
    code: str,
    param: str | None = None,
) -> dict[str, Any]:
    """构造 OpenAI 兼容错误体：{"error": {"message","type","param","code"}}。"""
    return {
        "error": {
            "message": message,
            "type": err_type,
            "param": param,
            "code": code,
        }
    }


def status_type(status: int) -> str:
    return OPENAI_ERROR_TYPES.get(status, "api_error")


def log(message: str) -> None:
    """所有日志统一走 stderr，保证 stdout 干净。"""
    stamp = time.strftime("%H:%M:%S")
    print(f"[mock-upstream {stamp}] {message}", file=sys.stderr, flush=True)


def now_unix() -> int:
    return int(time.time())


def search_payload() -> dict[str, Any]:
    """默认成功搜索响应（与上游契约一致：{"results": [...]}）。"""
    return {"results": full_field_results()}


def fetch_payload(url: str) -> dict[str, Any]:
    """默认成功 fetch 响应：{"title","content"}，content 为 Markdown。"""
    title = "示例页面标题"
    if "example.com" in url:
        title = "Example 示例页面"
    return {
        "title": title,
        "content": DEFAULT_FETCH_MARKDOWN,
    }


# ---------------------------------------------------------------------------
# HTTP 处理器
# ---------------------------------------------------------------------------


class MockUpstreamHandler(BaseHTTPRequestHandler):
    """ThreadingHTTPServer 的请求处理器。"""

    server_version = "MockUpstream/1.0"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # 由 run_server 注入
    counter: CallCounter = COUNTER
    quiet: bool = False

    # -- 基础 I/O ---------------------------------------------------------

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        # 默认实现会往 stderr 打通用日志；这里统一走 log() 以便加前缀。
        if self.quiet:
            return
        log("%s - %s" % (self.address_string(), fmt % args))

    def _read_body(self) -> bytes | None:
        """读取请求体；超限返回 None。"""
        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                return self._read_chunked()
            return b""
        try:
            length = int(raw_len)
        except (TypeError, ValueError):
            return b""
        if length < 0 or length > MAX_BODY_BYTES:
            return None
        return self.rfile.read(length)

    def _read_chunked(self) -> bytes | None:
        chunks: list[bytes] = []
        total = 0
        while True:
            line = self.rfile.readline(65536)
            if not line:
                break
            try:
                size = int(line.split(b";", 1)[0].strip(), 16)
            except ValueError:
                return b""
            if size == 0:
                # 吃掉 trailer
                while True:
                    trailer = self.rfile.readline(65536)
                    if trailer in (b"\r\n", b"\n", b""):
                        break
                break
            total += size
            if total > MAX_BODY_BYTES:
                return None
            chunks.append(self.rfile.read(size))
            self.rfile.read(2)  # CRLF
        return b"".join(chunks)

    def _send_json(self, status: int, payload: Any, extra_headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(
        self,
        status: int,
        message: str,
        code: str,
        *,
        param: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        payload = openai_error(message, status_type(status), code, param)
        self._send_json(status, payload, extra_headers)

    def _send_text(self, status: int, text: str, content_type: str = "text/plain; charset=utf-8") -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # -- 鉴权 -------------------------------------------------------------

    def _check_auth(self) -> bool:
        """校验 Authorization: Bearer <token>；失败时自行回写 401。"""
        header = self.headers.get("Authorization", "")
        value = header.strip()
        if not value:
            self._send_error_json(
                401,
                "Missing Authorization header. Expected 'Authorization: Bearer <api-key>'.",
                "missing_authorization",
            )
            return False
        parts = value.split(None, 1)
        if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
            self._send_error_json(
                401,
                "Invalid Authorization header format. Expected 'Bearer <api-key>'.",
                "invalid_authorization",
            )
            return False
        return True

    # -- 路由 -------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        path = self._path_only()
        if path in ("/__stats", "/stats"):
            self._handle_stats()
            return
        if path in ("/__health", "/health", "/"):
            self._send_json(200, {"status": "ok", "service": "mock-upstream", "endpoints": [
                "/v1/tools/search", "/v1/tools/fetch", "/__stats", "/__reset",
            ]})
            return
        self.counter.hit("other")
        self._send_error_json(404, f"Unknown path: {path}", "unknown_path")

    def do_POST(self) -> None:  # noqa: N802
        path = self._path_only()

        if path == "/__reset":
            self._drain_body()
            self.counter.reset()
            log("stats reset")
            self._send_json(200, {"reset": True, "stats": self.counter.snapshot()})
            return

        if path == "/v1/tools/search":
            self._handle_search()
            return

        if path == "/v1/tools/fetch":
            self._handle_fetch()
            return

        self.counter.hit("other")
        self._drain_body()
        self._send_error_json(404, f"Unknown path: {path}", "unknown_path")

    def do_OPTIONS(self) -> None:  # noqa: N802
        # 仅用于本地调试时观察预检行为；生产上游一般允许。
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Allow", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- 具体端点 ---------------------------------------------------------

    def _handle_stats(self) -> None:
        self._send_json(200, self.counter.snapshot())

    def _handle_search(self) -> None:
        self.counter.hit("search")
        seq = self.counter.search

        if not self._check_auth():
            return

        raw = self._read_body()
        if raw is None:
            self._send_error_json(413, "Request body too large.", "payload_too_large")
            return

        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._send_error_json(400, f"Invalid JSON body: {exc}", "invalid_json")
            return

        if not isinstance(payload, dict):
            self._send_error_json(400, "Request body must be a JSON object.", "invalid_body")
            return

        query = payload.get("query")
        if not isinstance(query, str) or not query.strip():
            self._send_error_json(400, "Missing required field: query", "missing_query", param="query")
            return

        count = payload.get("count", 10)
        if not isinstance(count, int) or isinstance(count, bool) or not (1 <= count <= 50):
            self._send_error_json(400, "count must be an integer in [1, 50].", "invalid_count", param="count")
            return

        needle = query.lower()
        log(f"search #{seq} query={query!r} count={count} "
            f"need_content={payload.get('need_content')} localization={payload.get('localization')!r}")

        if "ratelimit" in needle:
            self._send_error_json(
                429,
                "Rate limit reached for requests. Please try again in 2 seconds.",
                "rate_limit_exceeded",
                extra_headers={"Retry-After": "2"},
            )
            return

        if "unauthorized" in needle:
            self._send_error_json(401, "Invalid API key provided.", "invalid_api_key")
            return

        if "notfound" in needle:
            self._send_error_json(404, "The requested upstream resource was not found.", "not_found")
            return

        if "badjson" in needle:
            # 故意返回非 JSON 文本，用于验证后端对畸形上游响应的处理
            self._send_text(200, "this is definitely not json <<<>>>{\"broken\":", "text/plain; charset=utf-8")
            return

        if "boom" in needle:
            self._send_error_json(500, "Internal server error occurred while processing the request.", "internal_error")
            return

        if "slow" in needle:
            log(f"slow scenario: sleeping {SLOW_SECONDS}s")
            time.sleep(SLOW_SECONDS)

        if "empty" in needle:
            self._send_json(200, {"results": []})
            return

        if "nasty" in needle:
            self._send_json(200, {"results": nasty_results()})
            return

        self._send_json(200, search_payload())

    def _handle_fetch(self) -> None:
        self.counter.hit("fetch")
        seq = self.counter.fetch

        if not self._check_auth():
            return

        raw = self._read_body()
        if raw is None:
            self._send_error_json(413, "Request body too large.", "payload_too_large")
            return

        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._send_error_json(400, f"Invalid JSON body: {exc}", "invalid_json")
            return

        if not isinstance(payload, dict):
            self._send_error_json(400, "Request body must be a JSON object.", "invalid_body")
            return

        url = payload.get("url")
        if not isinstance(url, str) or not url.strip():
            self._send_error_json(400, "Missing required field: url", "missing_url", param="url")
            return

        log(f"fetch #{seq} url={url!r}")
        needle = url.lower()

        if "fail" in needle:
            self._send_error_json(404, "The requested page could not be fetched (not found).", "fetch_not_found")
            return

        if "nasty" in needle:
            self._send_json(200, {"title": "含 XSS 的页面 <script>alert('mock-xss-fetch-title')</script>",
                                  "content": nasty_markdown()})
            return

        self._send_json(200, fetch_payload(url))

    # -- 辅助 -------------------------------------------------------------

    def _path_only(self) -> str:
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        return path or "/"

    def _drain_body(self) -> None:
        try:
            raw = self._read_body()
        except Exception:  # noqa: BLE001 - 调试服务，吞掉即可
            return
        del raw

    def date_time_string(self, timestamp: float | None = None) -> str:
        # 固定格式的 Date 头，避免依赖本机 locale 行为（保留标准实现效果）。
        return super().date_time_string(timestamp)


# ---------------------------------------------------------------------------
# 服务器启动
# ---------------------------------------------------------------------------


class MockUpstreamServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run_server(host: str, port: int, quiet: bool = False) -> int:
    MockUpstreamHandler.quiet = quiet
    try:
        server = MockUpstreamServer((host, port), MockUpstreamHandler)
    except OSError as exc:
        print(f"[mock-upstream] 无法绑定 {host}:{port} -> {exc}", file=sys.stderr)
        return 1

    actual_host, actual_port = server.server_address[0], server.server_address[1]
    # 关键：输出一行机器可解析的 READY 信息到 stdout，smoke 脚本据此拿端口。
    print(f"MOCK_UPSTREAM_READY http://{actual_host}:{actual_port}", flush=True)
    log(f"listening on http://{actual_host}:{actual_port} (stats: /__stats)")
    log("scenarios: search -> empty|nasty|ratelimit|boom|unauthorized|notfound|badjson|slow ; "
        "fetch -> fail|nasty")

    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        log("KeyboardInterrupt, shutting down")
    finally:
        server.shutdown()
        server.server_close()
        log("stopped")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="模拟 DeepSeek Search / Fetch 上游的本地 mock 服务（仅标准库）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口（0 表示随机空闲端口）")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址")
    parser.add_argument("--quiet", action="store_true", help="不在 stderr 打印逐请求日志")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    return run_server(args.host, args.port, quiet=args.quiet)


if __name__ == "__main__":
    sys.exit(main())
