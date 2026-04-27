import fs from 'node:fs';

export function resolveBrowserPath(candidatePaths) {
  const executablePath = candidatePaths.find(item => item && fs.existsSync(item));
  if (!executablePath) {
    throw new Error(
      '未找到可用浏览器。请安装 Chrome/Chromium，或设置 AGENT_BROWSER_PATH 指向浏览器可执行文件。'
    );
  }
  return executablePath;
}

export async function createBrowserSession({
  chromium,
  candidatePaths,
  headless,
}) {
  const executablePath = resolveBrowserPath(candidatePaths);
  const browser = await chromium.launch({
    executablePath,
    headless,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 3, // 3x for Claude Opus 4.7 visual reasoning level
  });

  // Block heavy resources for speed
  await context.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
  };
}

export async function closeBrowserSession(session) {
  await session?.context?.close().catch(() => {});
  await session?.browser?.close().catch(() => {});
}
