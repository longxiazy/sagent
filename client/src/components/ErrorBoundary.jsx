import { Component } from 'react';

// Top-level render guard. App.jsx 承担了整页绝大部分 UI 和状态管理，
// 一旦某个子组件因为异常崩掉，ErrorBoundary 至少还能保住基本交互，
// 避免用户只能看到整页白屏。
export class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#991b1b', fontSize: 14 }}>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>页面渲染出错</p>
          <p style={{ color: '#6b7280', marginBottom: 12 }}>{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 4, background: '#fff', cursor: 'pointer' }}
          >重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}
