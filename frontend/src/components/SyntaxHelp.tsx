/**
 * 搜索语法（模态框内容）：8 个操作符的说明 + 示例 + 插入按钮。
 * 由 App 通过 <Modal> 包裹，自身不再有展开/收起。
 * 移动端由表格切换为卡片堆叠（纯 CSS 控制，无内联样式）。
 */

import type { ReactElement } from 'react';
import type { NotifyFn } from '../types';

interface SyntaxEntry {
  operator: string;
  name: string;
  description: string;
  example: string;
}

/** 需求规定的 8 个操作符（顺序固定） */
export const SYNTAX_ENTRIES: readonly SyntaxEntry[] = [
  {
    operator: 'site:',
    name: '限定站点',
    description: '只检索指定域名下的内容。',
    example: 'site:example.com 产品文档',
  },
  {
    operator: '-site:',
    name: '排除站点',
    description: '排除指定域名，减少噪音。',
    example: 'AI 搜索 -site:zhihu.com',
  },
  {
    operator: '-词',
    name: '排除词',
    description: '排除包含指定词语的结果。',
    example: '机器学习 -广告',
  },
  {
    operator: '-"短语"',
    name: '排除短语',
    description: '排除完整短语匹配的结果（短语加英文双引号）。',
    example: '部署方案 -"限时优惠"',
  },
  {
    operator: '"精确短语"',
    name: '精确短语',
    description: '要求结果完整包含该短语，顺序一致。',
    example: '"向量数据库 选型"',
  },
  {
    operator: 'lang:',
    name: '限定语言',
    description: '限定结果语言，取值为语言代码，如 zh、en。',
    example: 'lang:zh 大模型 应用',
  },
  {
    operator: 'after:',
    name: '起始日期',
    description: '只保留该日期之后发布的内容，格式 YYYY-MM-DD。',
    example: 'after:2025-01-01 前端框架',
  },
  {
    operator: 'before:',
    name: '截止日期',
    description: '只保留该日期之前发布的内容，格式 YYYY-MM-DD。',
    example: 'before:2026-01-01 人工智能',
  },
];

interface SyntaxHelpProps {
  onInsert: (example: string) => void;
  notify: NotifyFn;
}

/** 把示例插入当前关键词（追加，避免破坏已输入内容） */
export function appendSyntaxExample(currentQuery: string, example: string): string {
  const trimmed = currentQuery.trim();
  if (trimmed === '') {
    return example;
  }
  return `${trimmed} ${example}`;
}

export function SyntaxHelp({ onInsert, notify }: SyntaxHelpProps): ReactElement {
  return (
    <div className="syntax-body">
      <table className="syntax-table">
        <thead>
          <tr>
            <th scope="col">操作符</th>
            <th scope="col">说明</th>
            <th scope="col">示例</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {SYNTAX_ENTRIES.map((entry) => (
            <tr key={entry.operator} className="syntax-row">
              <td className="syntax-op" data-label="操作符">
                <code>{entry.operator}</code>
                <span className="syntax-name">{entry.name}</span>
              </td>
              <td className="syntax-desc" data-label="说明">
                {entry.description}
              </td>
              <td className="syntax-example" data-label="示例">
                <code>{entry.example}</code>
              </td>
              <td className="syntax-action" data-label="操作">
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => {
                    onInsert(entry.example);
                    notify(`已插入：${entry.operator}`, 'success');
                  }}
                >
                  插入示例
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
