/**
 * 高级设置的默认值、归一化与本地持久化。
 *
 * - 默认值优先取 /api/config 的 defaults，接口失败时用内置兜底（need_content 恒为 true）；
 * - 持久化只存非敏感的检索偏好（结果数量/开关/地区），绝不写入任何密钥或用户内容；
 * - localStorage 不可用（Safari 无痕、隐私模式、配额满）时静默降级，绝不抛出。
 */

import { FALLBACK_LIMITS, clampNumber } from './validation';
import type { AppConfig, AppLimits, SearchSettings } from '../types';

/** localStorage 键名 */
export const SETTINGS_STORAGE_KEY = 'ai-search-platform:settings';

export const DEFAULT_SETTINGS: SearchSettings = {
  count: 50,
  need_content: true,
  ori_question: '',
  localization: '',
  force_refresh: false,
};

/** 根据 config 生成“恢复默认值”目标 */
export function defaultsFromConfig(config: AppConfig | null): SearchSettings {
  const defaults = config?.defaults;
  const limits = config?.limits ?? FALLBACK_LIMITS;
  return {
    count: clampNumber(defaults?.count, limits.count_min, limits.count_max, DEFAULT_SETTINGS.count),
    need_content: typeof defaults?.need_content === 'boolean' ? defaults.need_content : true,
    ori_question: typeof defaults?.ori_question === 'string' ? defaults.ori_question : '',
    localization: typeof defaults?.localization === 'string' ? defaults.localization : '',
    force_refresh: false,
  };
}

/** 把任意（可能来自 localStorage 的）值收敛为合法设置 */
export function normalizeSettings(input: unknown, limits: AppLimits): SearchSettings {
  const source =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const countRaw = source['count'];
  const count =
    typeof countRaw === 'number' || typeof countRaw === 'string'
      ? clampNumber(
          typeof countRaw === 'string' ? Number(countRaw) : countRaw,
          limits.count_min,
          limits.count_max,
          DEFAULT_SETTINGS.count,
        )
      : DEFAULT_SETTINGS.count;

  const needContentRaw = source['need_content'];
  const forceRefreshRaw = source['force_refresh'];
  const oriRaw = source['ori_question'];
  const localizationRaw = source['localization'];

  return {
    count,
    need_content: typeof needContentRaw === 'boolean' ? needContentRaw : true,
    force_refresh: typeof forceRefreshRaw === 'boolean' ? forceRefreshRaw : false,
    ori_question:
      typeof oriRaw === 'string' ? [...oriRaw].slice(0, limits.ori_question_max_chars).join('') : '',
    localization: typeof localizationRaw === 'string' ? localizationRaw.slice(0, 64) : '',
  };
}

/**
 * 从 localStorage 读取已保存的设置。
 *
 * - 仅保存非敏感偏好：count / need_content / ori_question / localization / force_refresh；
 * - 读回内容一律经过 normalizeSettings 校验，防止被篡改成越界或非法类型；
 * - 任何异常（不可用、JSON 损坏、被禁用）都返回 null，由调用方回退默认值。
 */
export function loadSettings(limits: AppLimits = FALLBACK_LIMITS): SearchSettings | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null || raw === '') {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return normalizeSettings(parsed, limits);
  } catch {
    // Safari 无痕 / 隐私模式 / JSON 损坏 / 配额异常：静默降级
    return null;
  }
}

/**
 * 把设置写入 localStorage。
 *
 * - 只写入已知字段（避免把未来字段或意外数据带进存储）；
 * - 写入失败（配额满、隐私模式、被策略禁用）静默忽略，绝不影响搜索主流程。
 */
export function saveSettings(settings: SearchSettings): void {
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }
    // 白名单序列化：不写入 API key 等任何敏感信息
    const payload: SearchSettings = {
      count: settings.count,
      need_content: settings.need_content,
      ori_question: settings.ori_question,
      localization: settings.localization,
      force_refresh: settings.force_refresh,
    };
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 静默降级
  }
}

/** 清除已保存设置（恢复默认值时可选用） */
export function clearSettings(): void {
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.removeItem(SETTINGS_STORAGE_KEY);
  } catch {
    // 静默降级
  }
}
