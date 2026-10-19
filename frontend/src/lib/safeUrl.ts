/**
 * URL 安全校验。
 *
 * 所有来自外部（搜索响应、Markdown 内容）的 URL，在可点击 / 可加载前
 * 必须经过本模块，只放行 http/https。
 */

/** 只允许 http / https 的绝对 URL；其它一律返回 null */
export function toSafeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  return parsed.href;
}

/**
 * 解析（可能是相对的）URL 并确保最终协议为 http/https。
 * 相对链接以 baseUrl（原页面 URL）为基准解析。
 */
export function resolveHttpUrl(href: unknown, baseUrl?: string | null): string | null {
  if (typeof href !== 'string') {
    return null;
  }
  const trimmed = href.trim();
  if (trimmed === '') {
    return null;
  }

  // 先尝试绝对解析
  const direct = toSafeHttpUrl(trimmed);
  if (direct !== null) {
    return direct;
  }

  // 相对链接：需要合法 http/https base
  const base = toSafeHttpUrl(baseUrl ?? null);
  if (base === null) {
    return null;
  }

  try {
    const resolved = new URL(trimmed, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    return resolved.href;
  } catch {
    return null;
  }
}

/** 从 http(s) URL 中提取 host，用于降级展示 */
export function safeHostname(value: unknown): string | null {
  const safe = toSafeHttpUrl(value);
  if (safe === null) {
    return null;
  }
  try {
    return new URL(safe).hostname;
  } catch {
    return null;
  }
}

/** 取站点的首字母（用于 site_icon 加载失败时的占位） */
export function initialOf(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed !== '') {
      const first = [...trimmed][0];
      if (first !== undefined) {
        return first.toUpperCase();
      }
    }
  }
  return '?';
}
