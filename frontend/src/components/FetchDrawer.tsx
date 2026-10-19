/**
 * 抓取全文 Drawer（桌面右侧滑出 / 移动端全屏 Sheet）。
 *
 * - role="dialog" aria-modal="true"，Esc 关闭；
 * - 关闭后焦点返回触发按钮（由父组件传入 trigger 元素）；
 * - 渲染 react-markdown + remark-gfm，skipHtml。
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import type { ApiError } from '../api/client';
import { friendlyErrorMessage } from '../api/client';
import type { FetchEnvelope } from '../types';
import type { NotifyFn } from '../types';
import { safeHostname } from '../lib/safeUrl';
import {
  CloseIcon,
  CopyIcon,
  DocumentIcon,
  OpenExternalIcon,
  RefreshIcon,
  WarningIcon,
} from './Icons';
import { copyText } from './CopyButton';
import { MarkdownView } from './MarkdownView';
import { RawJson } from './RawJson';

export interface FetchTarget {
  url: string;
  title: string | null;
}

interface FetchDrawerProps {
  open: boolean;
  target: FetchTarget | null;
  status: 'idle' | 'loading' | 'success' | 'error';
  envelope: FetchEnvelope | null;
  error: ApiError | null;
  onClose: () => void;
  onRetry: () => void;
  notify: NotifyFn;
  returnFocusTo: () => void;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function FetchDrawer({
  open,
  target,
  status,
  envelope,
  error,
  onClose,
  onRetry,
  notify,
  returnFocusTo,
}: FetchDrawerProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const hasBeenOpenRef = useRef(false);

  const handleClose = useCallback((): void => {
    onClose();
  }, [onClose]);

  // 打开：记录原焦点 → 同步聚焦关闭按钮（不留可 Tab 逃逸的 0ms 窗口）；
  // 关闭：优先把焦点还给触发按钮，否则退回记录的元素。只在 effect 中做一次。
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    if (open) {
      const active = document.activeElement;
      previousFocusRef.current = active instanceof HTMLElement ? active : null;
      hasBeenOpenRef.current = true;
      closeButtonRef.current?.focus();
      return;
    }
    if (hasBeenOpenRef.current) {
      hasBeenOpenRef.current = false;
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous !== null && document.contains(previous)) {
        previous.focus();
      } else {
        returnFocusTo();
      }
    }
  }, [open, returnFocusTo]);

  // Esc 关闭 + Tab 焦点陷阱
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const panel = panelRef.current;
      if (panel === null) {
        return;
      }
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusables.length === 0) {
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [handleClose, open]);

  // 打开时锁定背景滚动
  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      return undefined;
    }
    document.body.classList.add('drawer-open');
    return () => {
      // 用 classList 增删，避免整串覆盖 body.className 清掉其它浮层/主题类
      document.body.classList.remove('drawer-open');
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const content = envelope?.content ?? null;
  const sourceHost = safeHostname(target?.url ?? null);
  const title = envelope?.title ?? target?.title ?? null;

  const handleCopyMarkdown = (): void => {
    void (async (): Promise<void> => {
      if (content === null) {
        notify('暂无可复制的 Markdown', 'error');
        return;
      }
      const ok = await copyText(content);
      notify(ok ? '已复制 Markdown 全文' : '复制失败，请手动选择复制', ok ? 'success' : 'error');
    })();
  };

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={handleClose} aria-hidden="true" />
      <div
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        ref={panelRef}
      >
        <header className="drawer-head">
          <div className="drawer-head-main">
            <h2 className="drawer-title" id="drawer-title">
              {title ?? '网页全文'}
            </h2>
            {target !== null ? (
              <p className="drawer-source">
                <span className="drawer-source-host">{sourceHost ?? '来源网页'}</span>
                <code className="drawer-source-url">{target.url}</code>
              </p>
            ) : null}
          </div>
          <div className="drawer-head-actions">
            {status === 'success' && envelope !== null ? (
              <button
                type="button"
                className="icon-button tip tip-b tip-r"
                onClick={handleCopyMarkdown}
                data-tip="复制 Markdown"
                aria-label="复制 Markdown"
              >
                <CopyIcon size={18} />
              </button>
            ) : null}
            {target !== null ? (
              <a
                className="icon-button tip tip-b tip-r"
                href={target.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                data-tip="打开原页"
                aria-label="打开原页"
              >
                <OpenExternalIcon size={18} />
              </a>
            ) : null}
            <button
              ref={closeButtonRef}
              type="button"
              className="icon-button drawer-close"
              onClick={handleClose}
              aria-label="关闭全文面板"
            >
              <CloseIcon size={20} />
            </button>
          </div>
        </header>

        {status === 'loading' ? (
          <div className="drawer-body drawer-loading" role="status" aria-live="polite">
            <span className="spinner spinner-large" aria-hidden="true" />
            <p>正在抓取全文…</p>
          </div>
        ) : null}

        {status === 'error' && error !== null ? (
          <div className="drawer-body">
            <div className="drawer-error" role="alert">
              <span className="error-icon" aria-hidden="true">
                <WarningIcon size={22} />
              </span>
              <div>
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
                </div>
              </div>
            </div>
            <div className="drawer-error-actions">
              <button type="button" className="btn btn-primary btn-small" onClick={onRetry}>
                <RefreshIcon size={16} />
                <span>重试</span>
              </button>
              {target !== null ? (
                <a
                  className="btn btn-small btn-ghost"
                  href={target.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  <OpenExternalIcon size={16} />
                  <span>打开原页</span>
                </a>
              ) : null}
            </div>
            <RawJson value={error.raw ?? error.normalized.raw} label="原始错误 JSON" notify={notify} />
          </div>
        ) : null}

        {status === 'success' && envelope !== null ? (
          <>
            <div className="drawer-body">
              {content !== null && content.trim() !== '' ? (
                <MarkdownView markdown={content} baseUrl={target?.url ?? null} />
              ) : (
                <div className="drawer-empty">
                  <DocumentIcon size={28} />
                  <p>该页面未返回可渲染的正文内容。</p>
                </div>
              )}

              {Object.keys(envelope.extraData).length > 0 ? (
                <RawJson
                  value={envelope.extraData}
                  label="其他字段"
                  notify={notify}
                  compact
                />
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
