/**
 * 安全回归测试（第一轮前端审计补充）。
 *
 * 覆盖：
 * - URL 白名单绕过集（大小写/空白/tab/换行/NUL/实体编码/协议混淆）；
 * - Markdown XSS payload（javascript:/data:/vbscript:/内联 HTML/SVG/iframe/mXSS）；
 * - 同文档锚点（GFM 脚注）与相对链接解析；
 * - 上游结果字段 / 原始 JSON 注入；
 * - `?s=` URL 参数注入；
 * - 无障碍回归：SearchForm 的 aria-describedby 不再悬空。
 *
 * 说明：断言的是「渲染产物中不存在可执行结构」，而不是简单查字符串，
 * 因为被安全转义的文本里出现 `javascript:` 字样是正常的。
 */

import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownView } from '../components/MarkdownView';
import { RawJson } from '../components/RawJson';
import { ResultCard } from '../components/ResultCard';
import { SearchForm } from '../components/SearchForm';
import { base64UrlEncode } from '../lib/base64';
import { createUrlTransform } from '../lib/markdown';
import { normalizeResult } from '../lib/normalize';
import { resolveHttpUrl, safeHostname, toSafeHttpUrl } from '../lib/safeUrl';
import { countChars } from '../lib/validation';
import { parseSearchParam } from '../lib/urlState';
import type { NotifyFn } from '../types';

const noop = (): void => undefined;
const notify: NotifyFn = () => undefined;

function renderMarkdown(markdown: string, baseUrl: string | null = null): string {
  return renderToStaticMarkup(<MarkdownView markdown={markdown} baseUrl={baseUrl} />);
}

/** 可执行结构黑名单：任何一条命中都视为 XSS 回归 */
const EXECUTABLE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/<script\b/iu, '<script> 标签'],
  [/<iframe\b/iu, '<iframe> 标签'],
  [/<svg\b/iu, '<svg> 标签'],
  [/<object\b/iu, '<object> 标签'],
  [/<embed\b/iu, '<embed> 标签'],
  [/<style\b/iu, '<style> 标签'],
  [/\ssrcdoc\s*=/iu, 'srcdoc 属性'],
  [/\sstyle\s*=/iu, '内联 style 属性（违反 CSP）'],
  [/\son[a-z]+\s*=/iu, '事件处理器属性'],
  [/href="[^"]*(?:javascript|vbscript|data|file):/iu, '危险 href'],
  [/src="[^"]*(?:javascript|vbscript):/iu, '危险 src'],
];

function expectNoExecutable(html: string): void {
  for (const [pattern, label] of EXECUTABLE_PATTERNS) {
    expect(html, `渲染产物命中危险结构：${label}`).not.toMatch(pattern);
  }
}

describe('URL 白名单抗绕过', () => {
  it('toSafeHttpUrl 拒绝所有协议混淆变体', () => {
    const bypasses = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1) ',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'java\rscript:alert(1)',
      '\u0000javascript:alert(1)',
      '\u0001javascript:alert(1)',
      'java\u0000script:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.com/uuid',
      'javas%63ript:alert(1)',
      'jav&#x61;script:alert(1)',
    ];
    for (const value of bypasses) {
      expect(toSafeHttpUrl(value), `未拦截：${JSON.stringify(value)}`).toBeNull();
    }
  });

  it('resolveHttpUrl 即使有 baseUrl 也拒绝危险绝对协议', () => {
    for (const value of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,x',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      expect(resolveHttpUrl(value, 'https://example.com/doc')).toBeNull();
    }
    // 协议内部含 NUL 时解析为相对路径（仍被解析成 https），不会变成 javascript:
    expect(resolveHttpUrl('java\u0000script:alert(1)', 'https://example.com/doc/page')).toBe(
      'https://example.com/doc/java%00script:alert(1)',
    );
  });

  it('同文档锚点只放行不会逃逸片段的形态', () => {
    const transform = createUrlTransform(null);
    expect(transform('#user-content-fn-1')).toBe('#user-content-fn-1');
    for (const value of ['#a b', '#a"b', '#<x>', '#//evil.com', '#javascript:alert(1)']) {
      expect(transform(value)).toBe('');
    }
  });

  it('safeHostname 展示的是真实 host（防 userinfo 钓鱼）', () => {
    expect(safeHostname('https://trusted.example@evil.com/x')).toBe('evil.com');
  });
});

