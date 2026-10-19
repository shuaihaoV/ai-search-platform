/**
 * Markdown 渲染：react-markdown + remark-gfm。
 *
 * 安全要点：
 * - skipHtml：绝不渲染内联 HTML；
 * - 不引入 rehype-raw；
 * - urlTransform 只放行 http/https（同文档锚点单独放行）；
 * - a 强制 rel="noopener noreferrer nofollow" target="_blank"；
 * - img 带 referrerPolicy="no-referrer" loading="lazy"；
 * - 长度上限与截断在解析前完成，避免超长内容拖垮主线程。
 *
 * 性能：组件定义与渲染结果均做 memo（Markdown 解析成本高，
 * 父组件因 Toast/输入等无关状态重渲染时不应重复解析）。
 */

import { memo, useMemo } from 'react';
import type { AnchorHTMLAttributes, ImgHTMLAttributes, ReactElement, ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  MARKDOWN_RENDER_LIMIT,
  createUrlTransform,
  safeImageSrc,
  truncateText,
  unescapeUpstreamMarkdown,
} from '../lib/markdown';

interface MarkdownViewProps {
  markdown: string;
  /** 原页 URL，用于解析相对链接 */
  baseUrl?: string | null;
  /** 渲染上限，默认 300000 */
  limit?: number;
}

/** 生成稳定的插件数组（模块级常量，避免每次渲染重建） */
const REMARK_PLUGINS = [remarkGfm];

/**
 * 链接渲染：
 * - 外部 http/https：新标签页 + 强制安全 rel；
 * - 同文档锚点（GFM 脚注等）：保留页内跳转，不设 target；
 * - urlTransform 已把不安全链接置空，这里降级为纯文本。
 */
function MarkdownLink({
  href,
  children,
  title,
}: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }): ReactElement {
  if (typeof href !== 'string' || href === '') {
    return <span className="markdown-link-blocked">{children}</span>;
  }
  if (href.startsWith('#')) {
    return (
      <a href={href} title={title}>
        {children}
      </a>
    );
  }
  return (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

/** 图片渲染：非 http(s) 协议一律降级为文本占位（含 data:/javascript:） */
function MarkdownImage({ src, alt, title }: ImgHTMLAttributes<HTMLImageElement>): ReactElement {
  const safeSrc = safeImageSrc(src);
  if (safeSrc === null) {
    return <span className="markdown-image-blocked">[图片已阻止：{alt ?? '无描述'}]</span>;
  }
  return (
    <img
      className="markdown-image"
      src={safeSrc}
      alt={alt ?? ''}
      title={title}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}

const MARKDOWN_COMPONENTS = {
  a: MarkdownLink,
  img: MarkdownImage,
};

export const MarkdownView = memo(function MarkdownView({
  markdown,
  baseUrl = null,
  limit = MARKDOWN_RENDER_LIMIT,
}: MarkdownViewProps): ReactElement {
  // 截断与反斜杠还原都是 O(n)，只应在输入变化时计算
  const { text, truncated, originalLength } = useMemo(
    () => truncateText(markdown, limit),
    [markdown, limit],
  );
  // 上游 Fetch 接口会把 Markdown 标点转义成 \#、\- 等，需先还原才能正确渲染
  const normalized = useMemo(() => unescapeUpstreamMarkdown(text), [text]);
  const urlTransform = useMemo(() => createUrlTransform(baseUrl), [baseUrl]);

  // 解析结果只依赖 Markdown 文本与 baseUrl，与父组件其它状态无关
  const content = useMemo(
    () => (
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        skipHtml
        urlTransform={urlTransform}
        components={MARKDOWN_COMPONENTS}
      >
        {normalized}
      </Markdown>
    ),
    [normalized, urlTransform],
  );

  return (
    <div className="markdown-view">
      {truncated ? (
        <p className="markdown-notice" role="note">
          内容较长，已截断展示前 {limit.toLocaleString('zh-CN')} 字符（原文共{' '}
          {originalLength.toLocaleString('zh-CN')} 字符）。复制 Markdown 可获取完整内容。
        </p>
      ) : null}
      <div className="markdown-body">{content}</div>
    </div>
  );
});
