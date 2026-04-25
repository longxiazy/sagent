import { execFile } from 'node:child_process';

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

export async function executeBrowserAction(page, action) {
  try {
    return await _executeBrowserAction(page, action);
  } catch (err) {
    const msg = err.message || String(err);
    if (/timeout|waiting for|not found|selector/i.test(msg)) {
      return `浏览器操作失败: ${msg.slice(0, 200)}。可能原因: 元素不存在或页面未加载完成，请重新观察页面后使用 observation 中存在的 elementId。`;
    }
    throw err;
  }
}

async function _executeBrowserAction(page, action) {
  if (action.type === 'navigate') {
    await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return `已打开 ${action.url}`;
  }

  if (action.type === 'google_search') {
    const query = action.query || '';
    if (!query) throw new Error('google_search 缺少 query');
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await execFileText('open', [url]);
    // Wait for browser to load
    await new Promise(resolve => setTimeout(resolve, 4000));
    return `已在默认浏览器打开 Google 搜索: "${query}"。请使用 capture_screen 截图查看结果。`;
  }

  if (action.type === 'click') {
    if (!action.elementId) {
      throw new Error('click 缺少 elementId');
    }

    const locator = page.locator(`[data-agent-node-id="${action.elementId}"]`).first();
    await locator.waitFor({ state: 'visible', timeout: 10000 });
    await locator.click({ timeout: 10000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(600);
    return `已点击元素 ${action.elementId}`;
  }

  if (action.type === 'type') {
    if (!action.elementId) {
      throw new Error('type 缺少 elementId');
    }

    const locator = page.locator(`[data-agent-node-id="${action.elementId}"]`).first();
    await locator.waitFor({ state: 'visible', timeout: 10000 });
    await locator.click({ timeout: 10000 });

    const tagName = await locator.evaluate(element => element.tagName.toLowerCase());
    const isEditable = await locator.evaluate(element => element.isContentEditable);

    if (tagName === 'input' || tagName === 'textarea') {
      await locator.fill(action.text, { timeout: 10000 });
    } else if (isEditable) {
      await locator.evaluate((element, text) => {
        element.focus();
        element.textContent = text;
      }, action.text);
    } else {
      throw new Error(`元素 ${action.elementId} 不可输入`);
    }

    if (action.submit) {
      await locator.press('Enter').catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(600);
    }

    return `已在元素 ${action.elementId} 输入内容`;
  }

  if (action.type === 'wait') {
    await page.waitForTimeout(action.seconds * 1000);
    return `已等待 ${action.seconds} 秒`;
  }

  if (action.type === 'scroll') {
    const pixels = (action.amount || 3) * 300;
    if (action.direction === 'up') {
      await page.evaluate(n => window.scrollBy(0, -n), pixels);
    } else {
      await page.evaluate(n => window.scrollBy(0, n), pixels);
    }
    await page.waitForTimeout(400);
    return `已向${action.direction === 'up' ? '上' : '下'}滚动 ${action.amount || 3} 步`;
  }

  if (action.type === 'get_page_content') {
    const text = await page.evaluate(() => document.body.innerText);
    return text.slice(0, 12000) || '页面内容为空';
  }

  if (action.type === 'finish') {
    return action.answer || '任务已完成';
  }

  throw new Error(`不支持的动作类型: ${action.type}`);
}
