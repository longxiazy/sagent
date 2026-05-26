/**
 * Search Tool — 通过 DuckDuckGo lite HTML 端点做无 key 搜索
 *
 * 不走浏览器（避免反爬验证页），直接 HTTP GET 拉取 https://lite.duckduckgo.com/lite/
 * 解析其中 .result-link / .result-snippet 节点，
 * 返回 title + url + snippet 的纯文本列表给 LLM。
 *
 * 不需要 API key、无明显限流。失败时返回错误说明，由上层 router 转换为 observation。
 */

const ENDPOINT = 'https://lite.duckduckgo.com/lite/';
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : '';
    });
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// DuckDuckGo 把真实链接包装成 //duckduckgo.com/l/?uddg=ENCODED&rut=...，需要解包。
function unwrapDdgRedirect(href) {
  if (!href) return '';
  let url = href;
  if (url.startsWith('//')) url = 'https:' + url;
  try {
    const parsed = new URL(url, ENDPOINT);
    if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname) && parsed.pathname === '/l/') {
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

// lite 端点的每条结果由三行 <tr> 组成：标题链接、snippet、显示用 URL。
// 解析方式：先按 class='result-link' 找标题 <a>，然后向后查同结果块内的 result-snippet。
function parseResults(html, maxResults) {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // 属性顺序不可控（href 可能在 class 前后），用 [^>]* 兜底；分别用 href / class 两条信息回锁。
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  const hrefRe = /href=['"]([^'"]+)['"]/i;
  const classRe = /class=['"]([^'"]*)['"]/i;
  const snippetRe = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;

  const links: Array<{ url: string; title: string; index: number }> = [];
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1];
    const cls = classRe.exec(attrs)?.[1] || '';
    if (!/\bresult-link\b/.test(cls)) continue;
    const href = hrefRe.exec(attrs)?.[1] || '';
    if (!href) continue;
    links.push({ url: unwrapDdgRedirect(href), title: stripTags(m[2]), index: m.index });
  }
  const snippets: Array<{ text: string; index: number }> = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push({ text: stripTags(m[1]), index: m.index });
  }

  // 对每个 link，找紧随其后的第一个 snippet（同一结果块）。
  for (const link of links) {
    if (results.length >= maxResults) break;
    if (!link.url || !link.title) continue;
    const followingSnippet = snippets.find(s => s.index > link.index);
    const nextLink = links.find(l => l.index > link.index);
    let snippet = '';
    if (followingSnippet && (!nextLink || followingSnippet.index < nextLink.index)) {
      snippet = followingSnippet.text;
    }
    results.push({ title: link.title, url: link.url, snippet });
  }
  return results;
}

function formatResults(query, results) {
  if (results.length === 0) {
    return `web_search 未找到 "${query}" 的结果。可能是查询过于冷门或 DuckDuckGo 临时无返回，可换关键词或改用 http_fetch 直接抓目标站点。`;
  }
  const lines = results.map((item, index) => {
    const head = `${index + 1}. ${item.title}`;
    const url = `   URL: ${item.url}`;
    const snip = item.snippet ? `   摘要: ${item.snippet}` : '';
    return [head, url, snip].filter(Boolean).join('\n');
  });
  return `web_search 结果（query="${query}", count=${results.length}）:\n${lines.join('\n\n')}`;
}

async function fetchHtml(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = ENDPOINT + '?' + new URLSearchParams({ q: query, kl: 'wt-wt' }).toString();
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,zh;q=0.8',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function executeSearchAction(action) {
  const query = typeof action?.query === 'string' ? action.query.trim() : '';
  if (!query) {
    return 'web_search 失败：query 为空';
  }
  const maxResults = Number.isFinite(Number(action?.maxResults))
    ? Math.min(Math.max(Number(action.maxResults), 1), 10)
    : 5;

  try {
    const html = await fetchHtml(query);
    if (html.includes('anomaly-modal') || html.includes('challenge-form')) {
      return 'web_search 失败：DuckDuckGo 触发反爬验证。请稍后重试或改用 http_fetch 直接抓取目标站点。';
    }
    const results = parseResults(html, maxResults);
    return formatResults(query, results);
  } catch (err: any) {
    const msg = err?.message || String(err);
    return `web_search 失败：${msg}。建议改用 http_fetch 直接抓取目标站点，或检查网络。`;
  }
}
