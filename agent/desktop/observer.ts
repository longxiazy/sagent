import { captureBrowserObservation, summarizeBrowserObservation } from '../tools/browser/observe.ts';
import { observeMacOSDesktop } from '../tools/macos/observe.ts';

export async function observeDesktopAgent(state: {
  observeDesktop: boolean;
  runId: string;
  browserSession: any;
  projectRoot?: string | null;
  cancelSignal?: AbortSignal;
}) {
  const [desktop, browserRaw] = await Promise.all([
    state.observeDesktop
      ? observeMacOSDesktop({ runId: state.runId, signal: state.cancelSignal })
      : Promise.resolve({ frontmostApp: '', frontmostWindowTitle: '', windows: [] }),
    state.browserSession
      ? captureBrowserObservation(state.browserSession.view)
      : Promise.resolve(null),
  ]);

  const browser = browserRaw ? summarizeBrowserObservation(browserRaw) : null;
  // 命中项目时工作目录为项目根；否则回退 process.cwd()（无项目态）。
  const cwd = state.projectRoot || process.cwd();

  return {
    desktop,
    browser,
    filesystem: {
      cwd,
      note: '当前工作目录;仅当任务确需读写文件时才使用 fs 工具',
    },
    terminal: {
      cwd,
      note: 'run_safe 仅允许运行只读命令',
    },
    title: browser?.title || desktop.frontmostWindowTitle || desktop.frontmostApp || 'Desktop',
    url: browser?.url || '',
    text: [desktop.frontmostApp, desktop.frontmostWindowTitle].filter(Boolean).join(' · '),
    elements: browser?.elements || [],
  };
}
