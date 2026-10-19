/**
 * 空状态。
 */

import type { ReactElement, ReactNode } from 'react';
import { SparkIcon } from './Icons';

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps): ReactElement {
  return (
    <div className="empty-state" role="status">
      <span className="empty-icon" aria-hidden="true">
        <SparkIcon size={28} />
      </span>
      <h2 className="empty-title">{title}</h2>
      <p className="empty-desc">{description}</p>
      {action !== undefined ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
