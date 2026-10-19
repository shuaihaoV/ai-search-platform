/**
 * 轻提示（toast）：用于“已复制”等非阻塞反馈。
 * aria-live=polite，不抢焦点。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { NotifyFn, NotifyTone } from '../types';
import { CloseIcon } from './Icons';

interface ToastItem {
  id: number;
  message: string;
  tone: NotifyTone;
}

export interface ToastApi {
  notify: NotifyFn;
  view: ReactElement;
}

const AUTO_DISMISS_MS = 2600;

export function useToast(): ToastApi {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  // 用 Set 保存未触发的定时器：触发后立即移除，长会话不会缓慢累积
  const timersRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => {
        window.clearTimeout(timer);
      });
      timers.clear();
    };
  }, []);

  const dismiss = useCallback((id: number): void => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback<NotifyFn>(
    (message, tone = 'info') => {
      idRef.current += 1;
      const id = idRef.current;
      setItems((prev) => [...prev.slice(-2), { id, message, tone }]);
      const timer = window.setTimeout(() => {
        timersRef.current.delete(timer);
        dismiss(id);
      }, AUTO_DISMISS_MS);
      timersRef.current.add(timer);
    },
    [dismiss],
  );

  const view = (
    <div className="toast-region" role="status" aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <div key={item.id} className={`toast toast-${item.tone}`}>
          <span className="toast-text">{item.message}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => {
              dismiss(item.id);
            }}
            aria-label="关闭提示"
          >
            <CloseIcon size={16} />
          </button>
        </div>
      ))}
    </div>
  );

  return { notify, view };
}
