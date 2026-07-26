/**
 * migrate-global-scope — 把「无项目」run 数据从 data/ 根迁到 data/projects/default/。
 *
 * 背景:无项目(全局态)的 run 数据曾直接落在 data/ 根,与真实项目的
 * data/projects/<id>/ 层级不一致。现在 resolveRunPaths 的无项目分支统一
 * 指向 data/projects/default/ 全局桶,本脚本一次性搬运历史数据。
 *
 * 用法：
 *   npm run migrate:global                 # 等价 bun scripts/migrate-global-scope.ts
 *   bun scripts/migrate-global-scope.ts --data-dir <path>   # 指定数据目录（默认 ./data）
 *
 * 迁移范围(per-scope 项):
 *   traces/  session-checkpoints/  worker-logs/  uploads/
 *   agent-memory.json  chat-sessions.json
 *
 * 不迁移:
 *   - 真全局文件: config.json / projects.json / chrome-mcp-tools.json /
 *     suggestions.json / runtime-config.json / fetch-domain-rules.json /
 *     logs/ / screenshots/ / llm-logs/ / eval-* / smoke-reports/ / browser-profile/
 *   - checkpoints/: Step 级重启恢复机制已删除,若存在残留仅提示可手动删除。
 *
 * 幂等:目录按条目逐个 move,目标已存在同名条目则跳过并告警;重复运行安全。
 */

import { mkdir, readdir, rename, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLOBAL_SCOPE_ID, projectDataDir } from '../agent/core/project-store.ts';

// per-scope 目录:按条目逐个搬,支持与目标已有内容合并。
const SCOPE_DIRS = ['traces', 'session-checkpoints', 'worker-logs', 'uploads'];
// per-scope 单文件:整个搬,目标已存在则跳过。
const SCOPE_FILES = ['agent-memory.json', 'chat-sessions.json'];

function parseDataDir(): string {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const flagIndex = process.argv.indexOf('--data-dir');
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return path.resolve(process.argv[flagIndex + 1]);
  }
  return path.resolve(repoRoot, process.env.MEMORY_DIR || 'data');
}

async function pathKind(target: string): Promise<'dir' | 'file' | 'missing'> {
  try {
    return (await stat(target)).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

/** 逐条目合并搬运目录;返回 { moved, skipped }。源清空后删除空目录。 */
async function moveDirEntries(sourceDir: string, targetDir: string, label: string) {
  let moved = 0;
  let skipped = 0;
  const entries = await readdir(sourceDir);
  if (entries.length > 0) await mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    const from = path.join(sourceDir, entry);
    const to = path.join(targetDir, entry);
    if (await pathKind(to) !== 'missing') {
      console.warn(`  [跳过] ${label}/${entry} 目标已存在,保留两侧不覆盖`);
      skipped += 1;
      continue;
    }
    await rename(from, to);
    moved += 1;
  }
  // 源目录清空则移除,避免留下会误导层级判断的空壳。
  try {
    await rmdir(sourceDir);
  } catch {
    // 还有跳过的条目时保留源目录。
  }
  return { moved, skipped };
}

async function main() {
  const dataDir = parseDataDir();
  const bucketDir = projectDataDir(dataDir, GLOBAL_SCOPE_ID);
  if (await pathKind(dataDir) !== 'dir') {
    console.log(`数据目录不存在,无需迁移: ${dataDir}`);
    return;
  }

  console.log(`迁移「无项目」run 数据: ${dataDir} → ${bucketDir}`);
  await mkdir(bucketDir, { recursive: true });

  const summary: string[] = [];
  for (const dir of SCOPE_DIRS) {
    const source = path.join(dataDir, dir);
    if (await pathKind(source) !== 'dir') continue;
    const { moved, skipped } = await moveDirEntries(source, path.join(bucketDir, dir), dir);
    summary.push(`${dir}/: 迁移 ${moved} 项${skipped > 0 ? `,跳过 ${skipped} 项` : ''}`);
  }

  for (const file of SCOPE_FILES) {
    const source = path.join(dataDir, file);
    if (await pathKind(source) === 'missing') continue;
    const target = path.join(bucketDir, file);
    if (await pathKind(target) !== 'missing') {
      console.warn(`  [跳过] ${file} 目标已存在,保留两侧不覆盖`);
      summary.push(`${file}: 跳过(目标已存在)`);
      continue;
    }
    await rename(source, target);
    summary.push(`${file}: 已迁移`);
  }

  if (summary.length === 0) {
    console.log('data/ 根未发现待迁移的 per-scope 数据,无需处理。');
  } else {
    console.log('迁移完成:');
    for (const line of summary) console.log(`  - ${line}`);
  }

  // Step 级 checkpoint 机制已删除,历史 checkpoints/ 不迁移。
  if (await pathKind(path.join(dataDir, 'checkpoints')) === 'dir') {
    console.log(`提示: ${path.join(dataDir, 'checkpoints')} 属于已删除的重启恢复机制,可手动删除。`);
  }
}

main().catch(err => {
  console.error('迁移失败:', err?.message || err);
  process.exit(1);
});
