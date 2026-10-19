/**
 * 展示层格式化工具（纯函数）。
 */

export interface FormattedDate {
  valid: boolean;
  /** 可展示文本：合法时本地化，非法时为原始字符串 */
  text: string | null;
  /** 相对时间描述（如“3 天前”），仅合法时给出 */
  relative: string | null;
}

/** 结果日期（RFC3339 UTC 字符串）→ 本地化显示；非法时保留原文 */
export function formatResultDate(value: unknown, now: number = Date.now()): FormattedDate {
  if (typeof value !== 'string' || value.trim() === '') {
    return { valid: false, text: null, relative: null };
  }
  const raw = value.trim();
  const parsed = new Date(raw);
  const time = parsed.getTime();
  if (Number.isNaN(time)) {
    return { valid: false, text: raw, relative: null };
  }
  let text: string;
  try {
    text = parsed.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    text = parsed.toISOString();
  }
  return { valid: true, text, relative: formatRelativeTime(time, now) };
}

/** 相对时间 */
export function formatRelativeTime(timeMs: number, now: number = Date.now()): string | null {
  if (!Number.isFinite(timeMs) || !Number.isFinite(now)) {
    return null;
  }
  const diff = now - timeMs;
  if (diff < 0) {
    const future = Math.abs(diff);
    if (future < 60_000) {
      return '即将';
    }
    if (future < 3_600_000) {
      return `${Math.round(future / 60_000)} 分钟后`;
    }
    if (future < 86_400_000) {
      return `${Math.round(future / 3_600_000)} 小时后`;
    }
    return `${Math.round(future / 86_400_000)} 天后`;
  }
  if (diff < 60_000) {
    return '刚刚';
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  if (diff < 30 * 86_400_000) {
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }
  if (diff < 365 * 86_400_000) {
    return `${Math.floor(diff / (30 * 86_400_000))} 个月前`;
  }
  return `${Math.floor(diff / (365 * 86_400_000))} 年前`;
}

/** 数值格式化（保留 1~2 位小数，去掉无意义尾零） */
export function formatScore(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/u, '');
}

/** 权威度（-1 未知，0~4）徽标文案 */
export function formatAuthority(value: number | null): { label: string; known: boolean } {
  if (value === null || !Number.isFinite(value)) {
    return { label: '权威度未知', known: false };
  }
  const int = Math.trunc(value);
  if (int < 0) {
    return { label: '权威度未知', known: false };
  }
  const stars = Math.min(4, Math.max(0, int));
  return { label: `权威度 ${stars}`, known: true };
}
