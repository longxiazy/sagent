/**
 * http_fetch 抓取即提炼(per-fetch distill)
 *
 * http_fetch 抓来的网页正文只作为提炼输入。这里用一个便宜模型以 task 为锚生成
 * 摘要，步骤面板、trace 和后续 planner history 都只使用摘要，避免原文在每一步
 * 重复展示并进入后续 prompt。
 * 摘要同时**强制保留来源 URL**——result-quality 的官方来源判定与
 * appendHttpFetchReferences 都从 result 文本里提 URL,丢了会破坏打分与引用。
 *
 * 提炼模型由 desktop/agent.ts 经 resolveToolModel 四级解析：
 * 项目覆盖 → 全局配置 → DISTILL_MODEL → 当前主模型。主模型是最后兜底，
 * 因此默认状态下提炼是开着的（用主模型）；正文短于阈值或解析结果为空时原样返回;
 * 提炼失败/超时回退原文,绝不抛错阻断主流程(取消信号例外,需向上传播)。
 */

import { log } from '../../../helpers/logger.ts';

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
  threshold = 120,
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
        messages: [{ role: 'user', content: buildDistillPrompt(task, url, original, maxChars) }],
        temperature: 0.1,
        max_tokens: 1000, // 留足空间:推理模型写完思考链后仍能产出正文,减少被截断成"纯思考"
      },
      signal ? { signal } : undefined,
    );
    // Distill 输出作为模型原始结果追加展示，不在此改写或剥离思考内容。
    const distilled = typeof response?.choices?.[0]?.message?.content === 'string'
      ? response.choices[0].message.content.trim()
      : '';
    if (!distilled) return original;
    return ensureSourceUrls(distilled, sourceUrls);
  } catch (err: any) {
    // 取消信号必须向上传播,否则取消后仍返回原文让主循环继续
    if (signal?.aborted) throw err;
    log.warn(`[Distill] 提炼失败,回退原文: ${err?.message || err}`);
    return original;
  }
}

function buildDistillPrompt(task: string | undefined, url: string | undefined, text: string, maxChars: number): string {
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n...(正文过长已截断)` : text;
  return [
    '你是网页证据提取器。当前输入只代表一个网页来源，不是完成整个用户任务所需的全部材料。',
    '',
    '严格遵守：',
    '1. 用户任务仅用于判断哪些网页内容相关；不要在本次输出中完成整个任务、凑齐数量、比较其他来源或给出跨来源结论。',
    '2. 如果任务要求多个信息源，把当前网页仅视为一个候选来源。不要把正文里的模型、厂商、人物、栏目或数据条目重新解释成多个“信息源”。',
    '3. 只提取正文明确写出的相关事实、数字、日期、原话和页面自述；不要补充常识、猜测、外部知识或虚构链接。',
    '4. 正文中出现的所有 http/https URL 必须原样保留；来源页面 URL 也必须原样输出。',
    '5. 只输出最终提取结果。禁止输出分析过程、思考步骤、任务复述、歧义讨论、Correction、Refinement、Thinking Process 或类似内容。',
    '6. 使用简体中文，控制在 8 个要点以内；没有相关内容时写“正文无相关信息”。',
    '',
    '固定输出格式：',
    `来源页面：${url || '未提供'}`,
    '相关信息：',
    '- <直接来自正文的相关信息>',
    '',
    '<用户任务>',
    task || '未提供',
    '</用户任务>',
    '',
    '<网页正文>',
    body,
    '</网页正文>',
  ].join('\n');
}

// 提炼可能丢弃 URL,补回缺失的来源,保证 result-quality 的官方来源判定与引用不失效。
function ensureSourceUrls(distilled: string, sourceUrls: Set<string>): string {
  const present = new Set(Array.from(distilled.matchAll(URL_RE)).map(match => match[0]));
  const missing = [...sourceUrls].filter(sourceUrl => !present.has(sourceUrl));
  if (!missing.length) return distilled;
  return `${distilled}\n来源: ${missing.join(' ')}`;
}
