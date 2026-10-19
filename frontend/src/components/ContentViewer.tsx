/**
 * 结果卡片内的「页内内容查看器」——与「抓取全文」一致的右侧抽屉。
 *
 * 长摘要 / 正文 / 原始 JSON 三种内容共用同一形态：
 * 从右侧滑出、同一套头部（复制 + 关闭）、同一套正文排版。
 *
 * 安全：
 * - 长摘要与正文走 MarkdownView（skipHtml、无 rehype-raw、协议白名单）；
 * - 原始 JSON 以等宽 <pre> 纯文本渲染，绝不使用 innerHTML。
 */

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import type { NotifyFn } from '../types';
import { MarkdownView } from './MarkdownView';
import { CopyButton } from './CopyButton';
import { CopyIcon, CloseIcon } from './Icons';

/** 弹层内容形态 */
export type ViewerKind = 'summary' | 'content' | 'json';

export interface ViewerPayload {
  kind: ViewerKind;
  title: string;
  /** 纯文本内容（json 已格式化） */
  text: string;
  /** 副标题（来源、长度等） */
  description: string;
  /** 是否因超长而截断 */
  truncated: boolean;
  /** 原始总长度（用于截断提示） */
  fullLength: number;
  /** 原页 URL：用于解析 Markdown 中的相对链接 */
  baseUrl?: string | null;
}

interface ContentViewerProps {
  payload: ViewerPayload | null;
  onClose: () => void;
  notify: NotifyFn;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ContentViewer({ payload, onClose, notify }: ContentViewerProps): ReactElement | null {
  const open = payload !== null;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const hasBeenOpenRef = useRef(false);

  // 打开：记录原焦点并同步聚焦关闭按钮（不留可 Tab 逃逸的 0ms 窗口）；关闭：焦点归位
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
      }
    }
  }, [open]);

  // Esc 关闭 + Tab 焦点陷阱 + 锁背景滚动
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const panel = panelRef.current;
      if (panel === null) {
        return;
      }
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );
      if (nodes.length === 0) {
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
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
    document.body.classList.add('drawer-open');
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('drawer-open');
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="drawer-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="viewer-title"
      >
        <header className="drawer-head">
          <div className="drawer-head-main">
            <h2 className="drawer-title" id="viewer-title">
              {payload.title}
            </h2>
            {payload.description !== '' ? (
              <p className="drawer-source">
                <span className="drawer-source-host">{payload.description}</span>
              </p>
            ) : null}
          </div>
          <div className="drawer-head-actions">
            <CopyButton
              text={payload.text}
              label="复制内容"
              notify={notify}
              className="icon-button tip tip-b tip-r"
              iconOnly
              icon={<CopyIcon size={18} />}
            />
            <button
              ref={closeButtonRef}
              type="button"
              className="icon-button drawer-close"
              onClick={onClose}
              aria-label="关闭"
            >
              <CloseIcon size={20} />
            </button>
          </div>
        </header>

        <div className="drawer-body">
          {payload.truncated ? (
            <p className="viewer-notice" role="note">
              内容过长，仅展示前 {payload.text.length.toLocaleString('zh-CN')} 字符（共{' '}
              {payload.fullLength.toLocaleString('zh-CN')} 字符）。点击复制可获取完整内容。
            </p>
          ) : null}

          {payload.kind === 'json' ? (
            <pre className="viewer-pre">
              <code>{payload.text}</code>
            </pre>
          ) : (
            /* 长摘要与正文按 Markdown 渲染；MarkdownView 内部已做安全处理 */
            <MarkdownView markdown={payload.text} baseUrl={payload.baseUrl ?? null} />
          )}

        </div>
      </div>
    </div>
  );
}
