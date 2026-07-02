// 单步 result 的成败判定：新 trace 优先使用后端下发的结构化 resultStatus，
// 老 trace 没有 resultStatus 时才回退到文本关键词。
//
// ⚠️ 关键词只用于历史兼容；不要再把它作为新执行的主判定方式，否则会误标
// “未找到明显问题”这类正常结果。

const FAILURE_PATTERN = /执行失败|操作失败|访问失败|导航超时|访问超时|timeout|timed out|404 Not Found|403 Forbidden|already running|反爬|验证码|人机验证|安全验证|滑块|页面内容为空|未找到|不存在|撤稿|删除|rate.?limit|429|请求已中断|Web应用防护|Web安全风险|访问不合规|已阻止访问搜索引擎/i;

function normalizeResultStatus(status) {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (value === 'success' || value === 'failed' || value === 'rejected') return value;
  return '';
}

// 新 trace 有 resultStatus 时按状态返回；旧 trace 没有状态时才用关键词 fallback。
export function isFailureResult(result, resultStatus) {
  const status = normalizeResultStatus(resultStatus);
  if (status) return status === 'failed';
  if (!result || typeof result !== 'string') return false;
  return FAILURE_PATTERN.test(result);
}

// 把结果文本切成片段，命中失败关键词的片段标记 hit=true——供前端只高亮关键词，
// 而非整段标红（主体文字保持正常可读）。与 isFailureResult 用同一套模式，口径一致。
export function splitFailureHighlights(text, resultStatus) {
  if (!text || typeof text !== 'string') return [];
  const status = normalizeResultStatus(resultStatus);
  if (status && status !== 'failed') {
    return [{ text, hit: false }];
  }
  const re = new RegExp(FAILURE_PATTERN.source, 'gi');
  const parts = [];
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), hit: false });
    parts.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (re.lastIndex === m.index) re.lastIndex++; // 防零宽匹配死循环
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}

// 结果文本若包含截图路径，提取成可访问的 /screenshots/ URL（供结果区显示缩略图）。
const RESULT_SCREENSHOT_RE = /(?:\/[^\s\]]*)?\/(data\/screenshots|desktop-agent-observations)\/([^\s\]]+\.png)/;
export function resultScreenshot(result) {
  if (!result || typeof result !== 'string') return null;
  const m = result.match(RESULT_SCREENSHOT_RE);
  return m ? '/screenshots/' + m[2] : null;
}
