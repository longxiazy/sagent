/**
 * 截图资源管理路由。
 *
 * 截图是全局资源(统一落在 SCREENSHOT_DIR = MEMORY_DIR/screenshots),不按项目隔离,
 * 因此这里不接 projectStore,只需注入 screenshotDir。所有物理删除都经 resolveInside()
 * 做路径穿越校验(见 helpers/screenshot-store.ts)。
 */

import { Router } from 'express';
import fs from 'node:fs/promises';
import { tReq } from '../helpers/i18n.ts';
import { configStore } from '../agent/core/config-store.ts';
import {
  scanScreenshots,
  cleanupScreenshots,
  resolveInside,
  isSafeSegment,
  type RetentionPolicy,
} from '../helpers/screenshot-store.ts';

function currentRetention(): RetentionPolicy {
  return (configStore.tools().screenshots?.retention || {}) as RetentionPolicy;
}

// 回给前端的截图配置(redaction + retention),供保留策略表单读取当前值。
function currentScreenshotsConfig() {
  return configStore.tools().screenshots || {};
}

export function createAgentScreenshotsRouter({ screenshotDir }: { screenshotDir: string }) {
  const router = Router();

  // 列表:按 run 分组 + 汇总 + 当前截图配置。
  router.get('/api/agent/screenshots', async (_req, res) => {
    const scan = await scanScreenshots(screenshotDir);
    res.json({ ...scan, screenshots: currentScreenshotsConfig() });
  });

  // 手动清理:忽略 enabled 开关,直接按当前阈值执行(阈值都为空则不删)。
  router.post('/api/agent/screenshots/cleanup', async (_req, res) => {
    const result = await cleanupScreenshots(screenshotDir, { ...currentRetention(), enabled: true });
    const scan = await scanScreenshots(screenshotDir);
    res.json({ ...result, ...scan, screenshots: currentScreenshotsConfig() });
  });

  // 清空:删除所有 run 子目录。
  router.delete('/api/agent/screenshots', async (_req, res) => {
    let entries;
    try {
      entries = await fs.readdir(screenshotDir, { withFileTypes: true });
    } catch {
      return res.json({ ok: true });
    }
    await Promise.all(entries
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const abs = resolveInside(screenshotDir, entry.name);
        return abs ? fs.rm(abs, { recursive: true, force: true }).catch(() => {}) : Promise.resolve();
      }));
    res.json({ ok: true });
  });

  // 删除整个 run 目录。
  router.delete('/api/agent/screenshots/:runId', async (req, res) => {
    const abs = isSafeSegment(req.params.runId) ? resolveInside(screenshotDir, req.params.runId) : null;
    if (!abs) return res.status(400).json({ error: tReq(req, 'screenshots.invalidPath') });
    await fs.rm(abs, { recursive: true, force: true }).catch(() => {});
    res.json({ ok: true });
  });

  // 删除单张截图。
  router.delete('/api/agent/screenshots/:runId/:file', async (req, res) => {
    const abs = resolveInside(screenshotDir, req.params.runId, req.params.file);
    if (!abs) return res.status(400).json({ error: tReq(req, 'screenshots.invalidPath') });
    await fs.rm(abs, { force: true }).catch(() => {});
    res.json({ ok: true });
  });

  return router;
}
