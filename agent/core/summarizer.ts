import { displayWidth, padEndW } from './utils.ts';
import { isClaudeModel } from './ai-client.ts';
import { log } from '../../helpers/logger.ts';
import { retryAsync } from '../../helpers/retry.ts';

export async function summarizeText({
  text,
  openai_client,
  anthropic_client,
  model,
}: {
  text: string;
  openai_client: any;
  anthropic_client: any;
  model: string;
}) {
  const shortModel = model?.split('/').pop() || '?';
  const startTime = Date.now();
  const reqLine = `  >>> 记忆摘要 REQUEST  ${shortModel}  input=${text.length}字`;
  const w = Math.max(displayWidth(reqLine) + 4, 52);
  log.info(`\n  ${'╔' + '═'.repeat(w) + '╗'}\n  ║${padEndW(reqLine, w)}║\n  ${'╚' + '═'.repeat(w) + '╝'}`);

  const prompt = `请用简洁的中文提炼以下 Agent 任务记录的关键信息。要求：
1. 相同或相似主题的任务合并为一条，不要重复
2. 每个任务一行，格式：任务→结果要点
3. 保留重要的事实、数据和结论
4. 去除冗余细节

${text}`;

  try {
    let result;
    const useClaude = isClaudeModel(model, null);
    if (useClaude && anthropic_client) {
      const resp = await retryAsync(() => anthropic_client.messages.create({
        model,
        max_tokens: 800,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }));
      result = resp.content.find((block: any) => block.type === 'text')?.text || text.slice(0, 300);
    } else if (openai_client) {
      const resp = await retryAsync(() => openai_client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 800,
      }));
      result = resp.choices[0]?.message?.content || text.slice(0, 300);
    } else {
      result = text.slice(0, 300);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const resLine = `  <<< 记忆摘要 RESPONSE ${shortModel}  ${elapsed}s  output=${result.length}字`;
    const rw = Math.max(displayWidth(resLine) + 4, 52);
    log.info(`\n  ${'╔' + '═'.repeat(rw) + '╗'}\n  ║${padEndW(resLine, rw)}║\n  ${'╚' + '═'.repeat(rw) + '╝'}`);
    return result;
  } catch (err: any) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const errLine = `  !!! 记忆摘要 FAILED   ${shortModel}  ${elapsed}s  ${err.message.slice(0, 60)}`;
    const ew = Math.max(displayWidth(errLine) + 4, 52);
    log.warn(`\n  ${'╔' + '═'.repeat(ew) + '╗'}\n  ║${padEndW(errLine, ew)}║\n  ${'╚' + '═'.repeat(ew) + '╝'}`);
    throw err;
  }
}
