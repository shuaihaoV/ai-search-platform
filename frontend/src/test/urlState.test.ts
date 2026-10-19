/**
 * URL 状态（?s=...）测试。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MAX_QUERY_CHARS,
  SEARCH_PARAM,
  buildSearchHref,
  buildSearchSearchString,
  buildShareUrl,
  parseSearchParam,
  pushLandingState,
  pushSearchState,
} from '../lib/urlState';
import { base64UrlEncode } from '../lib/base64';

function encode(query: string): string {
  return encodeURIComponent(base64UrlEncode(query));
}

describe('parseSearchParam', () => {
  it('无 s 参数返回 none', () => {
    expect(parseSearchParam('')).toEqual({ status: 'none' });
    expect(parseSearchParam('?foo=bar')).toEqual({ status: 'none' });
  });

  it('解析合法关键词', () => {
    const state = parseSearchParam(`?s=${encode('中文关键词')}`);
    expect(state.status).toBe('valid');
    if (state.status === 'valid') {
      expect(state.query).toBe('中文关键词');
    }
  });

  it('不带问号也能解析', () => {
    const state = parseSearchParam(`s=${encode('hello')}`);
    expect(state.status).toBe('valid');
    if (state.status === 'valid') {
      expect(state.query).toBe('hello');
    }
  });

  it('兼容带 padding 的 Base64', () => {
    const state = parseSearchParam(`?s=${encodeURIComponent('YWJjZA==')}`);
    expect(state.status).toBe('valid');
    if (state.status === 'valid') {
      expect(state.query).toBe('abcd');
    }
  });

  it('兼容标准 Base64（+/）', () => {
    const state = parseSearchParam(`?s=${encodeURIComponent('5Lit5paH5YWz6ZSu6K+N')}`);
    expect(state.status).toBe('valid');
    if (state.status === 'valid') {
      expect(state.query).toBe('中文关键词');
    }
  });

  it('非法 Base64 返回 invalid 且不抛错', () => {
    const state = parseSearchParam('?s=%%%');
    expect(state.status).toBe('invalid');
    if (state.status === 'invalid') {
      expect(state.reason).not.toBe('');
    }
  });

  it('空 s 视为非法', () => {
    expect(parseSearchParam('?s=').status).toBe('invalid');
    expect(parseSearchParam('?s=   ').status).toBe('invalid');
  });

  it('解码为空文本视为非法', () => {
    // 空字符串编码后是空串，这里用空白字符
    const state = parseSearchParam(`?s=${encode('   ')}`);
    expect(state.status).toBe('invalid');
  });

  it('超长 s 参数被拒绝（不尝试解码）', () => {
    const state = parseSearchParam(`?s=${'A'.repeat(5000)}`);
    expect(state.status).toBe('invalid');
    if (state.status === 'invalid') {
      expect(state.reason).toMatch(/过长/u);
    }
  });

  it('关键词超过上限被拒绝', () => {
    const longQuery = 'a'.repeat(MAX_QUERY_CHARS + 1);
    const state = parseSearchParam(`?s=${encode(longQuery)}`);
    expect(state.status).toBe('invalid');
    if (state.status === 'invalid') {
      expect(state.reason).toMatch(/关键词过长/u);
    }
  });

  it('恰好等于上限的关键词可以解析', () => {
    const query = 'a'.repeat(MAX_QUERY_CHARS);
    const state = parseSearchParam(`?s=${encode(query)}`);
    expect(state.status).toBe('valid');
  });

  it('emoji 关键词可往返', () => {
    const state = parseSearchParam(`?s=${encode('AI 搜索 😀')}`);
    expect(state.status).toBe('valid');
    if (state.status === 'valid') {
      expect(state.query).toBe('AI 搜索 😀');
    }
  });
});

describe('生成 URL', () => {
  it('buildSearchSearchString 生成 ?s= 且可反解', () => {
    const search = buildSearchSearchString('向量数据库');
    expect(search.startsWith(`?${SEARCH_PARAM}=`)).toBe(true);
    const state = parseSearchParam(search);
    expect(state.status).toBe('valid');
    if (state.status === 'valid') {
      expect(state.query).toBe('向量数据库');
    }
  });

  it('buildSearchHref 以 / 开头', () => {
    expect(buildSearchHref('abc').startsWith('/?s=')).toBe(true);
  });

  it('buildShareUrl 拼接 origin', () => {
    const url = buildShareUrl('测试', 'https://example.com');
    expect(url.startsWith('https://example.com/?s=')).toBe(true);
    const state = parseSearchParam(url.slice(url.indexOf('?')));
    expect(state.status).toBe('valid');
    if (state.status === 'valid') {
      expect(state.query).toBe('测试');
    }
  });

  it('关键词编码后不含 URL 特殊字符', () => {
    const search = buildSearchSearchString('a+b/c=d 中文 😀');
    expect(search).not.toContain('+');
    expect(search.slice(4)).not.toContain('/');
    expect(search.slice(4)).not.toContain('=');
  });

  it('编码是 URL-safe 的（%2B 等不出现）', () => {
    const search = buildSearchSearchString('<<???>>');
    expect(search).not.toContain('%2B');
    expect(search).not.toContain('%2F');
    expect(search).not.toContain('%3D');
  });
});

describe('history 同步', () => {
  it('pushSearchState 调用 pushState 并写入正确 href', () => {
    const pushState = vi.fn();
    pushSearchState('关键词', { pushState, replaceState: vi.fn() });
    expect(pushState).toHaveBeenCalledTimes(1);
    const call = pushState.mock.calls[0] as unknown[] | undefined;
    expect(call?.[2]).toBe(buildSearchHref('关键词'));
  });

  it('pushSearchState 在 history 抛错时降级为 location 赋值', () => {
    const location = { href: 'http://x/', pathname: '/', search: '' };
    const pushState = vi.fn(() => {
      throw new Error('blocked');
    });
    pushSearchState('abc', { pushState, replaceState: vi.fn() }, location);
    expect(location.href).toBe(buildSearchHref('abc'));
  });

  it('pushLandingState 回到根路径', () => {
    const pushState = vi.fn();
    pushLandingState({ pushState, replaceState: vi.fn() });
    const call = pushState.mock.calls[0] as unknown[] | undefined;
    expect(call?.[2]).toBe('/');
  });
});
