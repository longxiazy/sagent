import { cleanText } from '../../core/utils.ts';
import { getWebView } from './webview-session.ts';

const OBSERVATION_SCRIPT = String.raw`(() => {
  const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 5000);

  return {
    title: document.title,
    url: window.location.href,
    bodyText,
    // 内置 browser 只提供页面信息，不再注入 elementId 或向模型暴露可交互元素。
    elements: [],
  };
})()`;

export function summarizeBrowserObservation(observation) {
  return {
    title: observation.title,
    url: observation.url,
    text: cleanText(observation.bodyText, 320),
    elements: [],
  };
}

export async function captureBrowserObservation(view) {
  const activeView = view || getWebView();
  try {
    return await activeView.evaluate(OBSERVATION_SCRIPT);
  } catch {
    return {
      title: activeView?.title || '',
      url: activeView?.url || '',
      bodyText: '',
      elements: [],
    };
  }
}
