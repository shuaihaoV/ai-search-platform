/**
 * Base64URL（无填充）编解码，用于 URL 的 `?s=` 参数。
 *
 * 解码兼容性要求：
 * - URL-safe（- _）与标准 Base64（+ /）均可；
 * - 带或不带 padding（=）均可；
 * - UTF-8 严格解码，非法字节序列必须抛错而不是产生替换字符；
 * - 输入长度上限 4096，超限直接拒绝（防止滥用）。
 */

/** 解码时允许的最大输入长度 */
export const MAX_BASE64_INPUT_LENGTH = 4096;

/** Base64 解码失败 */
export class Base64DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Base64DecodeError';
  }
}

/** 把字节数组转为二进制字符串（避免大数组展开爆栈） */
function bytesToBinary(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let part = '';
    for (let j = 0; j < chunk.length; j += 1) {
      const byte = chunk[j];
      if (byte === undefined) {
        continue;
      }
      part += String.fromCharCode(byte);
    }
    binary += part;
  }
  return binary;
}

/**
 * UTF-8 字符串 → Base64URL（无填充）。
 * 空字符串编码为空字符串。
 */
export function base64UrlEncode(input: string): string {
  if (typeof input !== 'string') {
    throw new TypeError('base64UrlEncode 只接受字符串');
  }
  const bytes = new TextEncoder().encode(input);
  if (bytes.length === 0) {
    return '';
  }
  const binary = bytesToBinary(bytes);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

/**
 * Base64URL / Base64 → UTF-8 字符串。
 * 非法字符、非法长度、非法 UTF-8、超长输入都会抛出 Base64DecodeError。
 */
export function base64UrlDecode(input: string): string {
  if (typeof input !== 'string') {
    throw new Base64DecodeError('参数不是字符串');
  }
  if (input.length > MAX_BASE64_INPUT_LENGTH) {
    throw new Base64DecodeError(`编码内容过长（上限 ${MAX_BASE64_INPUT_LENGTH} 字符）`);
  }

  // 兼容处理：
  // - URLSearchParams 会把未转义的 '+' 解析成空格，这里还原回 '+'；
  // - 标准 Base64 的 +/ 与 URL-safe 的 -_ 都接受。
  const normalized = input.replace(/ /gu, '+').replace(/-/gu, '+').replace(/_/gu, '/');

  if (normalized.length === 0) {
    return '';
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) {
    throw new Base64DecodeError('包含非法 Base64 字符');
  }

  const withoutPadding = normalized.replace(/=+$/u, '');
  if (withoutPadding.length % 4 === 1) {
    throw new Base64DecodeError('Base64 长度非法');
  }

  const padded = withoutPadding + '='.repeat((4 - (withoutPadding.length % 4)) % 4);

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Base64DecodeError('不是合法的 Base64 数据');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  try {
    // fatal: true 保证严格 UTF-8 校验
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Base64DecodeError('解码结果不是合法的 UTF-8 文本');
  }
}
