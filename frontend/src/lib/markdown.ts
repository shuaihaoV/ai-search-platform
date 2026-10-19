/**
 * Markdown 渲染相关的安全策略。
 *
 * - 只放行 http/https 链接，相对链接按原页 URL 解析；
 * - 渲染前拒绝一切非 http(s) 协议（javascript:/data:/file: 等）；
 * - 渲染上限：Markdown 300000 字符；原始 JSON 500000 字符。
 */

import { resolveHttpUrl, toSafeHttpUrl } from './safeUrl';

/** Markdown 正文渲染上限 */
export const MARKDOWN_RENDER_LIMIT = 300_000;
/** 原始 JSON 展示上限 */
export const RAW_JSON_LIMIT = 500_000;

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalLength: number;
  shownLength: number;
}

/**
 * 还原上游 Fetch 接口对 Markdown 标点的过度转义。
 *
 * 实测差异：
 * - Search 接口返回干净 Markdown（`### 标题`）；
 * - Fetch 接口会把 ASCII 标点全部反斜杠转义（`\#\#\# 标题`、`\- 列表`、`30\%`）。
 * 按 CommonMark，`\#` 是字面量 `#`，导致抓取全文里的标题/列表都不渲染。
 *
 * 只处理「反斜杠 + ASCII 标点」这一确定形态，且仅当该字符属于
 * CommonMark 可转义字符集合时才去掉反斜杠，不影响代码块内的真实反斜杠转义。
 */
// 注意：刻意不含 `<` 与 `>`。上游会把字面 HTML（如文章正文里讲的 `<div>`）
// 转义成 `\<div\>`；若在这里还原成裸标签，会被 skipHtml 整段丢弃（内容丢失）。
// 交给 CommonMark 处理 `\<` 时只会渲染为字面文本 `<`，既安全又不丢内容。
const MARKDOWN_ESCAPABLE = new Set(
  '\\`*_{}[]()#+-.!|~&"$%/:;,=?@^'.split(''),
);

export function unescapeUpstreamMarkdown(input: string): string {
  if (typeof input !== 'string' || !input.includes('\\')) {
    return input;
  }
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      const next = input[i + 1] as string;
      if (MARKDOWN_ESCAPABLE.has(next)) {
        out += next;
        i += 2;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  // 围栏代码块内的反斜杠已被上面处理，这里不再做块级回补：
  // 上游转义本身覆盖代码块内外，保持一致性更重要。
  return out;
}

/** 按码点截断文本，避免破坏代理对（emoji） */
export function truncateText(input: string, limit: number): TruncateResult {
  if (typeof input !== 'string') {
    return { text: '', truncated: false, originalLength: 0, shownLength: 0 };
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return { text: '', truncated: input.length > 0, originalLength: input.length, shownLength: 0 };
  }
  // 快速路径：UTF-16 长度已小于上限，必然不需要截断
  if (input.length <= limit) {
    return {
      text: input,
      truncated: false,
      originalLength: input.length,
      shownLength: input.length,
    };
  }
  const chars = [...input];
  if (chars.length <= limit) {
    return {
      text: input,
      truncated: false,
      originalLength: chars.length,
      shownLength: chars.length,
    };
  }
  const slice = chars.slice(0, limit).join('');
  return {
    text: slice,
    truncated: true,
    // 提示文案按「字符」展示，这里统一用码点长度（UTF-16 length 对 emoji 会翻倍）
    originalLength: chars.length,
    shownLength: slice.length,
  };
}

/** 同文档锚点：`#` 后只允许不会逃逸出 URL 片段的字符（无空白/引号/尖括号/斜杠） */
const SAFE_FRAGMENT = /^#[A-Za-z0-9_.~%:+\-]*$/u;

/**
 * react-markdown 的 urlTransform：
 * - 仅放行 http/https；相对链接按 baseUrl（原页 URL）解析；
 * - 同文档锚点（如 GFM 脚注 `#user-content-fn-1`）原样放行，仅改变 URL 片段，
 *   不会触发脚本执行或跨文档导航；
 * - 其它协议一律返回空串（react-markdown 会渲染为不可点击的文本）。
 */
export function createUrlTransform(baseUrl: string | null = null): (url: string) => string {
  return (url: string): string => {
    if (typeof url !== 'string') {
      return '';
    }
    const trimmed = url.trim();
    if (trimmed === '') {
      return '';
    }
    // 同文档锚点：放行合法片段（GFM 脚注依赖它）；非法片段一律丢弃。
    if (trimmed.startsWith('#')) {
      return SAFE_FRAGMENT.test(trimmed) ? trimmed : '';
    }
    return resolveHttpUrl(trimmed, baseUrl) ?? '';
  };
}

/**
 * 校验一个图片地址是否可安全加载。
 *
 * 只放行 https：
 * - 生产 CSP 为 `img-src 'self' https: data:`，放行 http 只会被 CSP 拦截
 *   （用户看到破图 + 控制台产生 CSP 违规日志）；
 * - data: 会重新引入 SVG/脚本执行面，一律阻止。
 */
export function safeImageSrc(src: unknown): string | null {
  const safe = toSafeHttpUrl(src);
  if (safe === null || !safe.startsWith('https://')) {
    return null;
  }
  return safe;
}
