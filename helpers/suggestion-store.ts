/**
 * Suggestion Store — 主页建议的使用记录持久化
 *
 * 镜像 agent/tools/fetch/domain-rules.ts 的存储模式:
 *   - in-memory cache + lazy load
 *   - 2s 防抖保存
 *   - .tmp + rename 原子写
 *
 * 持久化文件 data/suggestions.json 只存"使用记录",默认建议数据来自 suggestion-defaults.ts。
 * 用户每发送一条指令(无论从卡片点击还是手动输入)都会调 recordUse() 累计 uses 计数。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger.ts';
import {
  getSuggestionDefaults,
  type SuggestionCategory,
  type SuggestionLocale,
} from './suggestion-defaults.ts';
import { t } from './i18n.ts';

const RECENT_LIMIT = 12;
const SAVE_DEBOUNCE_MS = 2000;

type HistoryEntry = {
  title: string;
  text: string;
  uses: number;
  lastUsedAt: string;
};

type HistoryFile = {
  version: number;
  updatedAt: string;
  history: HistoryEntry[];
};

export type MergedSuggestions = {
  agent: SuggestionCategory[];
};

export type SuggestionStore = ReturnType<typeof createSuggestionStore>;

function emptyHistory(): HistoryFile {
  return { version: 1, updatedAt: new Date().toISOString(), history: [] };
}

export function createSuggestionStore(dir: string) {
  const filePath = path.join(dir, 'suggestions.json');
  let cache: HistoryFile | null = null;
  let saveTimer: NodeJS.Timeout | null = null;

  async function load(): Promise<HistoryFile> {
    if (cache) return cache;
    try {
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      cache = {
        version: typeof data.version === 'number' ? data.version : 1,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
        history: Array.isArray(data.history)
          ? data.history
              .filter((e: any) => e && typeof e.text === 'string')
              .map((e: any) => ({
                title: String(e.title ?? '').slice(0, 32),
                text: String(e.text),
                uses: Number.isFinite(e.uses) ? Math.max(0, Math.floor(e.uses)) : 0,
                lastUsedAt: typeof e.lastUsedAt === 'string' ? e.lastUsedAt : '',
              }))
          : [],
      };
    } catch {
      cache = emptyHistory();
    }
    return cache;
  }

  async function save(): Promise<void> {
    if (!cache) return;
    const tmp = filePath + '.tmp';
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(cache, null, 2));
    await rename(tmp, filePath);
  }

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      save().catch(err => log.error('[SuggestionStore] 保存失败:', err.message));
    }, SAVE_DEBOUNCE_MS);
  }

  function buildRecent(history: HistoryEntry[], locale: SuggestionLocale): SuggestionCategory | null {
    const recent = history
      .filter(e => e.uses > 0)
      // "最近使用"按最近请求时间倒序;lastUsedAt 为 ISO 串可直接字典序比较
      .sort((a, b) => (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''))
      .slice(0, RECENT_LIMIT)
      .map(e => ({ title: e.title || e.text.slice(0, 12), text: e.text }));
    if (recent.length === 0) return null;
    return { id: 'recent', label: t(locale, 'suggestions.recent'), items: recent };
  }

  return {
    async getMerged(locale: SuggestionLocale = 'zh'): Promise<MergedSuggestions> {
      const data = await load();
      const defaults = getSuggestionDefaults(locale);
      const recent = buildRecent(data.history, locale);
      const agent = recent ? [recent, ...defaults.agent] : [...defaults.agent];
      return {
        agent,
      };
    },

    async recordUse({ title, text }: { title: string; text: string }): Promise<void> {
      const trimmed = text.trim();
      if (!trimmed) return;
      const data = await load();
      const existing = data.history.find(e => e.text === trimmed);
      const now = new Date().toISOString();
      if (existing) {
        existing.uses += 1;
        existing.lastUsedAt = now;
        if (title && !existing.title) existing.title = title;
      } else {
        data.history.push({
          title: title || trimmed.slice(0, 12),
          text: trimmed,
          uses: 1,
          lastUsedAt: now,
        });
      }
      data.updatedAt = now;
      scheduleSave();
    },
  };
}
