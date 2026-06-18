import { Component } from 'react';
import { tStatic } from '../i18n/locale.js';

// Top-level render guard. App.jsx 承担了整页绝大部分 UI 和状态管理，
// 一旦某个子组件因为异常崩掉，ErrorBoundary 至少还能保住基本交互，
// 避免用户只能看到整页白屏。
export class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: 'var(--c-danger)', fontSize: 14 }}>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>{tStatic('errorBoundary.title')}</p>
          <p style={{ color: 'var(--c-text-muted)', marginBottom: 12 }}>{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: '4px 12px', border: '1px solid var(--c-border-input)', borderRadius: 4, background: 'var(--c-surface)', color: 'var(--c-text)', cursor: 'pointer' }}
          >{tStatic('errorBoundary.retry')}</button>
        </div>
      );
    }
    return this.props.children;
  }
}
