/**
 * ResultCard 渲染测试：全字段、null、异常类型、非对象项。
 */

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResultCard } from '../components/ResultCard';
import { normalizeResult, normalizeSearchEnvelope } from '../lib/normalize';
import type { NormalizedResult } from '../types';

const noop = (): void => undefined;
const notify = vi.fn(noop);

function makeResult(raw: unknown, index = 0): NormalizedResult {
  return normalizeResult(raw, index);
}

interface RenderOptions {
  fetchingUrl?: string | null;
}

function render(result: NormalizedResult, options: RenderOptions = {}): string {
  return renderToStaticMarkup(
    <ResultCard
      result={result}
      onFetch={noop}
      notify={notify}
      fetchingUrl={options.fetchingUrl ?? null}
      onShare={noop}
    />,
  );
}

describe('ResultCard 全字段渲染', () => {
  it('渲染所有契约字段', () => {
    const raw = {
      rerank_score: 2.4,
      title: '示例标题',
      url: 'https://example.com/page',
      snippet: '这是摘要片段',
      summary: '这是详细总结内容',
      content: '这是正文内容',
      site_name: '示例站点',
      site_icon: 'https://example.com/icon.png',
      date: '2025-06-01T08:30:00Z',
      authority: 3,
    };
    const html = render(makeResult(raw));
    expect(html).toContain('示例标题');
    expect(html).toContain('https://example.com/page');
    expect(html).toContain('这是摘要片段');
    expect(html).toContain('示例站点');
    expect(html).toContain('得分 2.4');
    expect(html).toContain('权威度 3');
    expect(html).toContain('2025');
    expect(html).toContain('https://example.com/icon.png');
    expect(html).toContain('· example.com');
  });

  it('rerank_score ≥ 1.5 显示“优质”徽标', () => {
    const html = render(makeResult({ title: 't', url: 'https://a.com', rerank_score: 1.5 }));
    expect(html).toContain('优质');
  });

  it('rerank_score < 1.5 不显示“优质”徽标', () => {
    const html = render(makeResult({ title: 't', url: 'https://a.com', rerank_score: 1.49 }));
    expect(html).not.toContain('优质');
  });

  it('rerank_score 正好 0 时正常显示', () => {
    const html = render(makeResult({ title: 't', url: 'https://a.com', rerank_score: 0 }));
    expect(html).toContain('得分 0');
    expect(html).not.toContain('优质');
  });

  it('rerank_score 为 3 显示优质', () => {
    const html = render(makeResult({ title: 't', url: 'https://a.com', rerank_score: 3 }));
    expect(html).toContain('优质');
  });

  it('authority -1 显示未知（不显示 0~4 徽标）', () => {
    const html = render(makeResult({ title: 't', url: 'https://a.com', authority: -1 }));
    expect(html).not.toContain('权威度');
  });

  it('authority 0 显示权威度 0', () => {
    const html = render(makeResult({ title: 't', url: 'https://a.com', authority: 0 }));
    expect(html).toContain('权威度 0');
  });

  it('authority 4 显示权威度 4', () => {
    const html = render(makeResult({ title: 't', url: 'https://a.com', authority: 4 }));
    expect(html).toContain('权威度 4');
  });

  it('合法日期本地化显示', () => {
    const html = render(makeResult({ title: 't', url: 'https://a.com', date: '2025-01-02T03:04:05Z' }));
    expect(html).toContain('<time');
    expect(html).toContain('2025');
    expect(html).toContain('dateTime="2025-01-02T03:04:05Z"');
  });

  it('非法日期显示原文', () => {
    const html = render(makeResult({ title: 't', url: 'https://a.com', date: '不是日期' }));
    expect(html).toContain('不是日期');
    expect(html).toContain('result-date-invalid');
  });

  it('http 链接可点击，带 rel 与 target', () => {
    const html = render(makeResult({ title: 't', url: 'http://example.com/x' }));
    expect(html).toContain('href="http://example.com/x"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('javascript: url 不渲染为链接', () => {
    const html = render(makeResult({ title: 't', url: 'javascript:alert(1)' }));
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('无有效链接');
    // 无有效链接时不出现抓取/打开按钮
    expect(html).not.toContain('抓取全文');
  });

  it('site_icon 仅 https 才用 img', () => {
    const httpsHtml = render(
      makeResult({ title: 't', url: 'https://a.com', site_icon: 'https://a.com/i.png' }),
    );
    expect(httpsHtml).toContain('<img');
    expect(httpsHtml.toLowerCase()).toContain('referrerpolicy="no-referrer"');

    const httpHtml = render(
      makeResult({ title: 't', url: 'https://a.com', site_icon: 'http://a.com/i.png' }),
    );
    // http 图标降级首字母占位
    expect(httpHtml).not.toContain('site-icon-img');
  });

  it('site_icon 为 javascript: 时不渲染 img', () => {
    const html = render(
      makeResult({ title: 't', url: 'https://a.com', site_icon: 'javascript:alert(1)' }),
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('site-icon-img');
  });

  it('无 url 时降级为纯文本标题', () => {
    const html = render(makeResult({ title: '只有标题' }));
    expect(html).toContain('只有标题');
    expect(html).not.toContain('href=');
  });
});

describe('ResultCard 缺失 / null / 异常类型', () => {
  it('空对象不崩溃', () => {
    expect(() => render(makeResult({}))).not.toThrow();
    const html = render(makeResult({}));
    expect(html).toContain('无标题');
    expect(html).toContain('无评分');
  });

  it('全 null 字段不崩溃', () => {
    const raw = {
      rerank_score: null,
      title: null,
      url: null,
      snippet: null,
      summary: null,
      content: null,
      site_name: null,
      site_icon: null,
      date: null,
      authority: null,
    };
    expect(() => render(makeResult(raw))).not.toThrow();
  });

  it('类型异常（数字/对象/数组）不崩溃', () => {
    const raw = {
      rerank_score: 'high',
      title: 123,
      url: {},
      snippet: ['a'],
      summary: { x: 1 },
      content: true,
      site_name: [],
      site_icon: 42,
      date: 123456,
      authority: 'top',
    };
    expect(() => render(makeResult(raw))).not.toThrow();
  });

  it('rerank_score NaN 不显示得分', () => {
    const html = render(makeResult({ title: 't', url: 'https://a.com', rerank_score: Number.NaN }));
    expect(html).not.toContain('得分');
  });

  it('超长 URL / 单词不产生脚本风险且被输出', () => {
    const longHost = `${'a'.repeat(500)}.com`;
    const html = render(makeResult({ title: 't', url: `https://${longHost}/x` }));
    expect(html).toContain(longHost);
    expect(html).not.toContain('<script');
  });

  it('results 中的非对象项降级为原始 JSON', () => {
    for (const raw of ['字符串结果', 42, null, true, ['数组']]) {
      const html = render(makeResult(raw));
      expect(html).toContain('非标准结果项');
      expect(html).toContain('原始 JSON');
      expect(html).not.toContain('<script');
    }
  });

  it('字符串项内容被转义显示', () => {
    const html = render(makeResult('<script>alert(1)</script>'));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('未知字段收集到“其他字段”', () => {
    const raw = {
      title: 't',
      url: 'https://a.com',
      unknown_field: 'value',
      another: 42,
    };
    const html = render(makeResult(raw));
    expect(html).toContain('其他字段');
  });
});

describe('normalizeSearchEnvelope 兼容性', () => {
  it('空对象 → 空结果列表', () => {
    const envelope = normalizeSearchEnvelope({});
    expect(envelope.results).toEqual([]);
    expect(envelope.cacheStatus).toBe('unknown');
    expect(envelope.elapsedMs).toBeNull();
  });

  it('results 非数组时按空数组处理', () => {
    expect(normalizeSearchEnvelope({ data: { results: 'oops' } }).results).toEqual([]);
    expect(normalizeSearchEnvelope({ data: null }).results).toEqual([]);
    expect(normalizeSearchEnvelope(null).results).toEqual([]);
  });

  it('results 混入非对象项也能逐条规范化', () => {
    const envelope = normalizeSearchEnvelope({
      data: { results: [{ title: 'a', url: 'https://a.com' }, 'str', 7] },
    });
    expect(envelope.results).toHaveLength(3);
    expect(envelope.results[1]?.isObject).toBe(false);
    expect(envelope.results[2]?.isObject).toBe(false);
  });

  it('解析缓存元信息', () => {
    const envelope = normalizeSearchEnvelope({
      cached: true,
      cache_status: 'hit',
      cache_age_seconds: 120,
      stored_at: 1_700_000_000,
      expires_at: 1_700_086_400,
      upstream_status: 200,
      elapsed_ms: 321.5,
      data: { results: [] },
    });
    expect(envelope.cacheStatus).toBe('hit');
    expect(envelope.cacheAgeSeconds).toBe(120);
    expect(envelope.elapsedMs).toBe(321.5);
    expect(envelope.upstreamStatus).toBe(200);
  });

  it('未知 cache_status 归为 unknown', () => {
    expect(normalizeSearchEnvelope({ cache_status: 'weird' }).cacheStatus).toBe('unknown');
  });

  it('未知字段进入 extraTop / extraData', () => {
    const envelope = normalizeSearchEnvelope({
      foo: 'bar',
      data: { results: [], extra: 1 },
    });
    expect(envelope.extraTop['foo']).toBe('bar');
    expect(envelope.extraData['extra']).toBe(1);
  });

  it('url 字段自动过安全校验', () => {
    const envelope = normalizeSearchEnvelope({
      data: { results: [{ url: 'javascript:alert(1)' }, { url: 'https://ok.com' }] },
    });
    expect(envelope.results[0]?.url).toBeNull();
    expect(envelope.results[1]?.url).toBe('https://ok.com/');
  });
});
