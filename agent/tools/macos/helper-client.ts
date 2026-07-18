import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const DEFAULT_HELPER_CANDIDATES = [
  process.env.AGENT_MACOS_HELPER_PATH,
  path.resolve(process.cwd(), 'agent/tools/macos/helper/bin/macos-agent-helper'),
].filter(Boolean);

function execFileJson(file: string, args: string[], payload: any = {}, timeout = 12000, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, signal }, (error, stdout, stderr) => {
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
      // helper 在读完 stdin 前退出/崩溃时，向其 stdin 写入会触发 EPIPE；
      // 未监听的可写流 'error' 会作为未捕获异常使整个后端进程崩溃，这里吞掉它，
      // 真正的失败会经 execFile 回调（进程退出码/stderr）反映。
      child.stdin.on('error', () => {});
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

export async function invokeMacOSHelper(command: string, payload: any = {}, candidatePaths = DEFAULT_HELPER_CANDIDATES, opts: { signal?: AbortSignal } = {}): Promise<any> {
  const helperPath = resolveMacOSHelperPath(candidatePaths);
  if (!helperPath) {
    throw new Error('未找到 macOS helper 二进制');
  }

  return execFileJson(helperPath, [command], payload, 12000, opts.signal);
}
