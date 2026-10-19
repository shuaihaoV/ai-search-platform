/**
 * URL 安全校验测试。
 */

import { describe, expect, it } from 'vitest';
import {
  initialOf,
  resolveHttpUrl,
  safeHostname,
  toSafeHttpUrl,
} from '../lib/safeUrl';

describe('toSafeHttpUrl', () => {
  it('放行 http / https', () => {
    expect(toSafeHttpUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(toSafeHttpUrl('http://example.com')).toBe('http://example.com/');
  });

  it('拒绝 javascript:', () => {
    expect(toSafeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(toSafeHttpUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(toSafeHttpUrl(' javascript:alert(1) ')).toBeNull();
    expect(toSafeHttpUrl('java\tscript:alert(1)')).toBeNull();
  });

  it('拒绝 data:', () => {
    expect(toSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(toSafeHttpUrl('data:image/png;base64,AAAA')).toBeNull();
  });

  it('拒绝 file:', () => {
    expect(toSafeHttpUrl('file:///etc/passwd')).toBeNull();
    expect(toSafeHttpUrl('file://C:/Windows/System32')).toBeNull();
  });

  it('拒绝其它协议', () => {
    expect(toSafeHttpUrl('ftp://example.com/file')).toBeNull();
    expect(toSafeHttpUrl('mailto:a@b.com')).toBeNull();
    expect(toSafeHttpUrl('tel:+123')).toBeNull();
    expect(toSafeHttpUrl('blob:https://example.com/uuid')).toBeNull();
  });

  it('控制字符与零宽字符不能绕过协议白名单', () => {
    // WHATWG URL 会剥离前导 C0 控制符/制表符/换行符，协议仍会被规范化为 javascript:
    expect(toSafeHttpUrl('\u0000javascript:alert(1)')).toBeNull();
    expect(toSafeHttpUrl('\u0001javascript:alert(1)')).toBeNull();
    expect(toSafeHttpUrl('\u000bjavascript:alert(1)')).toBeNull();
    // 协议内部含 NUL / 垂直制表符 → 解析失败，同样拒绝
    expect(toSafeHttpUrl('java\u0000script:alert(1)')).toBeNull();
    expect(toSafeHttpUrl('java\u000bscript:alert(1)')).toBeNull();
    // 前导 C0 被剥离后仍是合法 http（协议安全，仅记录规范化行为）
    expect(toSafeHttpUrl('\u0000https://example.com/x')).toBe('https://example.com/x');
  });

  it('拒绝非字符串 / 空串 / 相对路径', () => {
    expect(toSafeHttpUrl(null)).toBeNull();
    expect(toSafeHttpUrl(undefined)).toBeNull();
    expect(toSafeHttpUrl(123)).toBeNull();
    expect(toSafeHttpUrl({})).toBeNull();
    expect(toSafeHttpUrl('')).toBeNull();
    expect(toSafeHttpUrl('   ')).toBeNull();
    expect(toSafeHttpUrl('/relative/path')).toBeNull();
    expect(toSafeHttpUrl('example.com')).toBeNull();
  });
});

describe('resolveHttpUrl', () => {
  it('绝对 http(s) 直接返回', () => {
    expect(resolveHttpUrl('https://a.com/x', 'https://base.com')).toBe('https://a.com/x');
  });

  it('相对链接按 baseUrl 解析', () => {
    expect(resolveHttpUrl('/a/b', 'https://example.com/doc/page')).toBe(
      'https://example.com/a/b',
    );
    expect(resolveHttpUrl('c', 'https://example.com/a/b')).toBe('https://example.com/a/c');
  });

  it('无合法 base 时相对链接返回 null', () => {
    expect(resolveHttpUrl('/a/b', null)).toBeNull();
    expect(resolveHttpUrl('/a/b', 'javascript:alert(1)')).toBeNull();
    expect(resolveHttpUrl('/a/b')).toBeNull();
  });

  it('协议相对链接继承 base 协议', () => {
    expect(resolveHttpUrl('//cdn.example.com/x', 'https://example.com')).toBe(
      'https://cdn.example.com/x',
    );
  });

  it('base 为 http 时解析相对链接仍是 http', () => {
    expect(resolveHttpUrl('/x', 'http://example.com')).toBe('http://example.com/x');
  });

  it('危险协议即使有 base 也拒绝', () => {
    expect(resolveHttpUrl('javascript:alert(1)', 'https://example.com')).toBeNull();
    expect(resolveHttpUrl('data:text/html,x', 'https://example.com')).toBeNull();
    expect(resolveHttpUrl('file:///etc/passwd', 'https://example.com')).toBeNull();
  });

  it('非字符串返回 null', () => {
    expect(resolveHttpUrl(null, 'https://example.com')).toBeNull();
    expect(resolveHttpUrl(undefined)).toBeNull();
  });
});

describe('safeHostname', () => {
  it('提取 host', () => {
    expect(safeHostname('https://sub.example.com/a')).toBe('sub.example.com');
  });

  it('非法 URL 返回 null', () => {
    expect(safeHostname('javascript:alert(1)')).toBeNull();
    expect(safeHostname(null)).toBeNull();
  });
});

describe('initialOf', () => {
  it('取首字符并大写', () => {
    expect(initialOf('example')).toBe('E');
    expect(initialOf('中文站点')).toBe('中');
  });

  it('空值返回占位', () => {
    expect(initialOf('')).toBe('?');
    expect(initialOf(null)).toBe('?');
    expect(initialOf('   ')).toBe('?');
  });

  it('emoji 首字符不会被截断', () => {
    expect(initialOf('😀 搜索')).toBe('😀');
  });
});
