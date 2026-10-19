/**
 * 单条搜索结果卡片（紧凑版）。
 *
 * 信息层级：标题行（[打开图标] 标题 [复制图标] … [分享]）→ 来源/时间/徽标 → 摘要。
 * 底部操作行统一 ghost 风格：抓取全文 · 长摘要 · 正文 · 原始 JSON。
 * 长摘要/正文的折叠面板渲染在卡片正文区（按钮在底行，内容在上方）。
 *
 * 兼容性要求：所有字段可能缺失 / 为 null / 类型异常，渲染不能崩；
 * results 中的非对象项降级为原始 JSON 展示。
 */

import { memo, useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import type { NormalizedResult } from '../types';
import type { NotifyFn } from '../types';
import { formatAuthority, formatScore } from '../lib/format';
import { initialOf, safeHostname } from '../lib/safeUrl';
import { stringifySafe } from '../lib/validation';
import {
  ChevronRightIcon,
  CopyIcon,
  DocumentIcon,
  LinkIcon,
  OpenExternalIcon,
} from './Icons';
import { CopyButton } from './CopyButton';
import { RawJson } from './RawJson';
import { ContentViewer } from './ContentViewer';
import type { ViewerPayload } from './ContentViewer';
import { RAW_JSON_LIMIT, truncateText } from '../lib/markdown';

interface ResultCardProps {
  result: NormalizedResult;
  onFetch: (url: string, title: string | null) => void;
  notify: NotifyFn;
  /** 正在抓取的 URL（用于按钮 loading 态） */
  fetchingUrl: string | null;
  onShare: (result: NormalizedResult) => void;
}

/** 站点图标：仅 https 才用 <img>，onError 降级首字母占位 */
function SiteIcon({ icon, name }: { icon: string | null; name: string | null }): ReactElement {
  const [failed, setFailed] = useState(false);
  // 契约：site_icon 只有 https 才允许加载
  const usableIcon = icon !== null && icon.startsWith('https://') && !failed ? icon : null;
  const fallback = initialOf(name ?? safeHostname(icon) ?? '?');

  if (usableIcon !== null) {
    return (
      <img
        className="site-icon site-icon-img"
        src={usableIcon}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => {
          setFailed(true);
        }}
      />
    );
  }
  return (
    <span className="site-icon site-icon-fallback" aria-hidden="true">
      {fallback}
    </span>
  );
}

function EmptyValue({ label }: { label: string }): ReactElement {
  return <span className="result-empty-value">{label}</span>;
}

/** 非对象结果项降级展示 */
function FallbackCard({
  result,
  notify,
}: {
  result: NormalizedResult;
  notify: NotifyFn;
}): ReactElement {
  const rawText = stringifySafe(result.raw, 2);
  return (
    <article className="result-card result-card-fallback">
      <header className="result-head">
        <span className="result-index">#{result.index + 1}</span>
        <span className="badge badge-warn">非标准结果项</span>
      </header>
      <p className="result-fallback-note">
        该项不是对象，无法按字段渲染，以下为原始 JSON 内容。
      </p>
      <pre className="result-fallback-pre">
        <code>{rawText}</code>
      </pre>
      <div className="result-actions">
        <CopyButton text={rawText} label="复制原文" notify={notify} />
      </div>
    </article>
  );
}

