import { mkdirSync } from 'node:fs';
import { chmod, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EdgeCdpWebView } from './edge-cdp-webview.ts';

let sharedSession = null;
let webViewFactory = defaultWebViewFactory;
let dataStoreDir = null;
let screenshotDir = path.resolve(process.env.MEMORY_DIR || 'data', 'screenshots');

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
  screenshotDir = path.join(baseDir, 'screenshots');
  mkdirSync(dataStoreDir, { recursive: true });
  mkdirSync(screenshotDir, { recursive: true });
}

function safeRunId(runId) {
  return String(runId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'default';
}

async function removeOldBrowserPreviews(dirPath, keepFile) {
  const files = await readdir(dirPath).catch(() => []);
  const previews = files
    .filter(file => /^browser-preview-\d+\.jpg$/.test(file) && file !== keepFile)
    .sort()
    .reverse();
  await Promise.all(previews.slice(2).map(file => unlink(path.join(dirPath, file)).catch(() => {})));
}

export async function captureBrowserPreview(view, { runId }: { runId?: string } = {}) {
  if (!view || typeof view.screenshot !== 'function') return null;

  const page = await Promise.resolve(view.evaluate(`({
    title: document.title || '',
    url: window.location.href || ''
  })`)).catch(() => ({ title: view.title || '', url: view.url || '' }));
  if (!page?.url || /^about:(?:blank|srcdoc)$/i.test(page.url)) return null;

  const screenshot = await Promise.resolve(view.screenshot({
    format: 'jpeg',
    quality: 72,
    encoding: 'buffer',
  })).catch(() => null);
  if (!screenshot) return null;

  let bytes = null;
  if (screenshot instanceof Uint8Array) {
    bytes = screenshot;
  } else if (screenshot instanceof ArrayBuffer) {
    bytes = new Uint8Array(screenshot);
  } else if (typeof screenshot.arrayBuffer === 'function') {
    bytes = new Uint8Array(await screenshot.arrayBuffer());
  } else if (typeof screenshot === 'string') {
    bytes = Buffer.from(screenshot, 'base64');
  }
  if (!bytes?.byteLength) return null;

  const runDirectory = safeRunId(runId);
  const dirPath = path.join(screenshotDir, runDirectory);
  await mkdir(dirPath, { recursive: true });
  const fileName = `browser-preview-${Date.now()}.jpg`;
  const filePath = path.join(dirPath, fileName);
  await writeFile(filePath, bytes);
  await chmod(filePath, 0o600).catch(() => {});
  await removeOldBrowserPreviews(dirPath, fileName);

  return {
    title: page.title || '',
    url: page.url,
    screenshotUrl: `/screenshots/${runDirectory}/${fileName}`,
  };
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
