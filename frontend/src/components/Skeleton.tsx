/**
 * 加载骨架屏（不依赖内联样式，全部靠 class + CSS 动画）。
 *
 * 纯装饰：加载状态由 App 的 aria-live 区域统一播报，
 * 这里不能再设 role="status"，否则读屏会重复播报。
 */

import type { ReactElement } from 'react';

interface SkeletonProps {
  rows?: number;
  showMeta?: boolean;
}

export function Skeleton({ rows = 3, showMeta = true }: SkeletonProps): ReactElement {
  return (
    <div className="skeleton-wrap" aria-hidden="true">
      {showMeta ? (
        <div className="skeleton-meta">
          <span className="skeleton skeleton-pill" />
          <span className="skeleton skeleton-pill" />
          <span className="skeleton skeleton-pill" />
        </div>
      ) : null}
      <div className="skeleton-list">
        {Array.from({ length: rows }, (_unused, index) => (
          <div className="skeleton-card" key={`skeleton-${String(index)}`}>
            <div className="skeleton-card-head">
              <span className="skeleton skeleton-badge" />
              <span className="skeleton skeleton-badge" />
            </div>
            <span className="skeleton skeleton-title" />
            <span className="skeleton skeleton-line" />
            <span className="skeleton skeleton-line skeleton-line-short" />
            <div className="skeleton-card-foot">
              <span className="skeleton skeleton-button" />
              <span className="skeleton skeleton-button" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
