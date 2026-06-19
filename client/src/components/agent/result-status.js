// 单步 result 的成败判定：与后端 agent/core/result-quality.ts 的 FAILURE_PATTERNS 同源，
// 让前端能把「失败/异常的那一步」在时间线上标红，无需后端额外下发逐步状态字段。
//
// ⚠️ 两处正则需同步维护：后端据此把整体质量降级为 done_degraded，前端据此给 StepCard 着色。
// 误报代价仅是多标一个红点，故宁可与后端保持一致，不在前端自行收紧。

const FAILURE_PATTERN = /执行失败|操作失败|访问失败|导航超时|访问超时|timeout|timed out|404 Not Found|403 Forbidden|already running|反爬|验证码|人机验证|安全验证|滑块|页面内容为空|未找到|不存在|撤稿|删除|rate.?limit|429|请求已中断|Web应用防护|Web安全风险|访问不合规|已阻止访问搜索引擎/i;

// result 命中失败模式时返回 true。非字符串/空值视为「无失败信号」。
export function isFailureResult(result) {
  if (!result || typeof result !== 'string') return false;
  return FAILURE_PATTERN.test(result);
}

// 把结果文本切成片段，命中失败关键词的片段标记 hit=true——供前端只高亮关键词，
// 而非整段标红（主体文字保持正常可读）。与 isFailureResult 用同一套模式，口径一致。
export function splitFailureHighlights(text) {
  if (!text || typeof text !== 'string') return [];
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
