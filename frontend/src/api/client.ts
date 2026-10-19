/**
 * 后端 API 客户端。
 *
 * 约定（来自后端契约）：
 * - POST 必须带 Content-Type: application/json 与 X-Requested-With: ai-search-platform，
 *   否则后端返回 403；
 * - fetch 统一 credentials: 'same-origin', cache: 'no-store'；
 * - 错误统一为 {"error":{code,message,retryable,upstream_status,retry_after_seconds}}。
 */

import { normalizeApiError, normalizeFetchEnvelope, normalizeSearchEnvelope } from '../lib/normalize';
import type { NormalizedError } from '../lib/normalize';
import {
  FALLBACK_DEFAULTS,
  clampNumber,
  normalizeLimits,
  toBooleanOr,
  toFiniteNumber,
  toRecord,
  toStringOrNull,
} from '../lib/validation';
import type {
  AppConfig,
  FetchEnvelope,
  FetchRequest,
  SearchEnvelope,
  SearchRequest,
} from '../types';

/** 后端要求的自定义请求头值 */
export const REQUESTED_WITH_VALUE = 'ai-search-platform';

/** API 根路径（同源） */
export const API_BASE = '/api';

/** 业务错误码（与后端契约对齐） */
export type ApiErrorCode =
  | 'invalid_request'
  | 'upstream_not_configured'
  | 'upstream_auth_failed'
  | 'upstream_rate_limited'
  | 'upstream_error'
  | 'upstream_timeout'
  | 'upstream_invalid_response'
  | 'payload_too_large'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'internal_error'
  | (string & {});

/** 统一的 API 错误 */
export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly upstreamStatus: number | null;
  readonly retryAfterSeconds: number | null;
  readonly httpStatus: number | null;
  readonly raw: unknown;

  constructor(params: {
    code: string;
    message: string;
    retryable?: boolean;
    upstreamStatus?: number | null;
    retryAfterSeconds?: number | null;
    httpStatus?: number | null;
    raw?: unknown;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.code = params.code;
    this.retryable = params.retryable ?? false;
    this.upstreamStatus = params.upstreamStatus ?? null;
    this.retryAfterSeconds = params.retryAfterSeconds ?? null;
    this.httpStatus = params.httpStatus ?? null;
    this.raw = params.raw ?? null;
  }

  get normalized(): NormalizedError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      upstreamStatus: this.upstreamStatus,
      retryAfterSeconds: this.retryAfterSeconds,
      raw: this.raw ?? {
        error: {
          code: this.code,
          message: this.message,
          retryable: this.retryable,
          upstream_status: this.upstreamStatus,
          retry_after_seconds: this.retryAfterSeconds,
        },
      },
    };
  }
}

/** 网络/解析层错误（未拿到结构化错误体） */
export class NetworkError extends ApiError {
  constructor(message: string, raw: unknown = null) {
    super({ code: 'network_error', message, retryable: true, raw });
    this.name = 'NetworkError';
  }
}

/** 请求被取消 */
export class AbortedError extends ApiError {
  constructor() {
    super({ code: 'aborted', message: '请求已取消', retryable: false });
    this.name = 'AbortedError';
  }
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as { name?: unknown; code?: unknown };
  return record.name === 'AbortError' || record.code === 'ABORT_ERR' || record.code === 20;
}

/** 错误码 → 中文可读提示（未覆盖的码回退后端 message） */
const ERROR_CODE_HINTS: Record<string, string> = {
  invalid_request: '请求参数不合法，请检查关键词与高级设置。',
  upstream_not_configured: '上游服务尚未配置，请联系管理员。',
  upstream_auth_failed: '上游服务认证失败，请联系管理员检查密钥。',
  upstream_rate_limited: '上游服务限流，请稍后重试。',
  upstream_error: '上游服务返回错误。',
  upstream_timeout: '上游服务超时，请稍后重试。',
  upstream_invalid_response: '上游返回了无法解析的响应。',
  payload_too_large: '响应内容过大，已超出处理上限。',
  forbidden: '请求被拒绝（可能是缺少必要的请求头）。',
  not_found: '接口不存在。',
  rate_limited: '请求过于频繁，请稍后重试。',
  internal_error: '服务内部错误，请稍后重试。',
  network_error: '网络异常，请检查连接后重试。',
};

