import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { getMacOSCapabilityReport } from './permissions.js';
import { invokeMacOSHelper, resolveMacOSBackend } from './helper-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || path.resolve(__dirname, '../../../data/screenshots');

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 12000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

async function captureScreenshot(runId) {
  const dirPath = path.join(SCREENSHOT_DIR, runId || 'default');
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, `screen-${Date.now()}.png`);
  try {
    await execFileText('screencapture', ['-x', '-t', 'png', filePath]);
    return filePath;
  } catch {
    return '';
  }
}

async function observeWithShell(runId) {
  const frontmostApp = await execFileText('osascript', [
    '-e',
    'tell application "System Events" to name of first application process whose frontmost is true',
  ]).catch(() => '');

  const frontmostWindowTitle = await execFileText('osascript', [
    '-e',
    'tell application "System Events" to tell (first application process whose frontmost is true) to (name of front window as text)',
  ]).catch(() => '');

  const windowsText = await execFileText('osascript', [
    '-e',
    'tell application "System Events"\nset outputLines to {}\nrepeat with proc in application processes\ntry\nrepeat with win in windows of proc\nset end of outputLines to (name of proc as text) & "|||" & (name of win as text)\nend repeat\nend try\nend repeat\nset AppleScript\'s text item delimiters to linefeed\nreturn outputLines as text\nend tell',
  ]).catch(() => '');

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
    screenshotPath: await captureScreenshot(runId),
  };
}

async function observeWithHelper(runId) {
  const desktop = await invokeMacOSHelper('observe', { runId });
  return {
    backend: 'helper',
    frontmostApp: desktop.frontmostApp || '',
    frontmostWindowTitle: desktop.frontmostWindowTitle || '',
    windows: Array.isArray(desktop.windows) ? desktop.windows.slice(0, 20) : [],
    screenshotPath: await captureScreenshot(runId),
  };
}

export async function observeMacOSDesktop({ runId }) {
  const capability = getMacOSCapabilityReport();
  const backend = resolveMacOSBackend();
  const desktop =
    backend.type === 'helper'
      ? await observeWithHelper(runId).catch(() => observeWithShell(runId))
      : await observeWithShell(runId);

  return {
    ...desktop,
    capability,
  };
}
