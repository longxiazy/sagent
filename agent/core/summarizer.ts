import { displayWidth, padEndW } from './utils.ts';
import { log } from '../../helpers/logger.ts';
import type { ProviderRegistry } from './providers/registry.ts';

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
