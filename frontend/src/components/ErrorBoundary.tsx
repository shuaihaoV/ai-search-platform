/**
 * 错误边界：捕获渲染期异常，避免整页白屏。
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message = error instanceof Error ? error.message : '未知渲染错误';
    return { hasError: true, message };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 仅本地 console 记录，不向任何第三方上报
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private readonly handleReload = (): void => {
    this.setState({ hasError: false, message: '' });
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-boundary" role="alert">
          <h1 className="error-boundary-title">页面出现异常</h1>
          <p className="error-boundary-desc">
            渲染过程中发生错误，已阻止整页崩溃。可以尝试重新加载页面。
          </p>
          <p className="error-boundary-detail">
            <code>{this.state.message}</code>
          </p>
          <button type="button" className="btn btn-primary" onClick={this.handleReload}>
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
