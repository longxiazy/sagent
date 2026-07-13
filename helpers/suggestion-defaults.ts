/** Suggestion data types and runtime validation. Content lives in data/suggestions.json. */

export type SuggestionItem = {
  title: string;
  text: string;
};

export type SuggestionCategory = {
  id: string;
  label: string;
  items: SuggestionItem[];
};

export type SuggestionDefaults = {
  agent: SuggestionCategory[];
};

export type SuggestionLocale = 'zh' | 'en';

const CATEGORY_LABELS: Record<SuggestionLocale, Array<[string, string]>> = {
  zh: [
    ['life', '生活查询'],
    ['work', '工作办公'],
    ['dev', '开发辅助'],
    ['sys', '系统操作'],
  ],
  en: [
    ['life', 'Daily life'],
    ['work', 'Work & office'],
    ['dev', 'Dev helpers'],
    ['sys', 'System'],
  ],
};

export function emptySuggestionDefaults(locale: SuggestionLocale): SuggestionDefaults {
  return {
    agent: CATEGORY_LABELS[locale].map(([id, label]) => ({ id, label, items: [] })),
  };
}

export function parseSuggestionDefaults(value: unknown, locale: SuggestionLocale): SuggestionDefaults {
  if (!value || typeof value !== 'object' || !Array.isArray((value as any).agent)) {
    return emptySuggestionDefaults(locale);
  }

  const categories = (value as any).agent
    .filter((category: any) => category && typeof category.id === 'string' && Array.isArray(category.items))
    .map((category: any) => ({
      id: category.id,
      label: typeof category.label === 'string' ? category.label : category.id,
      items: category.items
        .filter((item: any) => item && typeof item.title === 'string' && typeof item.text === 'string')
        .map((item: any) => ({ title: item.title.trim(), text: item.text.trim() }))
        .filter((item: SuggestionItem) => item.title && item.text),
    }));

  return categories.length > 0 ? { agent: categories } : emptySuggestionDefaults(locale);
}
