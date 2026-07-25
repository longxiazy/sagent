/**
 * Built-in browser session/profile adapter.
 *
 * On Bun.WebView platforms normal runs use the configured persistent browser-profile;
 * private runs get a random temporary dataStore that close() removes on a best-effort basis. On Windows the
 * Edge CDP adapter owns a temporary process profile for every managed session, while
 * privateMode also passes Edge's --inprivate flag. Browser preview screenshots are
 * persisted only for non-private runs.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EdgeCdpWebView } from './edge-cdp-webview.ts';
import { isPrivateRun } from '../../../helpers/private-run.ts';

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
  // privateMode 是 sagent 的内部标记，Bun.WebView 不需要也不认识它。
  const { privateMode: _privateMode, ...webViewOptions } = options;
  return new WebView(webViewOptions);
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

export async function captureBrowserPreview(
  view,
  { runId, privateMode = false }: { runId?: string; privateMode?: boolean } = {},
) {
  // 隐私模式不调用 WebView 截图接口，也不创建截图目录/文件。
  if (privateMode === true || isPrivateRun()) return null;
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

function isSafePrivateProfileDir(profileDir) {
  if (!profileDir) return false;
  const tempRoot = path.resolve(os.tmpdir());
  const resolvedProfile = path.resolve(profileDir);
  return path.dirname(resolvedProfile) === tempRoot
    && path.basename(resolvedProfile).startsWith('sagent-private-browser-');
}

async function removePrivateProfileDir(profileDir) {
  if (!isSafePrivateProfileDir(profileDir)) return;
  await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}

export function createBrowserSession({ width = 1440, height = 960, privateMode = false } = {}) {
  const normalizedPrivateMode = privateMode === true;
  const opts: any = { width, height };
  let privateProfileDir = null;
  if (normalizedPrivateMode) {
    // Bun.WebView 的 dataStore 目录决定了 cookie/localStorage 等持久化边界；
    // 随机临时目录 + 任务结束删除，确保隐私 run 不会污染全局 browser-profile。
    privateProfileDir = mkdtempSync(path.join(os.tmpdir(), 'sagent-private-browser-'));
    opts.privateMode = true;
    opts.dataStore = { directory: privateProfileDir };
  } else if (dataStoreDir) {
    opts.dataStore = { directory: dataStoreDir };
  }
  try {
    const view = webViewFactory(opts);
    const session: any = {
      view,
      page: view,
    };
    if (normalizedPrivateMode) {
      session.privateMode = true;
      session.privateProfileDir = privateProfileDir;
    }
    return session;
  } catch (error) {
    // WebView 构造失败时也不能遗留一次性 profile。
    if (privateProfileDir && isSafePrivateProfileDir(privateProfileDir)) {
      try { rmSync(privateProfileDir, { recursive: true, force: true }); } catch {}
    }
    throw error;
  }
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
  const privateProfileDir = session?.privateProfileDir;
  if (view && typeof view.close === 'function') {
    try {
      const result = view.close();
      if (result && typeof result.catch === 'function') await result;
    } catch {}
  }
  await removePrivateProfileDir(privateProfileDir);
  if (session === sharedSession || session?.view === sharedSession?.view) {
    sharedSession = null;
  }
}

export async function closeWebView() {
  await closeBrowserSession(sharedSession);
}
