/**
 * 入口：尽早应用主题，避免首屏闪白，然后挂载 React。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { applyTheme, loadTheme } from './lib/theme';
import './styles.css';

// 尽早写入 data-theme / theme-color：脚本在 body 末尾，样式已在 head 中阻塞加载，
// 因此此处执行时页面尚未绘制，可避免闪白。
try {
  applyTheme(loadTheme());
} catch {
  // 主题初始化失败时保持默认（auto）
}

const container = document.getElementById('root');

if (container === null) {
  throw new Error('未找到 #root 挂载节点');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
