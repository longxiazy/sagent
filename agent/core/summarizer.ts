/**
 * Summarizer — 记忆摘要调用封装
 *
 * 用途：通过 provider registry 的 summarize 能力对长文本做摘要，
 * 并在控制台输出醒目的框式请求/响应/失败日志。
 *
 * 调用场景：当前无调用方。记忆压缩路径尚未接入，保留此封装待接。
 * 若长期无人使用应连同 providers 的 summarize 一并评估是否删除。
 */

import { displayWidth, padEndW } from './utils.ts';
import { log } from '../../helpers/logger.ts';
import type { ProviderRegistry } from './providers/registry.ts';

/** 调用指定模型的 summarize 并带框式日志返回摘要文本；失败抛原错误。 */
export async function summarizeText({
  text,
  registry,
  model,
}: {
  text: string;
  registry: ProviderRegistry;
  model: string;
}) {
  const shortModel = model?.split('/').pop() || '?';
  const startTime = Date.now();
  const reqLine = `  >>> 记忆摘要 REQUEST  ${shortModel}  input=${text.length}字`;
  const w = Math.max(displayWidth(reqLine) + 4, 52);
  log.info(`\n  ${'╔' + '═'.repeat(w) + '╗'}\n  ║${padEndW(reqLine, w)}║\n  ${'╚' + '═'.repeat(w) + '╝'}`);

  try {
    const provider = registry.resolve(model, null);
    const result = await provider.summarize({ text, model });

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
