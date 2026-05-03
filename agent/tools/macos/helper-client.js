import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DEFAULT_HELPER_CANDIDATES = [
  process.env.AGENT_MACOS_HELPER_PATH,
  path.resolve(PROJECT_DIR, 'agent/tools/macos/helper/bin/macos-agent-helper'),
].filter(Boolean);

function execFileJson(file, args, payload = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 12000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }

      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (err) {
        reject(new Error(`helper 输出不是 JSON: ${err.message}`));
      }
    });

    if (child.stdin) {
      child.stdin.end(JSON.stringify(payload));
    }
  });
}

export function resolveMacOSHelperPath(candidatePaths = DEFAULT_HELPER_CANDIDATES) {
  return candidatePaths.find(item => item && fs.existsSync(item)) || '';
}

export function resolveMacOSBackend(candidatePaths = DEFAULT_HELPER_CANDIDATES) {
  const helperPath = resolveMacOSHelperPath(candidatePaths);
  if (helperPath) {
    return {
      type: 'helper',
      helperPath,
    };
  }

  return {
    type: 'shell',
    helperPath: '',
  };
}

export async function invokeMacOSHelper(command, payload = {}, candidatePaths = DEFAULT_HELPER_CANDIDATES) {
  const helperPath = resolveMacOSHelperPath(candidatePaths);
  if (!helperPath) {
    throw new Error('未找到 macOS helper 二进制');
  }

  return execFileJson(helperPath, [command], payload);
}
