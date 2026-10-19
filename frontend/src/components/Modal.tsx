/**
 * 通用模态框：居中卡片 + 遮罩，桌面居中 / 移动端底部全宽 Sheet。
 *
 * 无障碍：role="dialog" aria-modal="true"、Esc 关闭、Tab 焦点陷阱、
 * 打开时聚焦首个可聚焦元素、关闭后焦点返回触发元素。
 * 不依赖任何内联样式，全部通过 class 控制（严格 CSP）。
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { CloseIcon } from './Icons';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  title: string;
  /** 标题下方的辅助说明 */
  description?: string;
  onClose: () => void;
  children: ReactNode;
  /** 底部操作区（可选） */
  footer?: ReactNode;
  /** 头部操作区：渲染在关闭按钮左侧（图标按钮组） */
  headerActions?: ReactNode;
  /** 面板宽度修饰：默认 medium，可选 wide */
  size?: 'medium' | 'wide';
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  headerActions,
  size = 'medium',
}: ModalProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const hasBeenOpenRef = useRef(false);
  const titleId = useRef(`modal-title-${String(Math.random()).slice(2, 9)}`);
  const descriptionId = useRef(`modal-desc-${String(Math.random()).slice(2, 9)}`);
  const hasDescription = description !== undefined && description !== '';

  const handleClose = useCallback((): void => {
    onClose();
  }, [onClose]);

  // 打开：记录原焦点 → 同步聚焦关闭按钮（不留可 Tab 逃逸的 0ms 窗口）；
  // 关闭：焦点归位。焦点恢复只在 effect 中做一次，避免双路径重复聚焦。
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

  // Esc 关闭 + Tab 焦点陷阱 + 锁定背景滚动
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
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('modal-open');
    };
  }, [open, handleClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-root">
      <div
        className="modal-backdrop"
        onClick={handleClose}
        aria-hidden="true"
      />
      <div
        className={size === 'wide' ? 'modal-panel modal-panel-wide' : 'modal-panel'}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        aria-describedby={hasDescription ? descriptionId.current : undefined}
      >
        <header className="modal-head">
          <div className="modal-head-main">
            <h2 className="modal-title" id={titleId.current}>
              {title}
            </h2>
            {hasDescription ? (
              <p className="modal-desc" id={descriptionId.current}>
                {description}
              </p>
            ) : null}
          </div>
          {headerActions !== undefined ? (
            <div className="modal-head-actions">{headerActions}</div>
          ) : null}
          <button
            ref={closeButtonRef}
            type="button"
            className="modal-close tip tip-b tip-r"
            onClick={handleClose}
            data-tip="关闭（Esc）"
            aria-label="关闭"
          >
            <CloseIcon size={20} />
          </button>
        </header>

        <div className="modal-body">{children}</div>

        {footer !== undefined ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}
