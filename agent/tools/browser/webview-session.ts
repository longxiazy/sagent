import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { EdgeCdpWebView } from './edge-cdp-webview.ts';

let sharedSession = null;
let webViewFactory = defaultWebViewFactory;
let dataStoreDir = null;

function defaultWebViewFactory(options) {
  if (process.platform === 'win32') {
    return new EdgeCdpWebView(options);
  }
  const WebView = globalThis.Bun?.WebView;
  if (!WebView) {
    throw new Error('Bun.WebView 不可用。请使用 Bun 1.3+ 运行 sagent，或升级到包含 Bun.WebView 的 Bun 版本。');
  }
  return new WebView(options);
}

export function initWebViewDataStore(baseDir) {
  dataStoreDir = path.join(baseDir, 'browser-profile');
  mkdirSync(dataStoreDir, { recursive: true });
}

export function setWebViewFactoryForTests(factory) {
  webViewFactory = factory;
  sharedSession = null;
}

export function resetWebViewFactoryForTests() {
  webViewFactory = defaultWebViewFactory;
  sharedSession = null;
}

export function createBrowserSession({ width = 1440, height = 960 } = {}) {
  const opts: any = { width, height };
  if (dataStoreDir) {
    opts.dataStore = { directory: dataStoreDir };
  }
  const view = webViewFactory(opts);
  return {
    view,
    page: view,
  };
}

export function getSharedWebViewSession(options = {}) {
  if (!sharedSession) {
    sharedSession = createBrowserSession(options);
  }
  return sharedSession;
}

export function getWebView(options = {}) {
  return getSharedWebViewSession(options).view;
}

export async function closeBrowserSession(session = sharedSession) {
  const view = session?.view || session?.page || session;
  if (view && typeof view.close === 'function') {
    try {
      const result = view.close();
      if (result && typeof result.catch === 'function') await result;
    } catch {}
  }
  if (session === sharedSession || session?.view === sharedSession?.view) {
    sharedSession = null;
  }
}

export async function closeWebView() {
  await closeBrowserSession(sharedSession);
}
