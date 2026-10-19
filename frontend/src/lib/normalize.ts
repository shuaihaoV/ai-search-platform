/**
 * 响应规范化：把所有外部数据收敛为可安全渲染的结构。
 *
 * 任何字段缺失 / 为 null / 类型异常都不能导致渲染崩溃。
 */

import { formatResultDate } from './format';
import { toRecord } from './validation';
import { toSafeHttpUrl } from './safeUrl';
import type {
  CacheStatus,
  FetchEnvelope,
  NormalizedResult,
  RawFetchEnvelope,
  RawSearchEnvelope,
  SearchEnvelope,
} from '../types';

const KNOWN_RESULT_KEYS = new Set([
  'rerank_score',
  'title',
  'url',
  'snippet',
  'summary',
  'content',
  'site_name',
  'site_icon',
  'date',
  'authority',
]);

const KNOWN_TOP_KEYS = new Set([
  'cached',
  'cache_status',
  'cache_age_seconds',
  'stored_at',
  'expires_at',
  'upstream_status',
  'elapsed_ms',
  'data',
]);

function toCacheStatus(value: unknown): CacheStatus {
  return value === 'hit' || value === 'miss' ? value : 'unknown';
}

function toNullableString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function collectExtra(
  source: Record<string, unknown>,
  known: Set<string>,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (!known.has(key)) {
      extra[key] = source[key];
    }
  }
  return extra;
}

/** 单条结果规范化 */
export function normalizeResult(raw: unknown, index: number): NormalizedResult {
  const isObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
  const record = toRecord(raw);

  let rerankScore: number | null = null;
  if (typeof record['rerank_score'] === 'number' && Number.isFinite(record['rerank_score'])) {
    rerankScore = record['rerank_score'];
  }

  const urlValue = toNullableString(record['url']);
  const siteIconValue = toNullableString(record['site_icon']);
  const dateValue = typeof record['date'] === 'string' ? record['date'] : null;
  const dateFormatted = formatResultDate(dateValue);

  let authority: number | null = null;
  if (typeof record['authority'] === 'number' && Number.isFinite(record['authority'])) {
    authority = Math.trunc(record['authority']);
  }

  return {
    index,
    rerankScore,
    title: toNullableString(record['title']),
    url: urlValue === null ? null : toSafeHttpUrl(urlValue),
    snippet: toNullableString(record['snippet']),
    summary: toNullableString(record['summary']),
    content: toNullableString(record['content']),
    siteName: toNullableString(record['site_name']),
    siteIcon: siteIconValue === null ? null : toSafeHttpUrl(siteIconValue),
    dateRaw: dateValue,
    dateValid: dateFormatted.valid,
    dateText: dateFormatted.text,
    authority,
    extra: collectExtra(record, KNOWN_RESULT_KEYS),
    raw,
    isObject,
  };
}

/** 搜索响应规范化 */
export function normalizeSearchEnvelope(raw: unknown): SearchEnvelope {
  const envelope = toRecord(raw);
  const data = toRecord(envelope['data']);

  const resultsRaw: unknown[] = Array.isArray(data['results']) ? data['results'] : [];
  const results = resultsRaw.map((item: unknown, index: number) => normalizeResult(item, index));

  const extraData = collectExtra(data, new Set(['results']));

  return {
    cached: typeof envelope['cached'] === 'boolean' ? envelope['cached'] : null,
    cacheStatus: toCacheStatus(envelope['cache_status']),
    cacheAgeSeconds: toNullableFiniteNumber(envelope['cache_age_seconds']),
    storedAt: toNullableFiniteNumber(envelope['stored_at']),
    expiresAt: toNullableFiniteNumber(envelope['expires_at']),
    upstreamStatus: toNullableFiniteNumber(envelope['upstream_status']),
    elapsedMs: toNullableFiniteNumber(envelope['elapsed_ms']),
    results,
    extraData,
    extraTop: collectExtra(envelope, KNOWN_TOP_KEYS),
    raw,
  };
}

/** 抓取响应规范化 */
export function normalizeFetchEnvelope(raw: unknown): FetchEnvelope {
  const envelope = toRecord(raw);
  const data = toRecord(envelope['data']);

  return {
    cached: typeof envelope['cached'] === 'boolean' ? envelope['cached'] : null,
    cacheStatus: toCacheStatus(envelope['cache_status']),
    cacheAgeSeconds: toNullableFiniteNumber(envelope['cache_age_seconds']),
    storedAt: toNullableFiniteNumber(envelope['stored_at']),
    expiresAt: toNullableFiniteNumber(envelope['expires_at']),
    upstreamStatus: toNullableFiniteNumber(envelope['upstream_status']),
    elapsedMs: toNullableFiniteNumber(envelope['elapsed_ms']),
    title: toNullableString(data['title']),
    content: toNullableString(data['content']),
    extraData: collectExtra(data, new Set(['title', 'content'])),
    extraTop: collectExtra(envelope, KNOWN_TOP_KEYS),
    raw,
  };
}

function toNullableFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

/** 规范化错误体（用于“查看原始错误”） */
export interface NormalizedError {
  code: string;
  message: string;
  retryable: boolean;
  upstreamStatus: number | null;
  retryAfterSeconds: number | null;
  raw: unknown;
}

export function normalizeApiError(raw: unknown): NormalizedError {
  const outer = toRecord(raw);
  const body = toRecord(outer['error']);
  const code = typeof body['code'] === 'string' ? body['code'] : 'internal_error';
  const message =
    typeof body['message'] === 'string' && body['message'].trim() !== ''
      ? body['message']
      : '请求失败，请稍后重试';
  return {
    code,
    message,
    retryable: typeof body['retryable'] === 'boolean' ? body['retryable'] : false,
    upstreamStatus: toNullableFiniteNumber(body['upstream_status']),
    retryAfterSeconds: toNullableFiniteNumber(body['retry_after_seconds']),
    raw,
  };
}

export type { RawSearchEnvelope, RawFetchEnvelope };
