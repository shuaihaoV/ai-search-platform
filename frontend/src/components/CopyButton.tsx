/**
 * 通用小组件：复制按钮。
 *
 * 剪贴板 API 在非安全上下文可能不可用，需降级到隐藏 textarea + execCommand。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { NotifyFn } from '../types';
import { CheckIcon, CopyIcon } from './Icons';

interface CopyButtonProps {
  text: string;
  label: string;
  copiedLabel?: string;
  notify: NotifyFn;
  className?: string;
  disabled?: boolean;
  /** 仅显示图标（不渲染文字），用于标题行等紧凑位置 */
  iconOnly?: boolean;
  /** 自定义图标（未复制状态） */
  icon?: ReactElement;
}

/** 复制文本到剪贴板（含降级实现） */
export async function copyText(text: string): Promise<boolean> {
  if (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    navigator.clipboard !== undefined &&
    window.isSecureContext
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 继续走降级路径
    }
  }

  if (typeof document === 'undefined') {
    return false;
  }

  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.className = 'clipboard-fallback';
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    // 无论成功失败都移除临时节点，避免异常路径留下 DOM 垃圾
    if (textarea !== null && textarea.parentNode !== null) {
      textarea.parentNode.removeChild(textarea);
    }
  }
}

export function CopyButton({
  text,
  label,
  copiedLabel = '已复制',
  notify,
  className,
  disabled = false,
  iconOnly = false,
  icon,
}: CopyButtonProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleClick = useCallback((): void => {
    void (async (): Promise<void> => {
      const ok = await copyText(text);
      if (ok) {
        setCopied(true);
        notify(copiedLabel, 'success');
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
        }
        timerRef.current = window.setTimeout(() => {
          setCopied(false);
        }, 2000);
      } else {
        notify('复制失败，请手动选择复制', 'error');
      }
    })();
  }, [copiedLabel, notify, text]);

  return (
    <button
      type="button"
      className={`${className ?? 'btn btn-small'} tip`}
      onClick={handleClick}
      disabled={disabled}
      data-tip={copied ? copiedLabel : label}
      aria-label={copied ? copiedLabel : label}
    >
      {copied ? <CheckIcon size={iconOnly ? 14 : 16} /> : (icon ?? <CopyIcon size={iconOnly ? 14 : 16} />)}
      {iconOnly ? null : <span>{copied ? copiedLabel : label}</span>}
    </button>
  );
}
