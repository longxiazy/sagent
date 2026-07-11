import fs from 'node:fs';
import path from 'node:path';

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getLogPolicy() {
  return {
    maxBytes: positiveEnv('AGENT_LOG_MAX_BYTES', 10 * 1024 * 1024),
    retentionDays: positiveEnv('AGENT_LOG_RETENTION_DAYS', 14),
  };
}

export function pruneLogTreeSync(rootDir: string, retentionDays = getLogPolicy().retentionDays): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        try {
          if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
        } catch {}
        continue;
      }
      try {
        if (fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target);
      } catch {}
    }
  };
  visit(rootDir);
}

export function rotateLogFileSync(filePath: string, incomingBytes = 0, maxBytes = getLogPolicy().maxBytes): void {
  try {
    const size = fs.statSync(filePath).size;
    if (size + incomingBytes <= maxBytes) return;
    const rotated = `${filePath}.1`;
    try { fs.unlinkSync(rotated); } catch {}
    fs.renameSync(filePath, rotated);
  } catch {}
}
