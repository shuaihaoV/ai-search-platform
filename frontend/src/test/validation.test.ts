/**
 * 设置默认值与 count 边界校验测试。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_CONFIG,
  FALLBACK_LIMITS,
  countChars,
  normalizeLimits,
  stringifySafe,
  validateCount,
  validateFetchUrl,
  validateLocalization,
  validateOriQuestion,
  validateQuery,
} from '../lib/validation';
import { DEFAULT_SETTINGS, defaultsFromConfig, normalizeSettings } from '../lib/settings';

describe('need_content 默认值', () => {
  it('内置默认设置为 true', () => {
    expect(DEFAULT_SETTINGS.need_content).toBe(true);
  });

  it('内置兜底配置的 defaults.need_content 为 true', () => {
    expect(FALLBACK_CONFIG.defaults.need_content).toBe(true);
  });

  it('defaultsFromConfig(null) 仍返回 need_content=true', () => {
    expect(defaultsFromConfig(null).need_content).toBe(true);
  });

  it('config 明确给出 false 时遵循配置', () => {
    const settings = defaultsFromConfig({
      ...FALLBACK_CONFIG,
      defaults: { ...FALLBACK_CONFIG.defaults, need_content: false },
    });
    expect(settings.need_content).toBe(false);
  });

  it('config 的 need_content 类型异常时回退 true', () => {
    const settings = defaultsFromConfig({
      ...FALLBACK_CONFIG,
      defaults: {
        ...FALLBACK_CONFIG.defaults,
        need_content: 'yes' as unknown as boolean,
      },
    });
    expect(settings.need_content).toBe(true);
  });

  it('normalizeSettings 面对非法输入保持 need_content=true', () => {
    expect(normalizeSettings({ need_content: 'x' }, FALLBACK_LIMITS).need_content).toBe(true);
    expect(normalizeSettings(null, FALLBACK_LIMITS).need_content).toBe(true);
  });

  it('defaultsFromConfig 中 force_refresh 默认 false', () => {
    expect(defaultsFromConfig(FALLBACK_CONFIG).force_refresh).toBe(false);
  });

  it('默认 count 为 50（上游上限，来自 config）', () => {
    expect(defaultsFromConfig(FALLBACK_CONFIG).count).toBe(50);
    expect(DEFAULT_SETTINGS.count).toBe(50);
  });
});

describe('validateCount 边界', () => {
  it('接受区间内整数', () => {
    expect(validateCount(1, FALLBACK_LIMITS, 10)).toEqual({ value: 1, error: null });
    expect(validateCount(10, FALLBACK_LIMITS, 10)).toEqual({ value: 10, error: null });
    expect(validateCount(50, FALLBACK_LIMITS, 10)).toEqual({ value: 50, error: null });
  });

  it('小于下限被拒绝并回退', () => {
    const result = validateCount(0, FALLBACK_LIMITS, 10);
    expect(result.error).not.toBeNull();
    expect(result.value).toBe(10);
  });

  it('大于上限被拒绝并回退', () => {
    const result = validateCount(51, FALLBACK_LIMITS, 10);
    expect(result.error).not.toBeNull();
    expect(result.value).toBe(10);
  });

  it('负数被拒绝', () => {
    expect(validateCount(-5, FALLBACK_LIMITS, 10).error).not.toBeNull();
  });

  it('小数字符串被拒绝', () => {
    expect(validateCount('1.5', FALLBACK_LIMITS, 10).error).not.toBeNull();
    expect(validateCount(1.5, FALLBACK_LIMITS, 10).error).not.toBeNull();
  });

  it('非数字字符串被拒绝', () => {
    expect(validateCount('abc', FALLBACK_LIMITS, 10).error).not.toBeNull();
    expect(validateCount('', FALLBACK_LIMITS, 10).error).not.toBeNull();
    expect(validateCount('   ', FALLBACK_LIMITS, 10).error).not.toBeNull();
  });

  it('数字字符串正常解析', () => {
    expect(validateCount('25', FALLBACK_LIMITS, 10)).toEqual({ value: 25, error: null });
    expect(validateCount(' 7 ', FALLBACK_LIMITS, 10)).toEqual({ value: 7, error: null });
  });

  it('null / undefined 使用 fallback 且不报错', () => {
    expect(validateCount(null, FALLBACK_LIMITS, 10)).toEqual({ value: 10, error: null });
    expect(validateCount(undefined, FALLBACK_LIMITS, 10)).toEqual({ value: 10, error: null });
  });

  it('NaN / Infinity 被拒绝', () => {
    expect(validateCount(Number.NaN, FALLBACK_LIMITS, 10).error).not.toBeNull();
    expect(validateCount(Number.POSITIVE_INFINITY, FALLBACK_LIMITS, 10).error).not.toBeNull();
  });

  it('自定义 limits 生效', () => {
    const limits = { count_min: 5, count_max: 20 };
    expect(validateCount(5, limits, 10)).toEqual({ value: 5, error: null });
    expect(validateCount(4, limits, 10).error).not.toBeNull();
    expect(validateCount(21, limits, 10).error).not.toBeNull();
  });

  it('fallback 本身越界时会被收敛', () => {
    const result = validateCount(999, FALLBACK_LIMITS, 999);
    expect(result.value).toBe(50);
  });
});

describe('validateQuery', () => {
  it('接受正常关键词', () => {
    expect(validateQuery('测试')?.ok).toBe(true);
  });

  it('拒绝空串与纯空白', () => {
    expect(validateQuery('').ok).toBe(false);
    expect(validateQuery('   ').ok).toBe(false);
  });

  it('拒绝非字符串', () => {
    expect(validateQuery(null).ok).toBe(false);
    expect(validateQuery(1).ok).toBe(false);
  });

  it('按码点计数超限拒绝', () => {
    expect(validateQuery('a'.repeat(129)).ok).toBe(false);
    expect(validateQuery('a'.repeat(128)).ok).toBe(true);
  });

  it('去除首尾空白', () => {
    expect(validateQuery('  测试  ').value).toBe('测试');
  });
});

describe('其它校验', () => {
  it('validateOriQuestion 允许空值', () => {
    expect(validateOriQuestion('').ok).toBe(true);
    expect(validateOriQuestion(null).ok).toBe(true);
    expect(validateOriQuestion('a'.repeat(129)).ok).toBe(false);
  });

  it('validateLocalization 允许空值', () => {
    expect(validateLocalization('').ok).toBe(true);
    expect(validateLocalization('US').value).toBe('US');
  });

  it('validateFetchUrl 只允许 http(s)', () => {
    expect(validateFetchUrl('https://a.com/x').ok).toBe(true);
    expect(validateFetchUrl('javascript:alert(1)').ok).toBe(false);
    expect(validateFetchUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateFetchUrl('not-a-url').ok).toBe(false);
    expect(validateFetchUrl('').ok).toBe(false);
  });

  it('normalizeLimits 回退到兜底值', () => {
    expect(normalizeLimits(undefined)).toEqual(FALLBACK_LIMITS);
    expect(normalizeLimits({ count_min: 'x' }).count_min).toBe(1);
  });

  it('normalizeLimits 修正倒挂区间（异常配置不阻塞搜索）', () => {
    const limits = normalizeLimits({ count_min: 60, count_max: 10 });
    expect(limits.count_min).toBe(60);
    expect(limits.count_max).toBe(60);
    expect(validateCount(60, limits, 50).error).toBeNull();
  });

  it('countChars 按码点计数', () => {
    expect(countChars('😀😀')).toBe(2);
    expect(countChars('abc')).toBe(3);
  });

  it('stringifySafe 对循环引用不抛错', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    expect(() => stringifySafe(circular)).not.toThrow();
    expect(stringifySafe(circular)).toContain('循环引用');
  });
});

/**
 * vitest 使用 node 环境，没有 localStorage / DOMException。
 * 这里提供最小内存实现，用于测试持久化与异常降级路径。
 */
