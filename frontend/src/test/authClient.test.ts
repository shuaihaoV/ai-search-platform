/**
 * 访问密码门禁的客户端基础能力回归测试。
 *
 * 覆盖第三轮终验新增逻辑：
 * - 401 无结构化错误体时也能映射为 `unauthorized`（否则前端无法回退门禁）；
 * - `isUnauthorizedError` 只识别 ApiError 的 unauthorized 业务码；
 * - token 的 localStorage 键名契约；
 * - localStorage 不可用时 token 退化为内存态（刷新后需重新输入密码）。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  AUTH_TOKEN_STORAGE_KEY,
  ApiError,
  clearAuthToken,
  getAuthToken,
  isUnauthorizedError,
  isValidAuthToken,
  mapHttpStatusToCode,
  setAuthToken,
} from '../api/client';

describe('mapHttpStatusToCode（无结构化错误体时的兜底映射）', () => {
  it('401 → unauthorized（门禁回退依赖此映射）', () => {
    expect(mapHttpStatusToCode(401)).toBe('unauthorized');
  });

  it('其余状态码映射保持既有契约', () => {
    expect(mapHttpStatusToCode(400)).toBe('invalid_request');
    expect(mapHttpStatusToCode(403)).toBe('forbidden');
    expect(mapHttpStatusToCode(404)).toBe('not_found');
    expect(mapHttpStatusToCode(413)).toBe('payload_too_large');
    expect(mapHttpStatusToCode(429)).toBe('rate_limited');
    expect(mapHttpStatusToCode(500)).toBe('internal_error');
  });
});

describe('isUnauthorizedError', () => {
  it('识别业务码 unauthorized 的 ApiError', () => {
    expect(isUnauthorizedError(new ApiError({ code: 'unauthorized', message: '需要访问密码' }))).toBe(true);
  });

  it('普通错误/其它业务码不视为未授权', () => {
    expect(isUnauthorizedError(new ApiError({ code: 'invalid_password', message: '密码错误' }))).toBe(false);
    expect(isUnauthorizedError(new Error('unauthorized'))).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
  });
});

describe('isValidAuthToken（本地 token 形状校验）', () => {
  it('接受后端签发的 v1.<expiry>.<base64url> 形状', () => {
    expect(isValidAuthToken('v1.1793064629.IcBZ7UWL_sJyv2-t-al3XS_8jNgWNTIkH3Bh3VN0Pao')).toBe(true);
    expect(isValidAuthToken('v1.1.A')).toBe(true);
  });

  it('拒绝会被 fetch 拒绝的 header 值（CRLF/空格）与异常形状', () => {
    expect(isValidAuthToken('v1.9999999999.aaa\r\nX-Evil: 1')).toBe(false);
    expect(isValidAuthToken('v1.9999999999.aaa bbb')).toBe(false);
    expect(isValidAuthToken('v1.9999999999')).toBe(false);
    expect(isValidAuthToken('v1.9999999999.!!!')).toBe(false);
    expect(isValidAuthToken('')).toBe(false);
    expect(isValidAuthToken(null)).toBe(false);
    expect(isValidAuthToken(undefined)).toBe(false);
  });

  it('setAuthToken 拒绝非法 token（不进入内存态）', () => {
    clearAuthToken();
    setAuthToken('bad token with spaces');
    expect(getAuthToken()).toBeNull();
    setAuthToken('v1.1793064629.ok');
    expect(getAuthToken()).toBe('v1.1793064629.ok');
  });
});

describe('auth token 存储降级', () => {
  beforeEach(() => {
    clearAuthToken();
  });

  it('键名契约固定为 ai-search-platform:auth-token', () => {
    expect(AUTH_TOKEN_STORAGE_KEY).toBe('ai-search-platform:auth-token');
  });

  it('node（无 localStorage）环境下 token 仅保存在内存，可读可清', () => {
    expect(getAuthToken()).toBeNull();
    setAuthToken('v1.123.sig');
    expect(getAuthToken()).toBe('v1.123.sig');
    clearAuthToken();
    expect(getAuthToken()).toBeNull();
  });
});