export function friendlyErrorMessage(error: ApiError): string {
  const hint = ERROR_CODE_HINTS[error.code];
  if (hint === undefined) {
    return error.message;
  }
  // 后端 message 往往更具体，优先保留它；两者不同时拼接。
  if (error.message && error.message !== hint) {
    return `${hint}（${error.message}）`;
  }
  return hint;
}

interface RequestOptions {
  signal?: AbortSignal;
}

async function parseJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { __unparsableText: text };
  }
}

async function requestJson(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: signal ?? null,
      headers: {
        Accept: 'application/json',
        ...init.headers,
      },
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new AbortedError();
    }
    throw new NetworkError(
      error instanceof Error ? `网络请求失败：${error.message}` : '网络请求失败',
    );
  }

  const body = await parseJsonSafely(response);

  if (!response.ok) {
    const normalized = normalizeApiError(body);
    // 后端返回了结构化错误体时以它为准
    if (typeof body === 'object' && body !== null && 'error' in body) {
      throw new ApiError({
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        upstreamStatus: normalized.upstreamStatus,
        retryAfterSeconds: normalized.retryAfterSeconds,
        httpStatus: response.status,
        raw: body,
      });
    }
    throw new ApiError({
      code: mapHttpStatusToCode(response.status),
      message: `请求失败（HTTP ${response.status}）`,
      retryable: response.status >= 500 || response.status === 429,
      httpStatus: response.status,
      raw: body,
    });
  }

  return body;
}

function mapHttpStatusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 413:
      return 'payload_too_large';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'internal_error' : 'invalid_request';
  }
}

/** GET /api/config */
export async function getConfig(options: RequestOptions = {}): Promise<AppConfig> {
  const body = await requestJson('/config', { method: 'GET' }, options.signal);
  const record = toRecord(body);
  const defaults = toRecord(record['defaults']);
  const cache = toRecord(record['cache']);
  const upstream = toRecord(record['upstream']);
  // 复用同一套 limits 归一化逻辑（字段缺失/类型异常都有兜底）
  const limits = normalizeLimits(record['limits']);

  return {
    version: toStringOrNull(record['version']) ?? '0.1.0',
    defaults: {
      // 兜底值与后端 config::DEFAULT_COUNT 保持一致（50），并收敛到 limits 区间/取整，
      // 避免异常配置把小数/越界值带进后续 validateCount。
      count: clampNumber(
        toFiniteNumber(defaults['count'], FALLBACK_DEFAULTS.count),
        limits.count_min,
        limits.count_max,
        FALLBACK_DEFAULTS.count,
      ),
      need_content: toBooleanOr(defaults['need_content'], FALLBACK_DEFAULTS.need_content),
      ori_question: toStringOrNull(defaults['ori_question']) ?? FALLBACK_DEFAULTS.ori_question,
      localization: toStringOrNull(defaults['localization']) ?? FALLBACK_DEFAULTS.localization,
    },
    limits,
    cache: {
      search_enabled: toBooleanOr(cache['search_enabled'], true),
      search_ttl_seconds: toFiniteNumber(cache['search_ttl_seconds'], 86_400),
      fetch_enabled: toBooleanOr(cache['fetch_enabled'], true),
      fetch_ttl_seconds: toFiniteNumber(cache['fetch_ttl_seconds'], 86_400),
    },
    upstream: {
      configured: toBooleanOr(upstream['configured'], false),
    },
  };
}

/** POST /api/search */
export async function search(
  payload: SearchRequest,
  options: RequestOptions = {},
): Promise<SearchEnvelope> {
  const body = await requestJson(
    '/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': REQUESTED_WITH_VALUE,
      },
      body: JSON.stringify(payload),
    },
    options.signal,
  );
  return normalizeSearchEnvelope(body);
}

/** POST /api/fetch */
export async function fetchUrl(
  payload: FetchRequest,
  options: RequestOptions = {},
): Promise<FetchEnvelope> {
  const body = await requestJson(
    '/fetch',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': REQUESTED_WITH_VALUE,
      },
      body: JSON.stringify(payload),
    },
    options.signal,
  );
  return normalizeFetchEnvelope(body);
}
