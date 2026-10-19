/**
 * 输入校验（纯函数，便于单测）。
 *
 * 与后端 limits 对齐：count 1~50、query ≤128、ori_question ≤128、fetch url ≤8192。
 */

import type { AppConfig, AppLimits } from '../types';

/** 内置兜底 limits（接口失败时使用） */
export const FALLBACK_LIMITS: AppLimits = {
  count_min: 1,
  count_max: 50,
  query_max_chars: 128,
  ori_question_max_chars: 128,
  fetch_url_max_chars: 8192,
};

/** 内置兜底默认值（与 /api/config 的 defaults 一致） */
export const FALLBACK_DEFAULTS = {
  count: 50,
  need_content: true,
  ori_question: '',
  localization: '',
} as const;

export const FALLBACK_CONFIG: AppConfig = {
  version: '0.1.0',
  defaults: FALLBACK_DEFAULTS,
  limits: FALLBACK_LIMITS,
  cache: {
    search_enabled: true,
    search_ttl_seconds: 86400,
    fetch_enabled: true,
    fetch_ttl_seconds: 86400,
  },
  upstream: { configured: true },
};

/** 按 Unicode 码点计数（与后端字符数语义更接近） */
export function countChars(value: string): number {
  return [...value].length;
}

/** 数字收敛到 [min, max] 区间；非有限数返回 fallback */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  if (normalized < min) {
    return min;
  }
  if (normalized > max) {
    return max;
  }
  return normalized;
}

export interface CountValidation {
  value: number;
  /** 输入本身非法（非数字 / 越界）时给出的提示 */
  error: string | null;
}

/**
 * count 校验：必须为整数且落在 [count_min, count_max]。
 * 空字符串 / 非数字 / 小数 / 越界都视为非法，并回退到 fallback。
 */
export function validateCount(
  input: string | number | null | undefined,
  limits: Pick<AppLimits, 'count_min' | 'count_max'> = FALLBACK_LIMITS,
  fallback: number = FALLBACK_DEFAULTS.count,
): CountValidation {
  const min = Number.isFinite(limits.count_min) ? limits.count_min : FALLBACK_LIMITS.count_min;
  const max = Number.isFinite(limits.count_max) ? limits.count_max : FALLBACK_LIMITS.count_max;
  const safeFallback = clampNumber(fallback, min, max, FALLBACK_DEFAULTS.count);

  if (input === null || input === undefined) {
    return { value: safeFallback, error: null };
  }

  if (typeof input === 'number') {
    if (!Number.isInteger(input)) {
      return { value: safeFallback, error: `结果数量必须是整数（${min}~${max}）` };
    }
    if (input < min || input > max) {
      return { value: safeFallback, error: `结果数量需在 ${min}~${max} 之间` };
    }
    return { value: input, error: null };
  }

  const trimmed = input.trim();
  if (trimmed === '') {
    return { value: safeFallback, error: `结果数量不能为空（${min}~${max}）` };
  }
  if (!/^-?\d+$/u.test(trimmed)) {
    return { value: safeFallback, error: `结果数量必须是整数（${min}~${max}）` };
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return { value: safeFallback, error: `结果数量需在 ${min}~${max} 之间` };
  }
  return { value: parsed, error: null };
}

/** 关键词校验 */
export interface QueryValidation {
  ok: boolean;
  error: string | null;
  /** 去除首尾空白后的值 */
  value: string;
}

export function validateQuery(
  input: unknown,
  maxChars: number = FALLBACK_LIMITS.query_max_chars,
): QueryValidation {
  if (typeof input !== 'string') {
    return { ok: false, error: '请输入搜索关键词', value: '' };
  }
  const value = input.trim();
  if (value === '') {
    return { ok: false, error: '请输入搜索关键词', value: '' };
  }
  if (countChars(value) > maxChars) {
    return { ok: false, error: `关键词最多 ${maxChars} 个字符`, value };
  }
  return { ok: true, error: null, value };
}

/** ori_question 校验（可为空） */
export function validateOriQuestion(
  input: unknown,
  maxChars: number = FALLBACK_LIMITS.ori_question_max_chars,
): { ok: boolean; error: string | null; value: string } {
  if (input === null || input === undefined) {
    return { ok: true, error: null, value: '' };
  }
  if (typeof input !== 'string') {
    return { ok: false, error: '原始问题必须是文本', value: '' };
  }
  const value = input.trim();
  if (countChars(value) > maxChars) {
    return { ok: false, error: `原始问题最多 ${maxChars} 个字符`, value };
  }
  return { ok: true, error: null, value };
}

/** localization 校验（可为空） */
export function validateLocalization(
  input: unknown,
  maxChars = 64,
): { ok: boolean; error: string | null; value: string } {
  if (input === null || input === undefined) {
    return { ok: true, error: null, value: '' };
  }
  if (typeof input !== 'string') {
    return { ok: false, error: '地区必须是文本', value: '' };
  }
  const value = input.trim();
  if (countChars(value) > maxChars) {
    return { ok: false, error: `地区最多 ${maxChars} 个字符`, value };
  }
  return { ok: true, error: null, value };
}

/** 抓取 URL 校验 */
export function validateFetchUrl(
  input: unknown,
  maxChars: number = FALLBACK_LIMITS.fetch_url_max_chars,
): { ok: boolean; error: string | null; value: string } {
  if (typeof input !== 'string') {
    return { ok: false, error: 'URL 必须是非空文本', value: '' };
  }
  const value = input.trim();
  if (value === '') {
    return { ok: false, error: 'URL 不能为空', value };
  }
  if (value.length > maxChars) {
    return { ok: false, error: `URL 过长（上限 ${maxChars} 字符）`, value };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'URL 格式不合法', value };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '仅支持 http/https 链接', value };
  }
  return { ok: true, error: null, value };
}

/** 从任意 config 响应中安全提取 limits（字段缺失时用兜底值） */
export function normalizeLimits(input: unknown): AppLimits {
  const source = toRecord(input);
  const min = Math.max(1, Math.trunc(toFiniteNumber(source['count_min'], FALLBACK_LIMITS.count_min)));
  // 防御异常配置：若区间倒挂（min > max），把 max 抬到 min，避免整个搜索流程被卡死
  const max = Math.max(
    min,
    Math.max(1, Math.trunc(toFiniteNumber(source['count_max'], FALLBACK_LIMITS.count_max))),
  );
  return {
    count_min: min,
    count_max: max,
    query_max_chars: Math.max(
      1,
      Math.trunc(toFiniteNumber(source['query_max_chars'], FALLBACK_LIMITS.query_max_chars)),
    ),
    ori_question_max_chars: Math.max(
      1,
      Math.trunc(
        toFiniteNumber(source['ori_question_max_chars'], FALLBACK_LIMITS.ori_question_max_chars),
      ),
    ),
    fetch_url_max_chars: Math.max(
      1,
      Math.trunc(toFiniteNumber(source['fetch_url_max_chars'], FALLBACK_LIMITS.fetch_url_max_chars)),
    ),
  };
}

export function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function toBooleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 把任意可序列化值格式化为 JSON 文本（永不抛错） */
export function stringifySafe(value: unknown, space: number | undefined = 2): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(
        value,
        (_key: string, val: unknown) => {
          if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) {
              return '[循环引用]';
            }
            seen.add(val);
          }
          if (typeof val === 'bigint') {
            return val.toString();
          }
          return val;
        },
        space,
      ) ?? String(value)
    );
  } catch {
    try {
      return String(value);
    } catch {
      return '[无法序列化的值]';
    }
  }
}
