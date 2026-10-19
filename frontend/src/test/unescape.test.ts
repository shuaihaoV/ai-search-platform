import { describe, expect, it } from 'vitest';
import { unescapeUpstreamMarkdown } from '../lib/markdown';

describe('上游 Fetch 过度转义还原', () => {
  it('还原标题井号', () => {
    expect(unescapeUpstreamMarkdown('\\#\\#\\# Free Trial')).toBe('### Free Trial');
  });

  it('还原列表项与百分号', () => {
    expect(unescapeUpstreamMarkdown('\\- item 30\\%')).toBe('- item 30%');
  });

  it('还原被转义的链接与斜杠', () => {
    expect(unescapeUpstreamMarkdown('http\\://a\\.com/b')).toBe('http://a.com/b');
  });

  it('真实换行与控制字符不受影响', () => {
    const raw = '### 标题\n\n正文\\#不是标题';
    expect(unescapeUpstreamMarkdown(raw)).toBe('### 标题\n\n正文#不是标题');
  });

  it('不含反斜杠时原样返回', () => {
    const raw = '### 干净标题\n\n- 列表';
    expect(unescapeUpstreamMarkdown(raw)).toBe(raw);
  });

  it('不还原被转义的尖括号（避免字面 HTML 变成裸标签被 skipHtml 吞掉）', () => {
    expect(unescapeUpstreamMarkdown('\\<div\\>')).toBe('\\<div\\>');
    expect(unescapeUpstreamMarkdown('\\<script\\>alert(1)\\</script\\>')).toBe(
      '\\<script\\>alert(1)\\</script\\>',
    );
  });

  it('反斜杠后接非标点字符时保留（保护真实转义）', () => {
    expect(unescapeUpstreamMarkdown('C:\\Users\\name')).toBe('C:\\Users\\name');
  });

  it('空串与非法输入安全', () => {
    expect(unescapeUpstreamMarkdown('')).toBe('');
    expect(unescapeUpstreamMarkdown(undefined as unknown as string)).toBe(undefined);
  });
});
