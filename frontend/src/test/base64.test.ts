/**
 * Base64URL 编解码测试。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_BASE64_INPUT_LENGTH,
  Base64DecodeError,
  base64UrlDecode,
  base64UrlEncode,
} from '../lib/base64';

describe('base64UrlEncode', () => {
  it('编码 ASCII', () => {
    expect(base64UrlEncode('abc')).toBe('YWJj');
  });

  it('编码中文并往返', () => {
    const query = '中文关键词';
    const encoded = base64UrlEncode(query);
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(base64UrlDecode(encoded)).toBe(query);
  });

  it('编码 emoji（代理对）并往返', () => {
    const query = 'emoji 😀🚀 测试';
    const encoded = base64UrlEncode(query);
    expect(base64UrlDecode(encoded)).toBe(query);
  });

  it('空字符串编码为空字符串', () => {
    expect(base64UrlEncode('')).toBe('');
    expect(base64UrlDecode('')).toBe('');
  });

  it('输出为 URL-safe 且无填充', () => {
    // 该字符串的标准 Base64 含 '+' 与 '/'
    const raw = '<<???>>';
    const encoded = base64UrlEncode(raw);
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(base64UrlDecode(encoded)).toBe(raw);
  });

  it('大量随机字符串往返稳定', () => {
    const chars = [...'abcdefg中文😀 \'"-_.~!@#$%^&*()中文测试'];
    let seed = 42;
    const nextRandom = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 100; round += 1) {
      const length = Math.floor(nextRandom() * 40);
      let value = '';
      for (let i = 0; i < length; i += 1) {
        const index = Math.floor(nextRandom() * chars.length);
        value += chars[index] ?? '';
      }
      expect(base64UrlDecode(base64UrlEncode(value))).toBe(value);
    }
  });
});

describe('base64UrlDecode 兼容性', () => {
  it('接受 URL-safe 字母表', () => {
    // "~~~" 的标准 Base64 为 fn5+，URL-safe 为 fn5-
    expect(base64UrlDecode('fn5-')).toBe('~~~');
    expect(base64UrlDecode('fn5+')).toBe('~~~');
  });

  it('接受标准 Base64 的 + 与 /', () => {
    expect(base64UrlDecode('PDw/Pz8+Pg==')).toBe('<<???>>');
    expect(base64UrlDecode('Pz8/')).toBe('???');
  });

  it('带 padding 与不带 padding 都可解码', () => {
    expect(base64UrlDecode('YWJj')).toBe('abc');
    expect(base64UrlDecode('YWJj')).toBe(base64UrlDecode('YWJj'));
    expect(base64UrlDecode('Pz4=')).toBe('?>');
    expect(base64UrlDecode('Pz4')).toBe('?>');
  });

  it('URLSearchParams 中的 + 被解析为空格时也能恢复', () => {
    expect(base64UrlDecode('fn5 ')).toBe('~~~');
  });

  it('中文关键词的 Base64URL 可解码', () => {
    expect(base64UrlDecode('5Lit5paH5YWz6ZSu6K-N')).toBe('中文关键词');
    // 标准 Base64 形式（含 /）
    expect(base64UrlDecode('5Lit5paH5YWz6ZSu6K+N')).toBe('中文关键词');
  });
});

describe('base64UrlDecode 非法输入', () => {
  it('拒绝非法字符', () => {
    expect(() => base64UrlDecode('abc$def')).toThrow(Base64DecodeError);
    expect(() => base64UrlDecode('中文')).toThrow(Base64DecodeError);
    expect(() => base64UrlDecode('YWJj!!')).toThrow(Base64DecodeError);
  });

  it('拒绝长度为 4n+1 的输入', () => {
    expect(() => base64UrlDecode('YWJjZ')).toThrow(Base64DecodeError);
  });

  it('拒绝非 UTF-8 字节序列', () => {
    // 0xff 0xfe 不是合法 UTF-8
    expect(() => base64UrlDecode('//4=')).toThrow(Base64DecodeError);
    expect(() => base64UrlDecode('__4')).toThrow(Base64DecodeError);
  });

  it('拒绝超长输入', () => {
    const tooLong = 'a'.repeat(MAX_BASE64_INPUT_LENGTH + 1);
    expect(() => base64UrlDecode(tooLong)).toThrow(Base64DecodeError);
    expect(() => base64UrlDecode(tooLong)).toThrow(/过长/u);
  });

  it('恰好等于上限的输入不因长度被拒绝', () => {
    const atLimit = 'a'.repeat(MAX_BASE64_INPUT_LENGTH);
    // 长度合法但内容不一定是合法 UTF-8；这里只断言不是长度错误
    try {
      base64UrlDecode(atLimit);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/过长/u);
    }
  });

  it('拒绝非字符串参数', () => {
    // 运行时防御：非字符串
    expect(() => base64UrlDecode(undefined as unknown as string)).toThrow(Base64DecodeError);
  });
});
