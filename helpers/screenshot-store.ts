/**
 * 截图资源存储:扫描 + 保留策略清理。
 *
 * 所有截图(浏览器预览 browser-preview-*.jpg 与 macOS 桌面观察 screen-*.png)都落在
 * 单一 `{MEMORY_DIR}/screenshots/{runId}/` 目录下(见 agent/tools/browser/webview-session.ts
 * 与 agent/tools/macos/observe.ts),由 server.ts 的 `/screenshots` 静态服务对外提供。
 * 这里以“服务目录”为权威扫描源,供管理路由(routes/agent-screenshots.ts)与启动/定时清理复用。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export type ScreenshotKind = 'browser' | 'desktop' | 'other';

export interface ScreenshotFile {
  name: string;
  url: string;
  kind: ScreenshotKind;
  bytes: number;
  mtime: number;
}

export interface ScreenshotGroup {
  runId: string;
  count: number;
  bytes: number;
  latestMtime: number;
  files: ScreenshotFile[];
}

export interface ScreenshotScan {
  total: { count: number; bytes: number };
  groups: ScreenshotGroup[];
}

export interface RetentionPolicy {
  enabled?: boolean;
  maxAgeDays?: number;
  maxTotalMB?: number;
}

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
// run 目录名 / 文件名的安全字符集(与 webview-session.ts 的 safeRunId 落盘约定一致)。
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;

function classifyKind(name: string): ScreenshotKind {
  if (name.startsWith('browser-preview-')) return 'browser';
  if (name.startsWith('screen-')) return 'desktop';
  return 'other';
}

/** 路径段是否安全(拒绝 `..`、路径分隔符、空段)。 */
export function isSafeSegment(segment: string): boolean {
  return typeof segment === 'string' && segment !== '..' && SAFE_SEGMENT_RE.test(segment);
}

/**
 * 解析 runId/file 到绝对路径,并校验落在 screenshotDir 内(防路径穿越)。
 * 任一段非法或结果越界则返回 null。
 */
export function resolveInside(screenshotDir: string, ...segments: string[]): string | null {
  if (!segments.every(isSafeSegment)) return null;
  const root = path.resolve(screenshotDir);
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** 扫描一层 run 子目录,按 latestMtime 倒序;组内文件按 mtime 倒序。 */
export async function scanScreenshots(screenshotDir: string): Promise<ScreenshotScan> {
  const root = path.resolve(screenshotDir);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { total: { count: 0, bytes: 0 }, groups: [] };
  }

  const groups: ScreenshotGroup[] = [];
  let totalCount = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const dirPath = path.join(root, runId);
    let files;
    try {
      files = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const groupFiles: ScreenshotFile[] = [];
    let groupBytes = 0;
    let latestMtime = 0;

    for (const file of files) {
      if (!file.isFile() || !IMAGE_RE.test(file.name)) continue;
      let stat;
      try {
        stat = await fs.stat(path.join(dirPath, file.name));
      } catch {
        continue;
      }
      const mtime = stat.mtimeMs;
      groupFiles.push({
        name: file.name,
        url: `/screenshots/${runId}/${file.name}`,
        kind: classifyKind(file.name),
        bytes: stat.size,
        mtime,
      });
      groupBytes += stat.size;
      if (mtime > latestMtime) latestMtime = mtime;
    }

    if (groupFiles.length === 0) continue;
    groupFiles.sort((a, b) => b.mtime - a.mtime);
    groups.push({ runId, count: groupFiles.length, bytes: groupBytes, latestMtime, files: groupFiles });
    totalCount += groupFiles.length;
    totalBytes += groupBytes;
  }

  groups.sort((a, b) => b.latestMtime - a.latestMtime);
  return { total: { count: totalCount, bytes: totalBytes }, groups };
}

/** 删除空的 run 目录。 */
async function removeEmptyRunDirs(root: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(root, entry.name);
    try {
      const inner = await fs.readdir(dirPath);
      if (inner.length === 0) await fs.rmdir(dirPath).catch(() => {});
    } catch { /* ignore */ }
  }
}

/**
 * 按保留策略清理:先删超过 maxAgeDays 的文件,再若总大小超 maxTotalMB 则按 mtime
 * 从旧到新删至阈值内;最后清掉空 run 目录。返回删除数量与释放字节。
 * enabled=false 或两项阈值都无效时不删任何文件。
 */
export async function cleanupScreenshots(
  screenshotDir: string,
  policy: RetentionPolicy,
): Promise<{ removedFiles: number; removedBytes: number }> {
  const root = path.resolve(screenshotDir);
  const maxAgeDays = Number(policy?.maxAgeDays);
  const maxTotalMB = Number(policy?.maxTotalMB);
  const ageActive = Number.isFinite(maxAgeDays) && maxAgeDays > 0;
  const sizeActive = Number.isFinite(maxTotalMB) && maxTotalMB > 0;
  if (!ageActive && !sizeActive) return { removedFiles: 0, removedBytes: 0 };

  const scan = await scanScreenshots(root);
  const allFiles = scan.groups.flatMap(group => group.files.map(file => ({ ...file, runId: group.runId })));
  const removed = new Set<string>();
  let removedFiles = 0;
  let removedBytes = 0;

  const removeFile = async (file: { runId: string; name: string; bytes: number }) => {
    const abs = resolveInside(root, file.runId, file.name);
    if (!abs) return false;
    try {
      await fs.rm(abs, { force: true });
      removed.add(`${file.runId}/${file.name}`);
      removedFiles += 1;
      removedBytes += file.bytes;
      return true;
    } catch {
      return false;
    }
  };

  // 1) 过期文件(mtime 早于 cutoff)。
  if (ageActive) {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    for (const file of allFiles) {
      if (file.mtime < cutoff) await removeFile(file);
    }
  }

  // 2) 超总大小:剩余文件按 mtime 从旧到新删,直到总量 <= 预算。
  if (sizeActive) {
    const budget = maxTotalMB * 1024 * 1024;
    const remaining = allFiles
      .filter(file => !removed.has(`${file.runId}/${file.name}`))
      .sort((a, b) => a.mtime - b.mtime);
    let totalBytes = remaining.reduce((sum, file) => sum + file.bytes, 0);
    for (const file of remaining) {
      if (totalBytes <= budget) break;
      if (await removeFile(file)) totalBytes -= file.bytes;
    }
  }

  await removeEmptyRunDirs(root);
  return { removedFiles, removedBytes };
}
