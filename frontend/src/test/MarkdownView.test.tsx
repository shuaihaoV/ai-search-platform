/**
 * MarkdownView 渲染安全测试（react-dom/server）。
 *
 * 断言：内联 HTML / onerror 事件属性 / javascript: 链接都不会出现在输出中，
 * 外链必须带 rel="noopener noreferrer nofollow" 与 target="_blank"。
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownView } from '../components/MarkdownView';

function render(markdown: string, baseUrl: string | null = null): string {
  return renderToStaticMarkup(<MarkdownView markdown={markdown} baseUrl={baseUrl} />);
}

describe('MarkdownView 安全性', () => {
  it('普通 Markdown 正常渲染', () => {
    const html = render('# 标题\n\n正文 **加粗**。');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>加粗</strong>');
  });

  it('GFM 表格可渲染', () => {
    const html = render('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('内联 <script> 不会出现在输出中（skipHtml）', () => {
    const html = render('前文\n\n<script>alert(1)</script>\n\n后文');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('</script>');
  });

  it('内联 <img onerror=...> 不会出现在输出中', () => {
    const html = render('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('alert(1)');
  });

  it('HTML 事件处理器属性不会出现', () => {
    const html = render('<div onclick="alert(1)">点我</div>');
    expect(html).not.toContain('onclick');
    // 内联 HTML 整体被丢弃（只保留 MarkdownView 自身的容器 div）
    expect(html).not.toContain('点我');
    expect(html).not.toContain('alert(1)');
  });

  it('javascript: 链接变为不可点击的纯文本', () => {
    const html = render('[点我](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('href="javascript');
    // 文本保留
    expect(html).toContain('点我');
    // urlTransform 返回空串后 href 不渲染
    expect(html).not.toContain('href=""');
  });

  it('data: 链接被拒绝', () => {
    const html = render('[x](data:text/html,<script>alert(1)</script>)');
    expect(html).not.toContain('href="data:');
    expect(html).not.toContain('<script');
  });

  it('vbscript: / file: 链接被拒绝', () => {
    expect(render('[x](vbscript:msgbox(1))')).not.toContain('href="vbscript:');
    expect(render('[x](file:///etc/passwd)')).not.toContain('href="file:');
  });

  it('https 外链带 rel 与 target', () => {
    const html = render('[示例](https://example.com/page)');
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('http 外链带 rel 与 target', () => {
    const html = render('[示例](http://example.com)');
    expect(html).toContain('href="http://example.com/"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('相对链接按 baseUrl 解析', () => {
    const html = render('[相对](/a/b)', 'https://example.com/doc/page');
    expect(html).toContain('href="https://example.com/a/b"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('无 baseUrl 时相对链接不渲染为可点击链接', () => {
    const html = render('[相对](/a/b)');
    expect(html).not.toContain('href="/a/b"');
  });

  it('Markdown 图片带 referrerPolicy 与 loading', () => {
    const html = render('![图](https://example.com/a.png)');
    expect(html).toContain('src="https://example.com/a.png"');
    // react-dom/server 输出的是属性名 referrerPolicy，HTML 属性大小写不敏感
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('loading="lazy"');
  });

  it('危险协议图片被阻止', () => {
    const html = render('![图](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src="javascript');
    expect(html).toContain('图片已阻止');
  });

  it('http 图片被阻止（生产 CSP img-src 不含 http:，避免破图 + CSP 违规日志）', () => {
    const html = render('![图](http://example.com/a.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('图片已阻止');
  });

  it('超长内容截断并提示', () => {
    const markdown = 'a'.repeat(400_000);
    const html = render(markdown);
    expect(html).toContain('已截断展示前');
    // 输出长度应远小于原文
    expect(html.length).toBeLessThan(400_000);
  });

  it('不产生 style= 内联样式', () => {
    const html = render('# 标题\n\n正文\n\n- a\n- b');
    expect(html).not.toMatch(/style="/u);
  });

  it('危险 HTML 与正常 Markdown 混排仍安全', () => {
    const markdown = [
      '# 标题',
      '',
      '<script>alert(1)</script>',
      '',
      '<img src=x onerror=alert(1)>',
      '',
      '[安全链接](https://example.com)',
      '',
      '[危险链接](javascript:alert(1))',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n');
    const html = render(markdown);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('<table>');
  });

  it('代码块内容被转义而非执行', () => {
    const html = render('```html\n<script>alert(1)</script>\n```');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
