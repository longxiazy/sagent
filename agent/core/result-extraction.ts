const PARALLEL_SEPARATOR = /\n\s*---\s*\n/g;
const GENERIC_SIGNAL_RE = /增长|下降|同比|环比|总额|收入|产值|占比|比例|达到|完成|新增|减少|投资|消费|人口|就业|研发|创新|数据|结论|结果|失败|错误|warning|error|failed|increase|decrease|total|revenue|rate|percent/i;
const TASK_STOP_TERMS = new Set(['近三', '三年', '发展', '情况', '调查', '分析', '查询', '获取', '信息', '什么', '如何', '需要', '这个', '一下']);

function normalizeText(value: unknown) {
  return String(value ?? '').replace(/\r/g, '').trim();
}

function taskTerms(task: string) {
  const text = normalizeText(task).toLowerCase();
  const terms = new Set<string>();
  for (const word of text.match(/[a-z0-9][a-z0-9._-]{1,}/g) || []) terms.add(word);
  for (const chunk of text.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (const size of [2, 3, 4]) {
      for (let index = 0; index <= chunk.length - size; index += 1) {
        const term = chunk.slice(index, index + size);
        if (!TASK_STOP_TERMS.has(term)) terms.add(term);
      }
    }
  }
  return [...terms].slice(0, 40);
}

function sentenceChunks(text: string) {
  const chunks: Array<{ index: number; text: string }> = [];
  const rawSentences = text.split(/(?<=[。！？；!?;])|\n+/u);
  let index = 0;
  for (const raw of rawSentences) {
    const sentence = raw.replace(/\s+/g, ' ').trim();
    if (!sentence) continue;
    for (let offset = 0; offset < sentence.length; offset += 600) {
      const part = sentence.slice(offset, offset + 600).trim();
      if (part) chunks.push({ index, text: part });
      index += 1;
    }
  }
  return chunks;
}

function sentenceScore(sentence: string, terms: string[]) {
  const lower = sentence.toLowerCase();
  let score = 0;
  if (/20\d{2}/.test(sentence)) score += 4;
  if (/\d[\d,.]*\s*(?:%|万|亿|兆|元|人|家|项|个|公里|吨|美元|tokens?)/i.test(sentence)) score += 4;
  if (GENERIC_SIGNAL_RE.test(sentence)) score += 2;
  for (const term of terms) {
    if (lower.includes(term)) score += term.length >= 3 ? 3 : 2;
  }
  return score;
}

function selectRelevantSentences(text: string, budget: number, task: string) {
  const seen = new Set<string>();
  const sentences = sentenceChunks(text).filter(item => {
    const key = item.text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (sentences.length === 0) return text.slice(0, budget);
  const terms = taskTerms(task);
  const scored = sentences.map(item => ({ ...item, score: sentenceScore(item.text, terms) }));
  const selected = new Map<number, string>();

  // 先从全文四个区段各取一个高信息句，避免所有预算都集中在页面开头。
  const bucketCount = Math.min(4, scored.length);
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor((bucket * scored.length) / bucketCount);
    const end = Math.floor(((bucket + 1) * scored.length) / bucketCount);
    const best = scored.slice(start, end).sort((a, b) => b.score - a.score || a.index - b.index)[0];
    if (best) selected.set(best.index, best.text);
  }

  for (const item of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (selected.has(item.index)) continue;
    selected.set(item.index, item.text);
    const used = [...selected.values()].reduce((sum, value) => sum + value.length + 1, 0);
    if (used >= budget) break;
  }

  const ordered = [...selected.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  let output = '';
  for (const sentence of ordered) {
    if (output.length + sentence.length + 1 > budget) continue;
    output += `${output ? '\n' : ''}${sentence}`;
  }
  return output || text.slice(0, budget);
}

function sourceHeader(source: string, index: number) {
  const firstLine = source.split('\n', 1)[0]?.trim() || '';
  if (/^(?:http_fetch|web_search)\s+https?:\/\//i.test(firstLine)) return firstLine;
  const url = source.match(/https?:\/\/\S+/)?.[0]?.replace(/[),.;]+$/, '');
  return url ? `来源 ${index + 1}: ${url}` : `来源 ${index + 1}`;
}

function compactSource(source: string, index: number, budget: number, task: string) {
  const header = sourceHeader(source, index);
  const body = source.startsWith(header) ? source.slice(header.length).trim() : source;
  if (source.length <= budget) return source;
  const marker = `[提取摘要：原始 ${source.length} 字符]`;
  const contentBudget = Math.max(200, budget - header.length - marker.length - 4);
  const excerpt = selectRelevantSentences(body, contentBudget, task);
  return `${header}\n${marker}\n${excerpt}`.slice(0, budget);
}

export function compactToolResult({
  result,
  action,
  task = '',
  limit,
}: {
  result: unknown;
  action?: any;
  task?: string;
  limit: number;
}) {
  const text = normalizeText(result);
  if (text.length <= limit) return text;

  const isParallel = PARALLEL_SEPARATOR.test(text);
  PARALLEL_SEPARATOR.lastIndex = 0;
  if (!isParallel) {
    const marker = `[提取摘要：原始 ${text.length} 字符]`;
    const excerpt = selectRelevantSentences(text, Math.max(200, limit - marker.length - 1), task);
    return `${marker}\n${excerpt}`.slice(0, limit);
  }

  const sources = text.split(PARALLEL_SEPARATOR).map(source => source.trim()).filter(Boolean);
  PARALLEL_SEPARATOR.lastIndex = 0;
  if (sources.length === 0) return text.slice(0, limit);
  const separator = '\n\n---\n\n';
  const available = Math.max(200, limit - separator.length * (sources.length - 1));
  const perSource = Math.max(120, Math.floor(available / sources.length));
  const compacted = sources.map((source, index) => compactSource(source, index, perSource, task));
  return compacted.join(separator).slice(0, limit);
}
