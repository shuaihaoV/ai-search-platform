/**
 * 高级设置面板回归测试。
 *
 * 覆盖第二轮审计发现：config 未加载（/api/config 失败或首屏早期）时，
 * 结果数量的「默认值」提示曾硬编码为 10，与全项目统一兜底 50 不一致。
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdvancedSettings } from '../components/AdvancedSettings';
import { FALLBACK_DEFAULTS, FALLBACK_LIMITS } from '../lib/validation';
import type { SearchSettings } from '../types';

const settings: SearchSettings = {
  count: 50,
  need_content: true,
  ori_question: '',
  localization: '',
  force_refresh: false,
};

function render(config: Parameters<typeof AdvancedSettings>[0]['config']): string {
  return renderToStaticMarkup(
    <AdvancedSettings
      settings={settings}
      config={config}
      limits={{
        count_min: FALLBACK_LIMITS.count_min,
        count_max: FALLBACK_LIMITS.count_max,
        ori_question_max_chars: FALLBACK_LIMITS.ori_question_max_chars,
      }}
      onChange={() => undefined}
      onReset={() => undefined}
      error={null}
      countChars={(value) => [...value].length}
    />,
  );
}

/** React SSR 会在相邻文本节点之间插入 `<!-- -->`，比较前先去掉 */
const textOf = (html: string): string => html.replace(/<!-- -->/gu, '');

describe('AdvancedSettings', () => {
  it('config 缺失时「默认」提示使用内置兜底值 50（历史缺陷为 10）', () => {
    const html = textOf(render(null));
    expect(html).toContain(`默认 ${FALLBACK_DEFAULTS.count}`);
    expect(html).not.toContain('默认 10');
  });

  it('config 存在时「默认」提示来自 /api/config', () => {
    const html = textOf(
      render({
        version: '0.1.0',
        defaults: { count: 20, need_content: true, ori_question: '', localization: '' },
        limits: FALLBACK_LIMITS,
        cache: {
          search_enabled: true,
          search_ttl_seconds: 86_400,
          fetch_enabled: true,
          fetch_ttl_seconds: 86_400,
        },
        upstream: { configured: true },
      }),
    );
    expect(html).toContain('默认 20');
  });
});
