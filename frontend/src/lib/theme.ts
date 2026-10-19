/**
 * 主题：auto（跟随系统）/ light / dark 三态。
 *
 * - 选择存 localStorage["theme"]；
 * - auto 时监听 matchMedia('change') 实时跟随；
 * - localStorage 抛错时静默降级；
 * - main.tsx 中尽早应用，避免首屏闪白。
 */

import type { ThemeMode } from '../types';

export const THEME_STORAGE_KEY = 'theme';

export const THEME_COLORS = {
  light: '#f5f7fb',
  dark: '#0d1117',
} as const;

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'auto' || value === 'light' || value === 'dark';
}

/** 读取已保存的主题；异常或非法值回退 auto */
export function loadTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

/** 保存主题；异常静默忽略 */
export function saveTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 静默降级
  }
}

/** 当前系统是否偏好深色 */
export function systemPrefersDark(): boolean {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
  } catch {
    // 静默降级
  }
  return false;
}

/** 解析最终生效的主题（auto → 系统） */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') {
    return mode;
  }
  return systemPrefersDark() ? 'dark' : 'light';
}

/**
 * 应用主题到 <html>：
 * - auto：移除 data-theme，交给 @media (prefers-color-scheme: dark)；
 * - light/dark：写入 data-theme 强制覆盖。
 * 同时同步 <meta name="theme-color">。
 */
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') {
    return;
  }
  const root = document.documentElement;
  if (mode === 'auto') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', mode);
  }
  root.setAttribute('data-theme-mode', mode);

  applyThemeColor(mode, resolveTheme(mode));
}

/**
 * 更新 theme-color：
 * - auto：保留两套带 media 的 meta，让浏览器按系统偏好自行选择；
 * - 强制模式：去掉 media 限制并统一为当前生效色。
 */
export function applyThemeColor(mode: ThemeMode, effective: 'light' | 'dark'): void {
  if (typeof document === 'undefined') {
    return;
  }
  const metas = Array.from(
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
  );
  if (metas.length === 0) {
    return;
  }

  if (mode === 'auto') {
    metas.forEach((meta) => {
      const kind = meta.getAttribute('data-theme-color');
      if (kind === 'light' || kind === 'dark') {
        meta.setAttribute('content', THEME_COLORS[kind]);
        meta.setAttribute('media', `(prefers-color-scheme: ${kind})`);
        return;
      }
      meta.setAttribute('content', THEME_COLORS[effective]);
    });
    return;
  }

  metas.forEach((meta) => {
    meta.setAttribute('content', THEME_COLORS[effective]);
    meta.removeAttribute('media');
  });
}

export interface MediaQueryListenerHandle {
  dispose(): void;
}

/**
 * 监听系统配色变化（仅 auto 模式需要）。
 * 返回 dispose 句柄；环境不支持时返回空实现。
 */
export function watchSystemTheme(onChange: (dark: boolean) => void): MediaQueryListenerHandle {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return { dispose: () => undefined };
    }
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent): void => {
      onChange(event.matches);
    };
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', listener);
      return {
        dispose: () => {
          query.removeEventListener('change', listener);
        },
      };
    }
    // 旧版 Safari 回退
    const legacyListener = (event: MediaQueryListEvent): void => {
      onChange(event.matches);
    };
    query.addListener(legacyListener);
    return {
      dispose: () => {
        query.removeListener(legacyListener);
      },
    };
  } catch {
    return { dispose: () => undefined };
  }
}

/** 主题循环顺序：auto → light → dark → auto */
export function nextThemeMode(current: ThemeMode): ThemeMode {
  if (current === 'auto') {
    return 'light';
  }
  if (current === 'light') {
    return 'dark';
  }
  return 'auto';
}

export const THEME_LABELS: Record<ThemeMode, string> = {
  auto: '自动',
  light: '浅色',
  dark: '深色',
};
