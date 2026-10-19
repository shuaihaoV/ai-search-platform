/**
 * 结果列表：直接渲染全部结果 + 原始响应 JSON。
 *
 * 说明：上游 Search API 不支持分页（无 page/offset/cursor 参数），单次最多返回
 * 50 条（count 上限）；因此本组件不再做任何“加载更多”式的客户端切片，
 * 只展示服务端实际返回的全部条目。
 */

import { memo } from 'react';
import type { ReactElement } from 'react';
import type { NormalizedResult, SearchEnvelope } from '../types';
import type { NotifyFn } from '../types';
import { ResultCard } from './ResultCard';
import { EmptyState } from './EmptyState';
import { RawJson } from './RawJson';

interface ResultListProps {
  envelope: SearchEnvelope;
  onFetch: (url: string, title: string | null) => void;
  notify: NotifyFn;
  fetchingUrl: string | null;
  onShare: (result: NormalizedResult) => void;
  query: string;
}

/**
 * 单次渲染上限，与上游 count 最大值保持一致。
 * 上游一次最多返回 50 条，因此 50 足以覆盖全部结果；
 * 保留该常量是为了在极端情况下（响应被篡改/异常）仍能防御性截断。
 */
export const PAGE_SIZE = 50;

export const ResultList = memo(function ResultList({
  envelope,
  onFetch,
  notify,
  fetchingUrl,
  onShare,
  query,
}: ResultListProps): ReactElement {
  const total = envelope.results.length;
  const visible = envelope.results.slice(0, PAGE_SIZE);

  if (total === 0) {
    return (
      <section className="results-section" aria-label="搜索结果">
        <EmptyState
          title="没有找到结果"
          description={`未检索到与「${query}」相关的内容。可以尝试更换关键词、放宽日期限制或移除排除词。`}
        />
        <div className="results-raw">
          <RawJson
            value={envelope.raw}
            label="原始响应"
            notify={notify}
            compact
            hideSize
            copyIconOnly
          />
        </div>
      </section>
    );
  }

  return (
    <section className="results-section" aria-label="搜索结果">
      <ol className="result-list">
        {visible.map((result) => (
          <li key={`${String(result.index)}-${result.url ?? 'raw'}`} className="result-list-item">
            <ResultCard
              result={result}
              onFetch={onFetch}
              notify={notify}
              fetchingUrl={fetchingUrl}
              onShare={onShare}
            />
          </li>
        ))}
      </ol>

      <p className="results-end field-hint">共 {total} 条结果</p>

      <div className="results-raw">
        <RawJson
            value={envelope.raw}
            label="原始响应"
            notify={notify}
            compact
            hideSize
            copyIconOnly
          />
      </div>
    </section>
  );
});
