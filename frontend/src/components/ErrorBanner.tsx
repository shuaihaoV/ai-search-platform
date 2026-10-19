/**
 * 错误横幅：显示 code / message / retryable / upstream_status / retry_after_seconds，
 * 提供“重试”与“查看原始错误”。
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import type { ApiError } from '../api/client';
import { friendlyErrorMessage } from '../api/client';
import { stringifySafe } from '../lib/validation';
import { WarningIcon } from './Icons';
import { CopyButton } from './CopyButton';
import type { NotifyFn } from '../types';

interface ErrorBannerProps {
  error: ApiError;
  onRetry: () => void;
  notify: NotifyFn;
  /** 重试按钮是否禁用（例如加载中） */
  retrying?: boolean;
}

export function ErrorBanner({ error, onRetry, notify, retrying = false }: ErrorBannerProps): ReactElement {
  const [showRaw, setShowRaw] = useState(false);
  const rawText = stringifySafe(error.raw ?? error.normalized.raw, 2);

  return (
    <div className="error-banner" role="alert">
      <div className="error-banner-head">
        <span className="error-icon" aria-hidden="true">
          <WarningIcon size={22} />
        </span>
        <div className="error-main">
          <p className="error-message">{friendlyErrorMessage(error)}</p>
          <div className="error-tags">
            <span className="badge badge-error">code: {error.code}</span>
            <span className={error.retryable ? 'badge badge-warn' : 'badge badge-muted'}>
              {error.retryable ? '可重试' : '不可重试'}
            </span>
            {error.upstreamStatus !== null ? (
              <span className="badge">上游状态 {String(error.upstreamStatus)}</span>
            ) : null}
            {error.retryAfterSeconds !== null ? (
              <span className="badge">建议 {String(error.retryAfterSeconds)} 秒后重试</span>
            ) : null}
            {error.httpStatus !== null ? <span className="badge badge-muted">HTTP {String(error.httpStatus)}</span> : null}
          </div>
        </div>
      </div>

      <div className="error-actions">
        <button type="button" className="btn btn-primary btn-small" onClick={onRetry} disabled={retrying}>
          {retrying ? <span className="spinner" aria-hidden="true" /> : null}
          <span>重试</span>
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => {
            setShowRaw((prev) => !prev);
          }}
          aria-expanded={showRaw}
        >
          {showRaw ? '收起原始错误' : '查看原始错误'}
        </button>
        <CopyButton text={rawText} label="复制错误" notify={notify} />
      </div>

      {showRaw ? (
        <pre className="error-raw">
          <code>{rawText}</code>
        </pre>
      ) : null}
    </div>
  );
}
