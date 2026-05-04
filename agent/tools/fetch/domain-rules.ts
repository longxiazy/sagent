import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../../../helpers/logger.ts';

// Default domains that need real browser
const DEFAULT_BROWSER_DOMAINS = [
  'google.com',
  'google.com.hk',
  'google.co.jp',
  'baidu.com',
  'zhihu.com',
  'weibo.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'reddit.com',
  'douyin.com',
  'bilibili.com',
  'taobao.com',
  'jd.com',
  'amazon.com',
  'amazon.cn',
  'claudc.ai',
  'cloudflare.com',
  'recaptcha.net',
];

const BOT_SIGNALS = [
  /captcha/i,
  /robot\s*(check|verify|test)/i,
  /human\s*(verification|check|confirm)/i,
  /access\s*denied/i,
  /blocked/i,
  /rate\s*limit/i,
  /429/,
  /your\s*request\s*has\s*been/i,
  /unusual\s*traffic/i,
  /automated\s*request/i,
  /请.*验证|验证码|人机验证|滑动验证/,
  /访问.*拒绝|拒绝访问|access denied/i,
  /频繁.*访问|请求过多/i,
];

function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    // e.g. www.google.com → google.com, mail.google.com → google.com
    const parts = hostname.split('.');
    if (parts.length > 2) {
      return parts.slice(-2).join('.');
    }
    return hostname;
  } catch {
    return null;
  }
}

function matchDomain(domain, rules) {
  return rules.some(rule => {
    if (rule.startsWith('*.')) {
      return domain.endsWith(rule.slice(1)) || domain === rule.slice(2);
    }
    return domain === rule || domain.endsWith('.' + rule);
  });
}

export function createDomainRules(dir) {
  const filePath = path.join(dir, 'fetch-domain-rules.json');
  let cache = null;
  let _dirty = false;
  let saveTimer = null;

  async function load() {
    if (cache) return cache;
    try {
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      cache = {
        browserDomains: Array.isArray(data.browserDomains) ? data.browserDomains : [...DEFAULT_BROWSER_DOMAINS],
      };
    } catch {
      cache = {
        browserDomains: [...DEFAULT_BROWSER_DOMAINS],
      };
    }
    return cache;
  }

  async function save() {
    if (!cache) return;
    const tmp = filePath + '.tmp';
    await writeFile(tmp, JSON.stringify(cache, null, 2));
    await rename(tmp, filePath);
    _dirty = false;
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      save().catch(err => log.error('[DomainRules] 保存失败:', err.message));
    }, 2000);
  }

  return {
    async needsBrowser(url) {
      const domain = extractDomain(url);
      if (!domain) return false;
      const data = await load();
      return matchDomain(domain, data.browserDomains);
    },

    async markBrowserDomain(url) {
      const domain = extractDomain(url);
      if (!domain) return;
      const data = await load();
      if (!matchDomain(domain, data.browserDomains)) {
        data.browserDomains.push(domain);
        log.info(`[DomainRules] 标记需要浏览器访问: ${domain}`);
        scheduleSave();
      }
    },

    async detectBotResponse(content) {
      if (!content || typeof content !== 'string') return false;
      const detected = BOT_SIGNALS.some(re => re.test(content));
      return detected;
    },

    async getRules() {
      const data = await load();
      return data.browserDomains;
    },

    async addDomain(domain) {
      const data = await load();
      const normalized = domain.replace(/^\*\./, '').replace(/^www\./, '');
      if (!matchDomain(normalized, data.browserDomains)) {
        data.browserDomains.push(normalized);
        scheduleSave();
      }
    },

    async removeDomain(domain) {
      const data = await load();
      data.browserDomains = data.browserDomains.filter(d => d !== domain);
      scheduleSave();
    },

    async resetToDefaults() {
      cache = { browserDomains: [...DEFAULT_BROWSER_DOMAINS] };
      scheduleSave();
    },
  };
}
