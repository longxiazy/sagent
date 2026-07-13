/** Read-only runtime suggestion store. Content lives in ignored data/suggestions.json. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  emptySuggestionDefaults,
  parseSuggestionDefaults,
  type SuggestionCategory,
  type SuggestionLocale,
} from './suggestion-defaults.ts';

export type Suggestions = {
  agent: SuggestionCategory[];
};

export type SuggestionStore = ReturnType<typeof createSuggestionStore>;

export function createSuggestionStore(dir: string) {
  const filePath = path.join(dir, 'suggestions.json');

  return {
    async get(locale: SuggestionLocale = 'zh'): Promise<Suggestions> {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const data = JSON.parse(raw);
        return parseSuggestionDefaults(data.defaults?.[locale], locale);
      } catch {
        return emptySuggestionDefaults(locale);
      }
    },
  };
}
