/**
 * 原始 JSON 折叠展示。
 *
 * 全项目禁止 innerHTML，这里一律以 React 文本节点渲染；
 * 展示长度受 RAW_JSON_LIMIT 限制，超限截断并提示。
 */

import { memo, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { stringifySafe } from '../lib/validation';
import { RAW_JSON_LIMIT, truncateText } from '../lib/markdown';
import type { NotifyFn } from '../types';
import { ChevronDownIcon, ChevronRightIcon } from './Icons';
import { CopyButton } from './CopyButton';

interface RawJsonProps {
  value: unknown;
  label?: string;
  notify: NotifyFn;
  /** 默认展开 */
  defaultOpen?: boolean;
  /** 使用紧凑样式 */
  compact?: boolean;
  /** 长度上限（字符） */
  limit?: number;
  /** 隐藏体积标注 */
  hideSize?: boolean;
  /** 复制按钮仅图标（无文字） */
  copyIconOnly?: boolean;
}

export const RawJson = memo(function RawJson({
  value,
  label = '原始 JSON',
  notify,
  defaultOpen = false,
  compact = false,
  limit = RAW_JSON_LIMIT,
  hideSize = false,
  copyIconOnly = false,
}: RawJsonProps): ReactElement {
  const [open, setOpen] = useState<boolean>(defaultOpen);
  // 序列化/截断都是 O(n)；父组件每次渲染（如输入关键词、Toast）都会重渲染本组件，
  // 只有 value / limit 变化时才需要重算。
  const fullText = useMemo(() => stringifySafe(value, 2), [value]);
  const { text, truncated } = useMemo(
    () => truncateText(fullText, limit),
    [fullText, limit],
  );

  return (
    <div className={compact ? 'raw-json raw-json-compact' : 'raw-json'}>
      <div className="raw-json-head">
        <button
          type="button"
          className="btn btn-small btn-ghost raw-json-toggle"
          onClick={() => {
            setOpen((prev) => !prev);
          }}
          aria-expanded={open}
        >
          {open ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
          <span>{label}</span>
          {hideSize ? null : (
            <span className="raw-json-size">{fullText.length.toLocaleString('zh-CN')} 字符</span>
          )}
        </button>
        {open ? (
          <CopyButton
            text={fullText}
            label="复制 JSON"
            notify={notify}
            className={copyIconOnly ? 'btn btn-small btn-ghost tip tip-b tip-r' : 'btn btn-small'}
            iconOnly={copyIconOnly}
          />
        ) : null}
      </div>

      {open ? (
        <div className="raw-json-body">
          {truncated ? (
            <p className="raw-json-notice" role="note">
              内容过长，仅展示前 {limit.toLocaleString('zh-CN')} 字符（共 {fullText.length.toLocaleString('zh-CN')} 字符）。复制仍可获取完整内容。
            </p>
          ) : null}
          <pre className="raw-json-pre">
            <code>{text}</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
});
