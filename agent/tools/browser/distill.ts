/**
 * http_fetch 抓取即提炼(per-fetch distill)
 *
 * http_fetch 抓来的网页正文整段进 history,会让后续每步 prompt 平方级膨胀。
 * 这里在正文进入 history 前,用一个便宜模型以 task 为锚提炼成要点,大幅压缩体积,
 * 同时**强制保留来源 URL**——result-quality 的官方来源判定与 appendHttpFetchReferences
 * 都从 result 文本里提 URL,丢了会破坏打分与引用。
 *
 * 纯增量、默认关闭:未配置 distillModel(client/model 为空)或正文短于阈值时原样返回;
 * 提炼失败/超时回退原文,绝不抛错阻断主流程(取消信号例外,需向上传播)。
 */

import { log } from '../../../helpers/logger.ts';

export const DEFAULT_DISTILL_MODEL = ''; // 默认空 = 关闭提炼

// 与 result-quality.ts 的 urlsFromText 同口径,避免把中文标点/右括号吞进 URL。
const URL_RE = /https?:\/\/[^\s)\]"'，。]+/g;

interface ChatCompletionClient {
  chat: { completions: { create: (body: any, options?: any) => Promise<any> } };
}

export interface DistillOptions {
  text: string;
  url?: string;
  task?: string;
  client?: ChatCompletionClient | null;
  model?: string;
  signal?: AbortSignal;
  /** 正文短于此(字符)直接返回,不提炼。 */
  threshold?: number;
  /** 提炼输入正文的上限,过长先截断。 */
  maxChars?: number;
}

export async function distillFetchContent({
  text,
  url,
  task,
  client,
  model,
  signal,
  threshold = 1200,
  maxChars = 24000,
}: DistillOptions): Promise<string> {
  const original = String(text ?? '');

  // 未配置 / 短文 → 原样返回(纯增量,默认不改变行为)
  if (!client || !model || original.length < threshold) return original;

  // 收集必须保留的来源 URL:主 URL + 正文内所有 URL
  const sourceUrls = new Set<string>();
  if (url) sourceUrls.add(url);
  for (const match of original.matchAll(URL_RE)) sourceUrls.add(match[0]);

  try {
    const response = await client.chat.completions.create(
      {
        model,
        messages: [{ role: 'user', content: buildDistillPrompt(task, original, maxChars) }],
        temperature: 0.1,
        max_tokens: 600,
      },
      signal ? { signal } : undefined,
    );
    const distilled = response?.choices?.[0]?.message?.content?.trim();
    if (!distilled) return original; // 空输出 → 回退原文
    return ensureSourceUrls(distilled, sourceUrls);
  } catch (err: any) {
    // 取消信号必须向上传播,否则取消后仍返回原文让主循环继续
    if (signal?.aborted) throw err;
    log.warn(`[Distill] 提炼失败,回退原文: ${err?.message || err}`);
    return original;
  }
}

function buildDistillPrompt(task: string | undefined, text: string, maxChars: number): string {
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n...(正文过长已截断)` : text;
  return [
    task ? `任务:${task}` : '',
    '从以下网页正文中提炼与任务直接相关的事实、数字、时间和结论,用简洁中文分条列出。',
    '必须原样保留正文中出现的所有来源 URL(http/https 开头),不得改写或省略。',
    '正文没有与任务相关的信息时,直接说明"正文无相关信息"。',
    '',
    body,
  ].filter(Boolean).join('\n');
}

// 提炼可能丢弃 URL,补回缺失的来源,保证 result-quality 的官方来源判定与引用不失效。
function ensureSourceUrls(distilled: string, sourceUrls: Set<string>): string {
  const present = new Set(Array.from(distilled.matchAll(URL_RE)).map(match => match[0]));
  const missing = [...sourceUrls].filter(sourceUrl => !present.has(sourceUrl));
  if (!missing.length) return distilled;
  return `${distilled}\n来源: ${missing.join(' ')}`;
}
