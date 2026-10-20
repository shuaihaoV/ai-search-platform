/**
 * 全站共享类型定义。
 *
 * 与后端契约严格对应；但响应解析一律经由 lib/normalize.ts 做防御性收敛，
 * 因为上游返回字段可能缺失、为 null 或类型异常。
 */

/** GET /api/health */
export interface HealthResponse {
  status: string;
  version: string;
}

/** /api/config 中的 defaults 段 */
export interface AppDefaults {
  count: number;
  need_content: boolean;
  ori_question: string;
  localization: string;
}

/** /api/config 中的 limits 段 */
export interface AppLimits {
  count_min: number;
  count_max: number;
  query_max_chars: number;
  ori_question_max_chars: number;
  fetch_url_max_chars: number;
}

/** /api/config 中的 cache 段 */
export interface CacheConfig {
  search_enabled: boolean;
  search_ttl_seconds: number;
  fetch_enabled: boolean;
  fetch_ttl_seconds: number;
}

/** /api/config 中的 upstream 段 */
export interface UpstreamConfig {
  configured: boolean;
}

/** GET /api/config */
export interface AppConfig {
  version: string;
  defaults: AppDefaults;
  limits: AppLimits;
  cache: CacheConfig;
  upstream: UpstreamConfig;
  /** 访问密码门禁状态 */
  auth: AuthConfig;
}

export interface AuthConfig {
  enabled: boolean;
}

/** POST /api/search 请求体 */
export interface SearchRequest {
  query: string;
  count?: number;
  ori_question?: string | null;
  localization?: string | null;
  need_content?: boolean;
  force_refresh?: boolean;
}

/** POST /api/fetch 请求体 */
export interface FetchRequest {
  url: string;
  force_refresh?: boolean;
}

/** 后端统一错误体 */
export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  upstream_status: number | null;
  retry_after_seconds: number | null;
}

export interface ApiErrorResponse {
  error: ApiErrorBody;
}

/** 单条搜索结果（原始字段，全部可能缺失或为 null） */
export interface RawResultItem {
  rerank_score?: number | null;
  title?: string | null;
  url?: string | null;
  snippet?: string | null;
  summary?: string | null;
  content?: string | null;
  site_name?: string | null;
  site_icon?: string | null;
  date?: string | null;
  authority?: number | null;
  [key: string]: unknown;
}

/** 搜索成功响应外层结构 */
export interface RawSearchEnvelope {
  cached?: boolean;
  cache_status?: string;
  cache_age_seconds?: number;
  stored_at?: number;
  expires_at?: number;
  upstream_status?: number;
  elapsed_ms?: number;
  data?: {
    results?: RawResultItem[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** 抓取成功响应外层结构 */
export interface RawFetchEnvelope {
  cached?: boolean;
  cache_status?: string;
  cache_age_seconds?: number;
  stored_at?: number;
  expires_at?: number;
  upstream_status?: number;
  elapsed_ms?: number;
  data?: {
    title?: string;
    content?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** 缓存状态（未知值一律归为 unknown） */
export type CacheStatus = 'hit' | 'miss' | 'unknown';

/** 规范化后的单条结果 */
export interface NormalizedResult {
  /** 在原 results 数组中的下标 */
  index: number;
  rerankScore: number | null;
  title: string | null;
  url: string | null;
  snippet: string | null;
  summary: string | null;
  content: string | null;
  siteName: string | null;
  siteIcon: string | null;
  /** 原始日期字符串 */
  dateRaw: string | null;
  /** 能否被 Date 解析 */
  dateValid: boolean;
  /** 本地化后的日期文本；非法时为原始字符串 */
  dateText: string | null;
  authority: number | null;
  /** 契约之外、但结果对象中出现的字段 */
  extra: Record<string, unknown>;
  /** 原始值，用于“原始 JSON”展示 */
  raw: unknown;
  /** results 中的非对象项：降级为原始 JSON 展示 */
  isObject: boolean;
}

/** 规范化后的搜索响应 */
export interface SearchEnvelope {
  cached: boolean | null;
  cacheStatus: CacheStatus;
  cacheAgeSeconds: number | null;
  storedAt: number | null;
  expiresAt: number | null;
  upstreamStatus: number | null;
  elapsedMs: number | null;
  results: NormalizedResult[];
  /** data 中除 results 之外的字段 */
  extraData: Record<string, unknown>;
  /** 外层除已知字段之外的字段 */
  extraTop: Record<string, unknown>;
  /** 原始响应体（用于“原始响应 JSON”） */
  raw: unknown;
}

/** 规范化后的抓取响应 */
export interface FetchEnvelope {
  cached: boolean | null;
  cacheStatus: CacheStatus;
  cacheAgeSeconds: number | null;
  storedAt: number | null;
  expiresAt: number | null;
  upstreamStatus: number | null;
  elapsedMs: number | null;
  title: string | null;
  content: string | null;
  /** data 中除 title/content 之外的字段 */
  extraData: Record<string, unknown>;
  /** 外层未知字段 */
  extraTop: Record<string, unknown>;
  raw: unknown;
}

/** 搜索页“请求参数回显”用 */
export interface RequestEcho {
  query: string;
  count: number;
  need_content: boolean;
  ori_question: string | null;
  localization: string | null;
  force_refresh: boolean;
}

/** 主题模式 */
export type ThemeMode = 'auto' | 'light' | 'dark';

/** 高级设置（不含 query，query 由搜索框独立管理） */
export interface SearchSettings {
  count: number;
  need_content: boolean;
  ori_question: string;
  localization: string;
  force_refresh: boolean;
}

/** URL 中 s 参数的解析结果 */
export type UrlState =
  | { status: 'none' }
  | { status: 'valid'; query: string; raw: string }
  | { status: 'invalid'; raw: string | null; reason: string };

/** 异步请求状态机 */
export type RequestStatus = 'idle' | 'loading' | 'success' | 'error';

/** 轻提示语气 */
export type NotifyTone = 'info' | 'success' | 'error';

/** 轻提示回调 */
export type NotifyFn = (message: string, tone?: NotifyTone) => void;
