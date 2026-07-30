// 从任务文本中剥离 [附件] 块，供聊天记录渲染缩略图。
//
// 发给模型的任务文本由 App.jsx 的 buildTaskWithAttachments 拼成，形如：
//   <用户正文>
//
//   [附件]
//   - 图片: @uploads/<日期>/<文件名>(请用 image_analyze 工具分析)
//
// 这段文本必须原样发给模型（runtime 依赖 @uploads 行绑定真实路径），所以只能在
// 展示时还原：把附件行摘出来渲染成缩略图，正文照常显示。
//
// 识别锚点是 @uploads/<日期>/<文件名> 这个结构，而不是「[附件]」「- 图片:」这类
// 自然语言——后者有中英两套模板且会随文案调整，路径格式则由上传接口固定生成。

// 上传落盘时文件名被加上 `<时间戳>-<随机 6 位十六进制>-` 前缀（见 routes/agent-uploads.ts），
// 展示时剥掉，让用户看到自己原本的文件名。
const UPLOAD_NAME_PREFIX_RE = /^\d{10,}-[0-9a-f]{6}-/;

// 日期段固定为 YYYY-MM-DD；文件名段不含路径分隔符与括号。排除括号是因为中文模板
// 把工具提示紧贴在路径后面（`{path}(请用…)`），贪婪匹配会把提示语吞进文件名。
const UPLOAD_PATH_RE = /@uploads\/(\d{4}-\d{2}-\d{2})\/([^\s/\\()（）]+)/;

// 附件块的标题行。剥掉附件行后若只剩标题，标题也没有存在意义。
const BLOCK_HEADER_RE = /^\[(?:附件|Attachments)\]$/;

function displayName(fileName) {
  const decoded = decodeName(fileName);
  return decoded.replace(UPLOAD_NAME_PREFIX_RE, '') || decoded;
}

// 文件名可能含被编码过的字符；解不开就按原样用，不要因此丢掉整个附件。
function decodeName(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 把任务文本拆成「正文」与「附件列表」。
 *
 * 无附件时原样返回入参字符串，调用方可据此走原有的纯文本渲染路径。
 * 同一路径重复出现只保留一次，避免同图渲染出多个缩略图。
 */
export function parseTaskAttachments(content) {
  if (typeof content !== 'string' || !content.includes('@uploads/')) {
    return { text: typeof content === 'string' ? content : '', attachments: [] };
  }

  const attachments = [];
  const seen = new Set();
  const keptLines = [];

  for (const line of content.split('\n')) {
    const match = line.match(UPLOAD_PATH_RE);
    // 只有「整行就是一条附件记录」才剥离。正文里顺带提到路径时该行还有别的内容，
    // 剥掉会丢失用户自己写的文字，此时宁可原样保留。
    if (match && isAttachmentLine(line, match)) {
      const [, date, fileName] = match;
      const path = `@uploads/${date}/${fileName}`;
      if (!seen.has(path)) {
        seen.add(path);
        attachments.push({ path, date, file: fileName, name: displayName(fileName) });
      }
      continue;
    }
    keptLines.push(line);
  }

  if (attachments.length === 0) {
    return { text: content, attachments: [] };
  }

  return { text: stripEmptyBlocks(keptLines), attachments };
}

// 附件行的形态是「前缀标签 + 路径 + 可选的工具提示」，其中标签与提示都由 i18n 决定。
// 与其匹配具体文案，不如要求路径前面只有短标签、后面只有括号补充，
// 这样中英文模板都能覆盖，而正文里的长句子不会被误伤。
function isAttachmentLine(line, match) {
  const before = line.slice(0, match.index).trim();
  const after = line.slice(match.index + match[0].length).trim();
  const beforeOk = before === '' || (before.startsWith('-') && before.length <= 12);
  const afterOk = after === '' || /^[(（].*[)）]$/.test(after);
  return beforeOk && afterOk;
}

// 附件行移除后，原来的 [附件] 标题会变成孤立行；连带它和由此产生的多余空行一起清掉，
// 使正文回到用户当初输入的样子。
function stripEmptyBlocks(lines) {
  const result = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (BLOCK_HEADER_RE.test(line.trim())) {
      // 标题后面若还有非空内容，说明块里剩了别的东西，标题得留着。
      const hasContent = lines.slice(i + 1).some(rest => rest.trim() !== '');
      if (!hasContent) break;
    }
    result.push(line);
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 把 @uploads/<日期>/<文件名> 转成可直接放进 <img src> 的后端读取地址。
 *
 * 该接口在受保护路径下，但同源请求会自动带上会话 cookie，因此 <img> 无需额外鉴权头。
 */
export function buildUploadUrl(uploadPath, projectId) {
  const match = String(uploadPath || '').match(UPLOAD_PATH_RE);
  if (!match) return null;
  const [, date, fileName] = match;
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return `/api/uploads/${encodeURIComponent(date)}/${encodeURIComponent(fileName)}${query}`;
}
