import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PasswordGate } from '../components/PasswordGate';

const noop = (): void => {};
const inputRef = { current: null } as React.RefObject<HTMLInputElement | null>;

function render(overrides: Partial<Parameters<typeof PasswordGate>[0]> = {}): string {
  return renderToStaticMarkup(
    <PasswordGate
      onSubmit={noop}
      loading={false}
      error={null}
      inputRef={inputRef}
      {...overrides}
    />,
  );
}

describe('PasswordGate 访问门禁', () => {
  it('渲染密码输入框，复用搜索框视觉结构', () => {
    const html = render();
    expect(html).toContain('type="password"');
    expect(html).toContain('class="search-box"');
    expect(html).toContain('id="platform-password"');
    expect(html).toContain('需要访问密码');
  });

  it('密码输入不使用明文类型，且关闭自动纠错', () => {
    const html = render();
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('spellCheck="false"');
    expect(html).not.toContain('type="text"');
  });

  it('初始状态提交按钮禁用（密码为空）', () => {
    const html = render();
    expect(html).toContain('disabled=""');
  });

  it('错误时渲染 role=alert 并标记 aria-invalid', () => {
    const html = render({ error: '访问密码错误，请重试' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('访问密码错误，请重试');
    expect(html).toContain('search-box search-box-invalid');
    expect(html).toContain('aria-invalid="true"');
  });

  it('loading 时显示 spinner 且按钮禁用', () => {
    const html = render({ loading: true });
    expect(html).toContain('spinner');
    expect(html).toContain('disabled=""');
    expect(html).toContain('验证中');
  });

  it('提示信息以 role=status 呈现', () => {
    const html = render({ notice: '访问密码已失效，请重新输入' });
    expect(html).toContain('role="status"');
    expect(html).toContain('访问密码已失效');
  });

  it('不在 DOM 中暴露任何密码或 token', () => {
    const html = render({ error: null });
    expect(html).not.toMatch(/token/i);
    // 受控输入初值为空：不允许任何预填的密码内容
    expect(html).toContain('value=""');
  });
});
