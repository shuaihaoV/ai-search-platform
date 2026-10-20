/**
 * 访问密码门禁。
 *
 * 仅在设置了 `PLATFORM_PASSWD` 的部署中出现：用与搜索框完全相同的视觉语言
 * （`.search-box` 结构）呈现一个密码输入，验证通过后由 App 切换到正常界面。
 *
 * 安全：
 * - 密码只随请求体发送一次，不写入 localStorage / sessionStorage / URL / 日志；
 * - localStorage 仅保存服务端签发的 token。
 */

import { useEffect, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import { LockIcon } from './Icons';

interface PasswordGateProps {
  onSubmit: (password: string) => void;
  loading: boolean;
  error: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  /** 首次渲染时的提示（如「访问密码已失效」） */
  notice?: string | null;
}

export function PasswordGate({
  onSubmit,
  loading,
  error,
  inputRef,
  notice = null,
}: PasswordGateProps): ReactElement {
  const [password, setPassword] = useState('');

  // 进入门禁即聚焦，减少一次点击
  useEffect(() => {
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [inputRef]);

  const submit = (): void => {
    if (loading || password === '') {
      return;
    }
    onSubmit(password);
  };

  return (
    <section className="password-gate" aria-label="访问验证">
      <h1 className="password-gate-title">需要访问密码</h1>
      <p className="password-gate-desc">
        本站已启用访问密码，请输入后继续使用搜索与抓取功能。
      </p>

      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className={error === null ? 'search-box' : 'search-box search-box-invalid'}>
          <LockIcon size={20} className="search-box-icon" />
          <label htmlFor="platform-password" className="sr-only">
            访问密码
          </label>
          <input
            id="platform-password"
            ref={inputRef}
            className="search-input"
            type="password"
            name="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            placeholder="请输入访问密码"
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={256}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : 'password-gate-error'}
          />
          <div className="search-box-actions">
            <button
              type="submit"
              className="btn btn-primary search-submit"
              disabled={loading || password === ''}
              aria-label={loading ? '验证中' : '验证并进入'}
              title={loading ? '验证中' : '验证并进入'}
            >
              {loading ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <LockIcon size={18} />
              )}
            </button>
          </div>
        </div>

        {notice !== null && notice !== '' && error === null ? (
          <p className="field-hint password-gate-notice" role="status">
            {notice}
          </p>
        ) : null}

        {error !== null ? (
          <p id="password-gate-error" className="field-error password-gate-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
