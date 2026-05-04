import { getWebView } from './webview-session.ts';

const ACTION_SETTLE_MS = 600;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function elementSelector(elementId) {
  const id = String(elementId).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[data-agent-node-id="${id}"]`;
}

function queryElementScript(selector, body) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('元素不存在: ${selector.replace(/'/g, "\\'")}');
    ${body}
  })()`;
}

export async function executeBrowserAction(view, action) {
  try {
    return await _executeBrowserAction(view || getWebView(), action);
  } catch (err) {
    const msg = err.message || String(err);
    if (/timeout|waiting for|not found|selector|元素不存在/i.test(msg)) {
      return `浏览器操作失败: ${msg.slice(0, 200)}。可能原因: 元素不存在或页面未加载完成，请重新观察页面后使用 observation 中存在的 elementId。`;
    }
    if (/execution context was destroyed|net::err_|connection.*closed|navigation/i.test(msg)) {
      return `浏览器操作失败: ${msg.slice(0, 200)}。可能原因: 页面导航失败或连接中断，请尝试重新打开页面或使用其他网站。`;
    }
    throw err;
  }
}

async function _executeBrowserAction(view, action) {
  if (action.type === 'navigate') {
    try {
      await view.navigate(action.url);
      await delay(ACTION_SETTLE_MS);
      return `已打开 ${action.url}`;
    } catch (err) {
      return `无法打开 ${action.url}: ${err.message?.slice(0, 150) || '连接失败'}。请尝试其他网址或使用 fetch 工具。`;
    }
  }

  if (action.type === 'google_search') {
    const query = action.query || '';
    if (!query) throw new Error('google_search 缺少 query');
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await view.navigate(url);
    await delay(ACTION_SETTLE_MS);
    return `已在浏览器打开 Google 搜索: "${query}"。`;
  }

  if (action.type === 'click') {
    if (!action.elementId) {
      throw new Error('click 缺少 elementId');
    }

    const selector = elementSelector(action.elementId);
    await view.click(selector, { timeout: 10000 });
    await delay(ACTION_SETTLE_MS);
    return `已点击元素 ${action.elementId}`;
  }

  if (action.type === 'type') {
    if (!action.elementId) {
      throw new Error('type 缺少 elementId');
    }

    const selector = elementSelector(action.elementId);
    const elementInfo = await view.evaluate(queryElementScript(selector, `
      return {
        tagName: element.tagName.toLowerCase(),
        isEditable: Boolean(element.isContentEditable),
      };
    `));

    await view.click(selector, { timeout: 10000 });

    if (elementInfo.tagName === 'input' || elementInfo.tagName === 'textarea') {
      await view.evaluate(queryElementScript(selector, `
        element.focus();
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
      `));
      await view.type(selector, action.text || '');
    } else if (elementInfo.isEditable) {
      await view.evaluate(queryElementScript(selector, `
        element.focus();
        element.textContent = '';
      `));
      await view.type(selector, action.text || '');
    } else {
      throw new Error(`元素 ${action.elementId} 不可输入`);
    }

    if (action.submit) {
      await view.press('Enter');
      await delay(ACTION_SETTLE_MS);
    }

    return `已在元素 ${action.elementId} 输入内容`;
  }

  if (action.type === 'wait') {
    await delay(action.seconds * 1000);
    return `已等待 ${action.seconds} 秒`;
  }

  if (action.type === 'scroll') {
    const pixels = (action.amount || 3) * 300;
    const signedPixels = action.direction === 'up' ? -pixels : pixels;
    await view.evaluate(`window.scrollBy(0, ${signedPixels})`);
    await delay(400);
    return `已向${action.direction === 'up' ? '上' : '下'}滚动 ${action.amount || 3} 步`;
  }

  if (action.type === 'get_page_content') {
    const text = await view.evaluate("document.body?.innerText || ''");
    return text.slice(0, 12000) || '页面内容为空';
  }

  if (action.type === 'finish') {
    return action.answer || '任务已完成';
  }

  throw new Error(`不支持的动作类型: ${action.type}`);
}
