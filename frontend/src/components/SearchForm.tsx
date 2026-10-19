/**
 * 搜索框：输入框 + [语法] [高级] [搜索] 三个按钮。
 *
 * 语法与高级设置均通过模态框打开，入口按钮位于搜索按钮左侧。
 * 兼容移动端吸顶紧凑模式（sticky）；输入字号 ≥16px 防 iOS 自动缩放。
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import { CloseIcon, CodeIcon, SearchIcon, SlidersIcon } from './Icons';

interface SearchFormProps {
  query: string;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  loading: boolean;
  onOpenSyntax: () => void;
  onOpenSettings: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  maxChars: number;
  countChars: (value: string) => number;
  compact: boolean;
  queryError: string | null;
  /** 当前的设置是否偏离默认值（用于在按钮上提示） */
  settingsDirty: boolean;
}

export function SearchForm({
  query,
  onQueryChange,
  onSubmit,
  onClear,
  loading,
  onOpenSyntax,
  onOpenSettings,
  inputRef,
  maxChars,
  countChars,
  compact,
  queryError,
  settingsDirty,
}: SearchFormProps): ReactElement {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [stuck, setStuck] = useState(false);
  const length = countChars(query);
  const overLimit = length > maxChars;
  // 只在对应提示节点确实渲染时才引用其 id，避免悬空的 aria-describedby
  const describedBy =
    queryError !== null ? 'search-hint search-error' : overLimit ? 'search-hint' : undefined;

  // 吸顶紧凑模式：滚动时切换 class（不依赖内联样式）
  // 用 state 驱动 className，而不是直接改 DOM classList，避免 React 重渲染时状态丢失
  useEffect(() => {
    if (compact) {
      return undefined;
    }
    const element = formRef.current;
    if (element === null || typeof window === 'undefined') {
      return undefined;
    }
    const onScroll = (): void => {
      const next = element.getBoundingClientRect().top <= 0;
      setStuck((prev) => (prev === next ? prev : next));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, [compact]);

  return (
    <form
      ref={formRef}
      className={
        compact ? 'search-form search-form-compact' : stuck ? 'search-form is-stuck' : 'search-form'
      }
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className={queryError === null ? 'search-box' : 'search-box search-box-invalid'}>
        <SearchIcon size={20} className="search-box-icon" />
        <label htmlFor="search-input" className="sr-only">
          搜索关键词
        </label>
        <input
          id="search-input"
          ref={inputRef}
          className="search-input"
          type="search"
          name="q"
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
          }}
          placeholder="输入关键词，支持 site: 等搜索语法"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          maxLength={maxChars}
          aria-invalid={queryError !== null}
          aria-describedby={describedBy}
        />
        {query !== '' ? (
          <button type="button" className="search-clear" onClick={onClear} aria-label="清空关键词">
            <CloseIcon size={18} />
          </button>
        ) : null}

        <div className="search-box-actions">
          <button
            type="button"
            className="btn btn-ghost search-tool tip tip-b"
            onClick={onOpenSyntax}
            data-tip="搜索语法"
            aria-label="搜索语法"
            aria-haspopup="dialog"
          >
            <CodeIcon size={18} />
          </button>
          <button
            type="button"
            className={
              settingsDirty
                ? 'btn btn-ghost search-tool is-active tip tip-b'
                : 'btn btn-ghost search-tool tip tip-b'
            }
            onClick={onOpenSettings}
            data-tip="高级搜索"
            aria-label="高级搜索"
            aria-haspopup="dialog"
          >
            <SlidersIcon size={18} />
          </button>
          <button
            type="submit"
            className="btn btn-primary search-submit tip tip-b"
            disabled={loading}
            data-tip={loading ? '搜索中' : '搜索'}
            aria-label={loading ? '搜索中' : '搜索'}
          >
            {loading ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <SearchIcon size={18} />
            )}
          </button>
        </div>
      </div>

      {queryError !== null || overLimit ? (
        <div className="search-form-foot">
          <p
            id="search-hint"
            className={overLimit ? 'field-hint field-hint-error' : 'field-hint'}
          >
            {length} / {maxChars} 字符
          </p>
          {queryError !== null ? (
            <p id="search-error" className="field-error" role="alert">
              {queryError}
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
