/**
 * URL 状态：`/?s=<Base64URL 无填充(UTF-8 关键词)>`
 *
 * - 打开带合法 s 的地址会自动搜索；
 * - 提交搜索时以 history.pushState 同步 URL；
 * - 监听 popstate 恢复并重新搜索；
 * - 无 s（或 s 非法）显示落地页 / 非法提示，且不自动搜索。
 */

import { MAX_BASE64_INPUT_LENGTH, base64UrlDecode, base64UrlEncode } from './base64';
import { countChars } from './validation';
import type { UrlState } from '../types';

/** 查询参数名 */
export const SEARCH_PARAM = 's';

/** 关键词长度上限（与后端的 query_max_chars 兜底值保持一致） */
export const MAX_QUERY_CHARS = 128;

/**
 * 解析 search 字符串（如 `?s=abc`）中的搜索状态。
 * 不依赖 window，便于单测。
 *
 * @param maxQueryChars 关键词码点上限，默认与后端兜底值一致；
 *   调用方可传入 `/api/config` 的 limits.query_max_chars，避免两边硬编码漂移。
 */
export function parseSearchParam(
  search: string,
  maxQueryChars: number = MAX_QUERY_CHARS,
): UrlState {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return { status: 'invalid', raw: null, reason: 'URL 查询参数无法解析' };
  }

  if (!params.has(SEARCH_PARAM)) {
    return { status: 'none' };
  }

  const raw = params.get(SEARCH_PARAM);
  if (raw === null || raw.trim() === '') {
    return { status: 'invalid', raw: raw, reason: '搜索参数 s 为空' };
  }
  if (raw.length > MAX_BASE64_INPUT_LENGTH) {
    return {
      status: 'invalid',
      raw: null,
      reason: `搜索参数 s 过长（上限 ${MAX_BASE64_INPUT_LENGTH} 字符）`,
    };
  }

  let query: string;
  try {
    query = base64UrlDecode(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : '搜索参数 s 无法解码';
    return { status: 'invalid', raw, reason };
  }

  if (query.trim() === '') {
    return { status: 'invalid', raw, reason: '搜索参数解码后为空' };
  }
  if (countChars(query) > maxQueryChars) {
    return {
      status: 'invalid',
      raw,
      reason: `关键词过长（上限 ${maxQueryChars} 字符）`,
    };
  }

  return { status: 'valid', query, raw };
}

/** 生成 `?s=...`（不含 origin/path） */
export function buildSearchSearchString(query: string): string {
  return `?${SEARCH_PARAM}=${encodeURIComponent(base64UrlEncode(query))}`;
}

/** 生成分享/地址栏使用的相对 href */
export function buildSearchHref(query: string): string {
  return `/${buildSearchSearchString(query)}`;
}

/** 从 location 读取状态（默认使用 window.location） */
export function readUrlState(locationSearch?: string, maxQueryChars?: number): UrlState {
  const search =
    locationSearch ?? (typeof window !== 'undefined' ? window.location.search : '');
  return parseSearchParam(search, maxQueryChars);
}

export interface HistoryLike {
  pushState(data: unknown, unused: string, url?: string | null): void;
  replaceState(data: unknown, unused: string, url?: string | null): void;
}

export interface LocationLike {
  href: string;
  pathname: string;
  search: string;
}

/**
 * 把搜索状态写入地址栏（pushState）。
 * 失败（如受限环境）时降级为直接赋值 location，保证功能可用。
 */
export function pushSearchState(
  query: string,
  history: HistoryLike | undefined = typeof window !== 'undefined' ? window.history : undefined,
  location: LocationLike | undefined = typeof window !== 'undefined' ? window.location : undefined,
): void {
  const href = buildSearchHref(query);
  try {
    if (history) {
      history.pushState({ query }, '', href);
      return;
    }
  } catch {
    // 继续走降级逻辑
  }
  if (location) {
    location.href = href;
  }
}

/** 回到落地页（清空 s 参数） */
export function pushLandingState(
  history: HistoryLike | undefined = typeof window !== 'undefined' ? window.history : undefined,
  location: LocationLike | undefined = typeof window !== 'undefined' ? window.location : undefined,
): void {
  try {
    if (history) {
      history.pushState({ query: null }, '', '/');
      return;
    }
  } catch {
    // 继续走降级逻辑
  }
  if (location) {
    location.href = '/';
  }
}

/** 生成完整分享链接 */
export function buildShareUrl(query: string, origin?: string): string {
  const base =
    origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}${buildSearchHref(query)}`;
}