describe('Markdown XSS payload 全部被拦截', () => {
  const payloads: ReadonlyArray<{ name: string; markdown: string; baseUrl?: string }> = [
    { name: 'javascript 链接', markdown: '[点我](javascript:alert(1))' },
    { name: 'javascript 大写', markdown: '[点我](JaVaScRiPt:alert(1))' },
    { name: 'javascript 前导空格', markdown: '[点我]( javascript:alert(1))' },
    { name: 'javascript tab 分隔', markdown: '[点我](<java\tscript:alert(1)>)' },
    { name: 'javascript 尖括号', markdown: '[点我](<javascript:alert(1)>)' },
    { name: 'javascript 实体编码', markdown: '[点我](javascript&#x3A;alert(1))' },
    { name: 'javascript 命名实体', markdown: '[点我](javascript&colon;alert(1))' },
    { name: '参考式链接', markdown: '[点我][r]\n\n[r]: javascript:alert(1)' },
    { name: 'autolink', markdown: '<javascript:alert(1)>' },
    { name: 'data 链接', markdown: '[点我](data:text/html,<script>alert(1)</script>)' },
    { name: 'vbscript 链接', markdown: '[点我](vbscript:msgbox(1))' },
    { name: 'file 链接', markdown: '[点我](file:///etc/passwd)' },
    { name: '内联 script', markdown: '前文\n\n<script>alert(1)</script>\n\n后文' },
    { name: '内联 img onerror', markdown: '<img src=x onerror=alert(1)>' },
    { name: '内联 svg onload', markdown: '<svg onload=alert(1)><circle r=10 /></svg>' },
    { name: '内联 iframe js', markdown: '<iframe src="javascript:alert(1)"></iframe>' },
    { name: '内联 object data', markdown: '<object data="javascript:alert(1)"></object>' },
    { name: '内联 a javascript', markdown: '<a href="javascript:alert(1)">x</a>' },
    { name: 'mXSS math', markdown: '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>' },
    { name: '注释混淆', markdown: '<!--><img src=x onerror=alert(1)>-->' },
    { name: 'details ontoggle', markdown: '<details open ontoggle=alert(1)>x</details>' },
    { name: '图片 data svg', markdown: '![x](data:image/svg+xml,<svg onload=alert(1)>)' },
    { name: '图片 javascript', markdown: '![x](javascript:alert(1))' },
    { name: '图片 data png', markdown: '![x](data:image/png;base64,AAAA)' },
    { name: 'alt 注入', markdown: '![<script>alert(1)</script>](https://example.com/a.png)' },
    { name: '相对链接无 base', markdown: '[点我](/a/b)' },
    { name: '相对链接 base 非法', markdown: '[点我](/a/b)', baseUrl: 'javascript:alert(1)' },
  ];

  for (const payload of payloads) {
    it(payload.name, () => {
      expectNoExecutable(renderMarkdown(payload.markdown, payload.baseUrl ?? null));
    });
  }

  it('链接 title 中的引号无法注入属性', () => {
    const html = renderMarkdown('[x](https://example.com "a\\" onmouseover=\\"alert(1)")');
    expect(html).not.toContain(' onmouseover="');
    expect(html).toContain('&quot;');
  });

  it('代码块中的 HTML 被转义而非执行', () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('正常内容照常渲染（安全策略不过度拦截）', () => {
    const html = renderMarkdown(
      '# 标题\n\n**加粗**\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[示例](https://example.com/page)',
    );
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<table>');
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('合法 https 图片保留，带 no-referrer 与 lazy', () => {
    const html = renderMarkdown('![图](https://example.com/a.png)');
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('loading="lazy"');
  });
});

describe('相对链接与同文档锚点', () => {
  it('相对链接按 baseUrl 解析为绝对 http(s)', () => {
    const html = renderMarkdown('[相对](/a/b)', 'https://example.com/doc/page');
    expect(html).toContain('href="https://example.com/a/b"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('GFM 脚注锚点保留页内跳转', () => {
    const html = renderMarkdown('正文[^1]\n\n[^1]: 脚注内容');
    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).toContain('href="#user-content-fnref-1"');
    expect(html).toContain('脚注内容');
  });

  it('上游过度转义后的字面 HTML 不会被丢弃，也不会变成裸标签', () => {
    const html = renderMarkdown('\\<img src=x onerror=alert(1)\\>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('上游数据注入（结果字段 / 原始 JSON / URL 参数）', () => {
  it('ResultCard 对恶意字段全部按文本转义', () => {
    const result = normalizeResult(
      {
        title: '<img src=x onerror=alert(1)>',
        url: 'javascript:alert(1)',
        snippet: '<script>alert(1)</script>',
        site_name: '<b onmouseover=alert(1)>x</b>',
        site_icon: 'data:image/svg+xml,<svg onload=alert(1)>',
        date: '<script>alert(1)</script>',
      },
      0,
    );
    const html = renderToStaticMarkup(
      <ResultCard
        result={result}
        onFetch={noop}
        notify={notify}
        fetchingUrl={null}
        onShare={noop}
      />,
    );
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<img[^>]*onerror/iu);
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('&lt;img');
    expect(html).toContain('无有效链接');
  });

  it('RawJson 以纯文本渲染恶意键值', () => {
    const html = renderToStaticMarkup(
      <RawJson
        value={{ '</pre><script>alert(1)</script>': '<img src=x onerror=alert(1)>' }}
        notify={notify}
        defaultOpen
      />,
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;');
  });

  it('?s= 参数中的恶意内容只作为文本关键词，不产生 HTML', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const encoded = encodeURIComponent(base64UrlEncode(evil));
    const state = parseSearchParam(`?s=${encoded}`);
    expect(state.status).toBe('valid');
    if (state.status === 'valid') {
      expect(state.query).toBe(evil);
    }
  });

  it('?s= 长关键词上限可跟随 /api/config 传入，默认仍为 128', () => {
    const long = 'a'.repeat(150);
    const encoded = encodeURIComponent(base64UrlEncode(long));
    expect(parseSearchParam(`?s=${encoded}`).status).toBe('invalid');
    expect(parseSearchParam(`?s=${encoded}`, 200).status).toBe('valid');
  });
});

describe('无障碍回归：SearchForm aria-describedby', () => {
  interface FormOptions {
    query: string;
    queryError: string | null;
    maxChars: number;
  }

  function renderForm(options: FormOptions): string {
    return renderToStaticMarkup(
      <SearchForm
        query={options.query}
        onQueryChange={noop}
        onSubmit={noop}
        onClear={noop}
        loading={false}
        onOpenSyntax={noop}
        onOpenSettings={noop}
        inputRef={createRef<HTMLInputElement>()}
        maxChars={options.maxChars}
        countChars={countChars}
        compact={false}
        queryError={options.queryError}
        settingsDirty={false}
      />,
    );
  }

  it('无错误且未超长时不引用不存在的提示节点', () => {
    const html = renderForm({ query: '', queryError: null, maxChars: 128 });
    expect(html).not.toContain('aria-describedby');
  });

  it('有错误时同时引用提示与错误节点', () => {
    const html = renderForm({ query: 'x', queryError: '请输入关键词', maxChars: 128 });
    expect(html).toContain('aria-describedby="search-hint search-error"');
  });

  it('超长时只引用实际渲染的字符计数提示', () => {
    const html = renderForm({ query: 'a'.repeat(130), queryError: null, maxChars: 128 });
    expect(html).toContain('aria-describedby="search-hint"');
    expect(html).toContain('130 / 128');
  });
});