export const ResultCard = memo(function ResultCard({
  result,
  onFetch,
  notify,
  fetchingUrl,
  onShare,
}: ResultCardProps): ReactElement {
  const [viewer, setViewer] = useState<ViewerPayload | null>(null);
  // 稳定引用：ContentViewer 的 keydown effect 依赖 onClose，
  // 内联箭头会导致父组件每次重渲染都重挂监听。
  const closeViewer = useCallback((): void => {
    setViewer(null);
  }, []);

  if (!result.isObject) {
    return <FallbackCard result={result} notify={notify} />;
  }

  const scoreText = formatScore(result.rerankScore);
  const isHighQuality = result.rerankScore !== null && result.rerankScore >= 1.5;
  const authority = formatAuthority(result.authority);
  const host = safeHostname(result.url);
  const isFetching = fetchingUrl !== null && result.url !== null && fetchingUrl === result.url;
  const titleText = result.title !== null && result.title.trim() !== '' ? result.title : null;
  const hasExtra = Object.keys(result.extra).length > 0;
  const hasSummary = result.summary !== null && result.summary.trim() !== '';
  const hasContent = result.content !== null && result.content.trim() !== '';
  const hasSnippet = result.snippet !== null && result.snippet.trim() !== '';

  return (
    <article className="result-card">
      <div className="result-main">
        <div className="result-head">
          <h2 className="result-title">
            {result.url !== null ? (
              <>
                <a
                  className="result-title-icon tip tip-b"
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  data-tip="在新标签页打开"
                  aria-label="在新标签页打开"
                >
                  <OpenExternalIcon size={14} />
                </a>
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="result-title-link"
                >
                  {titleText ?? result.url}
                </a>
                <CopyIconButton url={result.url} notify={notify} />
              </>
            ) : (
              <span className="result-title-plain">
                {titleText ?? <EmptyValue label="（无标题）" />}
              </span>
            )}
          </h2>

          <button
            type="button"
            className="result-share tip tip-b tip-r"
            onClick={() => {
              onShare(result);
            }}
            data-tip="复制分享链接"
            aria-label="复制分享链接"
          >
            <LinkIcon size={15} />
          </button>
        </div>

        <div className="result-meta-row">
          <SiteIcon icon={result.siteIcon} name={result.siteName} />
          <span className="result-site-name">
            {result.siteName ?? host ?? <EmptyValue label="未知站点" />}
          </span>
          {host !== null ? <span className="result-host">· {host}</span> : null}

          {result.dateText !== null ? (
            <time
              className={result.dateValid ? 'result-date' : 'result-date result-date-invalid'}
              title={result.dateRaw ?? undefined}
              dateTime={result.dateRaw ?? undefined}
            >
              {result.dateText}
            </time>
          ) : null}

          {scoreText !== null ? (
            <span
              className={isHighQuality ? 'badge badge-quality tip tip-b' : 'badge tip tip-b'}
              data-tip="重排得分：0~3 分，越高越靠前"
            >
              {isHighQuality ? '优质 · ' : ''}
              得分 {scoreText}
            </span>
          ) : null}

          {authority.known ? (
            <span
              className={
                result.authority !== null && result.authority >= 3
                  ? 'badge badge-authority-high tip tip-b'
                  : 'badge badge-authority tip tip-b'
              }
              data-tip={authority.label}
            >
              {authority.label}
            </span>
          ) : null}

          {scoreText === null && !authority.known ? (
            <span className="badge badge-muted">无评分</span>
          ) : null}
        </div>

        {hasSnippet ? <p className="result-snippet">{result.snippet}</p> : null}

        {hasExtra ? (
          <RawJson value={result.extra} label="其他字段" notify={notify} compact limit={200_000} />
        ) : null}
      </div>

      <div className="result-actions">
        {result.url !== null ? (
          <button
            type="button"
            className="btn btn-tiny btn-ghost tip"
            onClick={() => {
              if (result.url !== null) {
                onFetch(result.url, result.title);
              }
            }}
            disabled={isFetching}
            data-tip="抓取该网页全文并以 Markdown 阅读"
          >
            {isFetching ? <span className="spinner" aria-hidden="true" /> : <DocumentIcon size={14} />}
            <span>{isFetching ? '抓取中' : '抓取全文'}</span>
          </button>
        ) : (
          <span className="result-empty-value">（无有效链接）</span>
        )}

        {hasSummary ? (
          <button
            type="button"
            className="btn btn-tiny btn-ghost"
            onClick={() => {
              setViewer({
                kind: 'summary',
                title: '长摘要',
                description: titleText ?? result.url ?? '',
                text: result.summary ?? '',
                truncated: false,
                fullLength: (result.summary ?? '').length,
                baseUrl: result.url,
              });
            }}
            aria-haspopup="dialog"
          >
            <ChevronRightIcon size={14} />
            <span>长摘要</span>
          </button>
        ) : null}

        {hasContent ? (
          <button
            type="button"
            className="btn btn-tiny btn-ghost"
            onClick={() => {
              setViewer({
                kind: 'content',
                title: '正文',
                description: titleText ?? result.url ?? '',
                text: result.content ?? '',
                truncated: false,
                fullLength: (result.content ?? '').length,
                baseUrl: result.url,
              });
            }}
            aria-haspopup="dialog"
          >
            <ChevronRightIcon size={14} />
            <span>正文</span>
          </button>
        ) : null}

        <button
          type="button"
          className="btn btn-tiny btn-ghost"
          onClick={() => {
            const fullJson = stringifySafe(result.raw, 2);
            const { text, truncated } = truncateText(fullJson, RAW_JSON_LIMIT);
            setViewer({
              kind: 'json',
              title: '原始 JSON',
              description: `该条结果的完整原始响应（${fullJson.length.toLocaleString('zh-CN')} 字符）`,
              text,
              truncated,
              fullLength: fullJson.length,
            });
          }}
          aria-haspopup="dialog"
        >
          <ChevronRightIcon size={14} />
          <span>原始 JSON</span>
        </button>
        <span className="result-index" aria-hidden="true">
          #{result.index + 1}
        </span>
      </div>

      <ContentViewer payload={viewer} onClose={closeViewer} notify={notify} />
    </article>
  );
});

/** 标题右侧的复制图标：复用 CopyButton，但以纯图标呈现 */
function CopyIconButton({ url, notify }: { url: string; notify: NotifyFn }): ReactElement {
  return (
    <CopyButton
      text={url}
      label="复制链接"
      notify={notify}
      className="result-title-icon"
      iconOnly
      icon={<CopyIcon size={14} />}
    />
  );
}
