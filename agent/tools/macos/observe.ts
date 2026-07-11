import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { getMacOSCapabilityReport } from './permissions.ts';
import { invokeMacOSHelper, resolveMacOSBackend } from './helper-client.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, '../../../data/screenshots');

function emptyUnlessAborted(signal?: AbortSignal) {
  return (err: unknown) => {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : err;
    return '';
  };
}

function execFileText(file: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 12000, signal }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

async function captureScreenshot(runId, signal?: AbortSignal) {
  const dirPath = path.join(SCREENSHOT_DIR, runId || 'default');
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, `screen-${Date.now()}.png`);
  try {
    await execFileText('screencapture', ['-x', '-t', 'png', filePath], signal);
    if (process.env.AGENT_SCREENSHOT_REDACTION !== 'none') {
      try {
        await execFileText('sips', ['-z', '48', '72', filePath], signal);
        await execFileText('sips', ['-z', '960', '1440', filePath], signal);
      } catch (err) {
        await fs.rm(filePath, { force: true }).catch(() => {});
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : err;
        return '';
      }
    }
    await fs.chmod(filePath, 0o600).catch(() => {});
    return filePath;
  } catch (err) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : err;
    return '';
  }
}

async function observeWithShell(runId, signal?: AbortSignal) {
  const frontmostApp = await execFileText('osascript', [
    '-e',
    'tell application "System Events" to name of first application process whose frontmost is true',
  ], signal).catch(emptyUnlessAborted(signal));

  const frontmostWindowTitle = await execFileText('osascript', [
    '-e',
    'tell application "System Events" to tell (first application process whose frontmost is true) to (name of front window as text)',
  ], signal).catch(emptyUnlessAborted(signal));

  const windowsText = await execFileText('osascript', [
    '-e',
    'tell application "System Events"\nset outputLines to {}\nrepeat with proc in application processes\ntry\nrepeat with win in windows of proc\nset end of outputLines to (name of proc as text) & "|||" & (name of win as text)\nend repeat\nend try\nend repeat\nset AppleScript\'s text item delimiters to linefeed\nreturn outputLines as text\nend tell',
  ], signal).catch(emptyUnlessAborted(signal));

  const windows = windowsText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [app, title] = line.split('|||');
      return {
        app: app || '',
        title: title || '',
      };
    })
    .slice(0, 20);

  return {
    backend: 'shell',
    frontmostApp,
    frontmostWindowTitle,
    windows,
    screenshotPath: await captureScreenshot(runId, signal),
  };
}

async function observeWithHelper(runId, signal?: AbortSignal) {
  const desktop = await invokeMacOSHelper('observe', { runId }, undefined, { signal });
  return {
    backend: 'helper',
    frontmostApp: desktop.frontmostApp || '',
    frontmostWindowTitle: desktop.frontmostWindowTitle || '',
    windows: Array.isArray(desktop.windows) ? desktop.windows.slice(0, 20) : [],
    screenshotPath: await captureScreenshot(runId, signal),
  };
}

export async function observeMacOSDesktop({ runId, signal = undefined }) {
  const capability = getMacOSCapabilityReport();
  const backend = resolveMacOSBackend();
  const desktop =
    backend.type === 'helper'
      ? await observeWithHelper(runId, signal).catch(err => {
          if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : err;
          return observeWithShell(runId, signal);
        })
      : await observeWithShell(runId, signal);

  return {
    ...desktop,
    capability,
  };
}
