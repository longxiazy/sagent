import { execFile } from 'node:child_process';
import { invokeMacOSHelper, resolveMacOSBackend } from './helper-client.ts';
import { observeMacOSDesktop } from './observe.ts';

function sanitizeApplescriptString(s) {
  return String(s || '').replace(/[\\"]/g, '\\$&');
}

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

async function runAppleScript(lines) {
  const args = lines.flatMap(line => ['-e', line]);
  return execFileText('osascript', args);
}

function getAppleScriptKeyCode(key) {
  const keyName = String(key || '').trim().toLowerCase();
  if (keyName === 'enter' || keyName === 'return') {
    return 36;
  }
  if (keyName === 'tab') {
    return 48;
  }
  if (keyName === 'space') {
    return 49;
  }
  if (keyName === 'escape' || keyName === 'esc') {
    return 53;
  }
  if (keyName === 'left') {
    return 123;
  }
  if (keyName === 'right') {
    return 124;
  }
  if (keyName === 'down') {
    return 125;
  }
  if (keyName === 'up') {
    return 126;
  }
  return null;
}

async function executeWithShell(action, context) {
  if (action.type === 'open_app') {
    try {
      await execFileText('open', ['-a', action.app]);
      return `已打开应用 ${action.app}`;
    } catch (err) {
      const msg = err?.message || String(err);
      // error -54 = 沙箱限制；error -10810 = 应用无法启动
      if (/error -54|sandbox|permission denied|operation not permitted/i.test(msg)) {
        return `无法打开 ${action.app}（沙箱环境限制）。建议使用 notify_user 告知用户手动打开，或使用 terminal run_confirmed 执行 open 命令。`;
      }
      return `打开 ${action.app} 失败: ${msg.slice(0, 150)}。建议使用 notify_user 告知用户手动操作。`;
    }
  }

  if (action.type === 'activate_app') {
    await runAppleScript([`tell application "${sanitizeApplescriptString(action.app)}" to activate`]);
    return `已切换到应用 ${action.app}`;
  }

  if (action.type === 'list_windows') {
    const desktop = await observeMacOSDesktop({ runId: context?.runId });
    const lines = desktop.windows.map(window => `${window.app} - ${window.title}`).join('\n');
    return lines ? `当前窗口列表:\n${lines}` : '当前未获取到窗口列表';
  }

  if (action.type === 'capture_screen') {
    const desktop = await observeMacOSDesktop({ runId: context?.runId });
    return `已捕获屏幕截图: ${desktop.screenshotPath}`;
  }

  if (action.type === 'type_text') {
    await runAppleScript([
      'tell application "System Events"',
      `keystroke ${JSON.stringify(action.text)}`,
      'end tell',
    ]);
    return '已通过系统键盘输入文本';
  }

  if (action.type === 'press_key') {
    const modifiers = Array.isArray(action.modifiers) && action.modifiers.length > 0
      ? ` using {${action.modifiers.map(item => `${item} down`).join(', ')}}`
      : '';
    const keyCode = getAppleScriptKeyCode(action.key);
    await runAppleScript([
      'tell application "System Events"',
      keyCode == null
        ? `keystroke ${JSON.stringify(action.key)}${modifiers}`
        : `key code ${keyCode}${modifiers}`,
      'end tell',
    ]);
    return `已发送按键 ${action.key}`;
  }

  if (action.type === 'click_at') {
    throw new Error('shell backend 不支持 click_at，请配置 macOS helper');
  }

  throw new Error(`不支持的 macOS 动作: ${action.type}`);
}

async function executeWithHelper(action: any, context: any) {
  if (action.type === 'list_windows') {
    const desktop = await invokeMacOSHelper('observe', {
      runId: context?.runId,
    });
    const lines = (desktop.windows || []).slice(0, 20).map(window => `${window.app} - ${window.title}`).join('\n');
    return lines ? `当前窗口列表:\n${lines}` : '当前未获取到窗口列表';
  }

  if (action.type === 'capture_screen') {
    const desktop = await observeMacOSDesktop({ runId: context?.runId });
    return `已捕获屏幕截图: ${desktop.screenshotPath}`;
  }

  const response = await invokeMacOSHelper(action.type, action);
  return response?.message || `已执行 ${action.type}`;
}

export async function executeMacOSAction(action, context = {}) {
  const backend = resolveMacOSBackend();
  if (backend.type === 'helper') {
    return executeWithHelper(action, context).catch(() => executeWithShell(action, context));
  }
  return executeWithShell(action, context);
}
