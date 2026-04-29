import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../../../helpers/logger.js';

const execFileAsync = promisify(execFile);

const MAX_CONTENT_LENGTH = 24000;
const BROWSER_TIMEOUT_MS = 15000;
const CURL_TIMEOUT_MS = 10000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function extractMainContent(text) {
  return text.replace(/\s+/g, ' ').trim();
}

async function fetchWithBrowser(page, action) {
  const url = action.url;
  const timeout = action.timeoutMs || BROWSER_TIMEOUT_MS;

  // Use a separate page to avoid destroying the agent's main page context
  const context = page.context();
  const fetchPage = await context.newPage();

  try {
    await fetchPage.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await fetchPage.waitForTimeout(1000);

    if (action.extractLinks) {
      const { content, links } = await fetchPage.evaluate(() => {
        const bodyText = document.body.innerText || '';
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const extracted = [];
        for (const a of anchors) {
          const href = a.href;
          const label = a.textContent.trim();
          if (href && href.startsWith('http') && label.length > 3 && label.length < 120) {
            extracted.push({ url: href, title: label });
          }
        }
        return { content: bodyText, links: extracted };
      });

      let result = `搜索结果 ${url}:\n\n链接列表:\n`;
      for (const link of links.slice(0, 10)) {
        result += `- [${link.title}](${link.url})\n`;
      }
      result += `\n页面摘要: ${extractMainContent(content).slice(0, 2000)}`;
      return result.slice(0, MAX_CONTENT_LENGTH);
    }

    const text = await fetchPage.evaluate(() => document.body.innerText || '');
    const cleaned = extractMainContent(text);
    const truncated = cleaned.length > MAX_CONTENT_LENGTH
      ? cleaned.slice(0, MAX_CONTENT_LENGTH) + '\n...(内容已截断)'
      : cleaned;

    return `http_fetch ${url} 内容:\n${truncated}`;
  } finally {
    await fetchPage.close().catch(() => {});
  }
}

async function fetchWithCurl(action) {
  const url = action.url;
  const timeout = action.timeoutMs || CURL_TIMEOUT_MS;

  const { stdout } = await execFileAsync('curl', [
    '-sL',
    '--max-time', String(Math.round(timeout / 1000)),
    '-H', `User-Agent: ${USER_AGENT}`,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
    '-H', 'Accept-Encoding: gzip, deflate, br',
    '--compressed',
    '-H', 'Cache-Control: no-cache',
    '-H', 'Sec-Fetch-Dest: document',
    '-H', 'Sec-Fetch-Mode: navigate',
    '-H', 'Sec-Fetch-Site: none',
    '-b', 'CONSENT=YES+cb.20210328-17-p0.en+FX+999',
    url,
  ], { maxBuffer: 1024 * 1024, timeout: timeout + 2000 });

  if (!stdout || stdout.length < 50) {
    return null;
  }

  let text = stdout;
  text = text.replace(/<(script|style|nav|footer|header|aside|noscript)[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length < 50) return null;

  if (action.extractLinks) {
    const links = [];
    const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = re.exec(stdout)) !== null && links.length < 10) {
      const href = match[1];
      const label = match[2].replace(/<[^>]+>/g, '').trim();
      if (href.startsWith('http') && label.length > 3 && label.length < 120) {
        links.push({ url: href, title: label });
      }
    }
    let result = `搜索结果 ${url}:\n\n链接列表:\n`;
    for (const link of links) {
      result += `- [${link.title}](${link.url})\n`;
    }
    result += `\n页面摘要: ${text.slice(0, 2000)}`;
    return result.slice(0, MAX_CONTENT_LENGTH);
  }

  const truncated = text.length > MAX_CONTENT_LENGTH
    ? text.slice(0, MAX_CONTENT_LENGTH) + '\n...(内容已截断)'
    : text;
  return `http_fetch ${url} 内容:\n${truncated}`;
}

async function executeSingleFetch(action, page, domainRules) {
  if (!action.url) {
    throw new Error('http_fetch 缺少 url');
  }

  const useBrowser = domainRules ? await domainRules.needsBrowser(action.url) : false;

  if (useBrowser && page) {
    try {
      return await fetchWithBrowser(page, action);
    } catch (err) {
      log.warn(`[Fetch] 浏览器也失败: ${(err.message || '').slice(0, 80)}`);
      return `http_fetch ${action.url}: 浏览器访问失败 (${(err.message || '').slice(0, 100)})。`;
    }
  }

  try {
    const result = await fetchWithCurl(action);
    if (result && domainRules) {
      const isBot = await domainRules.detectBotResponse(result);
      if (isBot) {
        log.info(`[Fetch] 检测到反爬机制: ${action.url}`);
        await domainRules.markBrowserDomain(action.url);
        if (page) {
          try {
            return await fetchWithBrowser(page, action);
          } catch {
            /* fall through to curl result */
          }
        }
      }
    }
    if (result) return result;
    return `http_fetch ${action.url}: 返回内容为空或过短。`;
  } catch (err) {
    if (!page) {
      if (err.killed || /timed?out/i.test(err.message)) {
        return `http_fetch ${action.url}: 请求超时。`;
      }
      return `http_fetch ${action.url}: 请求失败 (${err.message.slice(0, 100)})。`;
    }

    try {
      return await fetchWithBrowser(page, action);
    } catch {
      return `http_fetch ${action.url}: 请求失败 (${err.message.slice(0, 100)})。`;
    }
  }
}

export async function executeFetchAction(action, page, domainRules) {
  // Parallel fetch: multiple URLs concurrently
  if (action.type === 'parallel_fetch' && Array.isArray(action.urls)) {
    const results = await Promise.all(
      action.urls.map(url =>
        executeSingleFetch({ ...action, type: 'http_fetch', url }, page, domainRules)
          .catch(err => `http_fetch ${url}: 失败 (${err.message.slice(0, 80)})`)
      )
    );
    return results.join('\n\n---\n\n');
  }

  return executeSingleFetch(action, page, domainRules);
}