class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
}

class FakeDOMException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DOMException';
  }
}

const globalRef = globalThis as unknown as {
  localStorage?: Storage;
  Storage?: typeof Storage;
  DOMException?: typeof DOMException;
};

beforeAll(() => {
  globalRef.localStorage = new MemoryStorage() as unknown as Storage;
  globalRef.Storage = MemoryStorage as unknown as typeof Storage;
  globalRef.DOMException = FakeDOMException as unknown as typeof DOMException;
});

afterAll(() => {
  delete globalRef.localStorage;
  delete globalRef.Storage;
  delete globalRef.DOMException;
});

beforeEach(() => {
  globalRef.localStorage?.clear();
});

// 显式清理 spy，避免泄漏到其它用例（vitest.config 另有 restoreMocks: true 兜底）
afterEach(() => {
  vi.restoreAllMocks();
});

describe('设置持久化（localStorage）', () => {
  it('saveSettings + loadSettings 往返，且读回经过校验', async () => {
    const { saveSettings, loadSettings } = await import('../lib/settings');
    saveSettings({
      count: 25,
      need_content: false,
      ori_question: '原始问题',
      localization: 'US',
      force_refresh: true,
    });
    const restored = loadSettings(FALLBACK_LIMITS);
    expect(restored).toEqual({
      count: 25,
      need_content: false,
      ori_question: '原始问题',
      localization: 'US',
      force_refresh: true,
    });
  });

  it('被篡改成越界 count 时读回会被收敛', async () => {
    const { loadSettings } = await import('../lib/settings');
    localStorage.setItem(
      'ai-search-platform:settings',
      JSON.stringify({ count: 9999, need_content: 'hack', ori_question: 42 }),
    );
    const restored = loadSettings(FALLBACK_LIMITS);
    expect(restored).not.toBeNull();
    expect(restored?.count).toBe(50); // 收敛到 count_max
    expect(restored?.need_content).toBe(true); // 非布尔回退 true
    expect(restored?.ori_question).toBe('');
  });

  it('存储内容损坏时返回 null 而非抛错', async () => {
    const { loadSettings } = await import('../lib/settings');
    localStorage.setItem('ai-search-platform:settings', '{not json');
    expect(() => loadSettings(FALLBACK_LIMITS)).not.toThrow();
    expect(loadSettings(FALLBACK_LIMITS)).toBeNull();
  });

  it('未保存过时返回 null', async () => {
    const { loadSettings } = await import('../lib/settings');
    localStorage.removeItem('ai-search-platform:settings');
    expect(loadSettings(FALLBACK_LIMITS)).toBeNull();
  });

  it('不写入任何敏感字段', async () => {
    const { saveSettings, SETTINGS_STORAGE_KEY } = await import('../lib/settings');
    saveSettings({
      count: 10,
      need_content: true,
      ori_question: '',
      localization: '',
      force_refresh: false,
    });
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '';
    expect(raw).not.toMatch(/api[_-]?key|token|secret|password|authorization/iu);
    const parsed: unknown = JSON.parse(raw);
    expect(Object.keys(parsed as Record<string, unknown>).sort()).toEqual([
      'count',
      'force_refresh',
      'localization',
      'need_content',
      'ori_question',
    ]);
  });

  it('localStorage.setItem 抛错时静默降级', async () => {
    const { saveSettings } = await import('../lib/settings');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(() =>
      saveSettings({
        count: 10,
        need_content: true,
        ori_question: '',
        localization: '',
        force_refresh: false,
      }),
    ).not.toThrow();
    spy.mockRestore();
  });

  it('localStorage.getItem 抛错时静默降级', async () => {
    const { loadSettings } = await import('../lib/settings');
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    expect(() => loadSettings(FALLBACK_LIMITS)).not.toThrow();
    expect(loadSettings(FALLBACK_LIMITS)).toBeNull();
    spy.mockRestore();
  });
});
