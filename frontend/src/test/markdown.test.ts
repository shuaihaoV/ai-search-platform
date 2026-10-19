/**
 * Markdown 安全策略测试：urlTransform 只放行 http(s)（同文档锚点单独放行）。
 */

import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_RENDER_LIMIT,
  RAW_JSON_LIMIT,
  createUrlTransform,
  safeImageSrc,
  truncateText,
} from '../lib/markdown';

/** 无 baseUrl 的 transform（等价于旧的 defaultUrlTransform） */
const transform = createUrlTransform(null);

describe('urlTransform', () => {
  it('放行 http / https', () => {
    expect(transform('https://example.com/a')).toBe('https://example.com/a');
    expect(transform('http://example.com')).toBe('http://example.com/');
  });

  it('拒绝 javascript:', () => {
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'javascript:void(0)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
    ]) {
      expect(transform(url)).toBe('');
    }
  });

  it('拒绝 data:', () => {
    expect(transform('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(transform('data:image/png;base64,AAAA')).toBe('');
    expect(transform('data:image/svg+xml,<svg onload=alert(1)>')).toBe('');
  });

  it('拒绝 vbscript: 与 file:', () => {
    expect(transform('vbscript:msgbox(1)')).toBe('');
    expect(transform('file:///etc/passwd')).toBe('');
  });

  it('拒绝空值与非 http(s) 协议', () => {
    expect(transform('')).toBe('');
    expect(transform('   ')).toBe('');
    expect(transform('mailto:a@b.com')).toBe('');
    expect(transform('tel:+123')).toBe('');
    expect(transform('ftp://example.com/x')).toBe('');
    expect(transform('blob:https://example.com/uuid')).toBe('');
  });

  it('放行合法的同文档锚点（GFM 脚注依赖）', () => {
    expect(transform('#section')).toBe('#section');
    expect(transform('#user-content-fn-1')).toBe('#user-content-fn-1');
    expect(transform('#user-content-fnref-12')).toBe('#user-content-fnref-12');
    expect(transform('#')).toBe('#');
    expect(transform('#%E4%B8%AD%E6%96%87')).toBe('#%E4%B8%AD%E6%96%87');
  });

  it('拒绝可能逃逸出 URL 片段的锚点', () => {
    for (const url of [
      '#a b',
      '#a"b',
      "#a'b",
      '#<x>',
      '#a\tb',
      '#//evil.com',
      '#javascript:alert(1)',
      '#a/b',
      '#javascript%3Aalert(1)',
    ]) {
      expect(transform(url)).toBe('');
    }
  });

  it('无 baseUrl 时拒绝相对链接', () => {
    expect(transform('/a/b')).toBe('');
    expect(transform('c')).toBe('');
  });

  it('有 baseUrl 时相对链接解析为 http(s)', () => {
    const withBase = createUrlTransform('https://example.com/doc/page');
    expect(withBase('/a/b')).toBe('https://example.com/a/b');
    expect(withBase('c')).toBe('https://example.com/doc/c');
  });

  it('baseUrl 非法时拒绝相对链接', () => {
    const withJsBase = createUrlTransform('javascript:alert(1)');
    expect(withJsBase('/a/b')).toBe('');
  });

  it('即使有 baseUrl 也拒绝危险绝对协议', () => {
    const withBase = createUrlTransform('https://example.com');
    expect(withBase('javascript:alert(1)')).toBe('');
    expect(withBase('data:text/html,x')).toBe('');
  });
});

describe('truncateText', () => {
  it('短文本不截断', () => {
    const result = truncateText('hello', 10);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('hello');
  });

  it('超长文本截断并给出原长度', () => {
    const result = truncateText('a'.repeat(100), 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('a'.repeat(10));
    expect(result.originalLength).toBe(100);
    expect(result.shownLength).toBe(10);
  });

  it('不会切断 emoji 代理对', () => {
    const text = '😀'.repeat(10);
    const result = truncateText(text, 3);
    expect(result.truncated).toBe(true);
    expect([...result.text]).toHaveLength(3);
    expect(result.text).toBe('😀😀😀');
    // 提示文案按「字符」展示：原长应为码点数 10，而不是 UTF-16 长度 20
    expect(result.originalLength).toBe(10);
  });

  it('非正值上限返回空文本', () => {
    expect(truncateText('abc', 0).text).toBe('');
    expect(truncateText('abc', -1).truncated).toBe(true);
  });

  it('上限常量符合契约', () => {
    expect(MARKDOWN_RENDER_LIMIT).toBe(300_000);
    expect(RAW_JSON_LIMIT).toBe(500_000);
  });
});

describe('safeImageSrc', () => {
  it('只放行 https（与生产 CSP img-src 对齐）', () => {
    expect(safeImageSrc('https://a.com/x.png')).toBe('https://a.com/x.png');
    // 生产 CSP 为 img-src 'self' https: data:，http 图片会被浏览器拦截（破图 + CSP 违规）
    expect(safeImageSrc('http://a.com/x.png')).toBeNull();
    expect(safeImageSrc('javascript:alert(1)')).toBeNull();
    expect(safeImageSrc('data:image/png;base64,AAAA')).toBeNull();
    expect(safeImageSrc('data:image/svg+xml,<svg onload=alert(1)>')).toBeNull();
  });
});
