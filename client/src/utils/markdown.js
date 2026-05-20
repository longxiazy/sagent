// Agent/Chat 的回答里可能带 <thinking> 或 <think> 片段。
// 这里先把不同来源的标记统一成同一套语法，后面的展示逻辑才好复用。
export function normalizeThinkTags(content) {
  if (typeof content !== 'string') {
    return '';
  }

  return content.replace(/<thinking>/gi, '<think>').replace(/<\/thinking>/gi, '</think>');
}

export function hasThinkContent(content) {
  return /<think>/i.test(normalizeThinkTags(content));
}

// Assistant 消息可能同时包含"可展示答案"和"可折叠思考过程"。
// 这里把一整段消息拆成多个片段，让 UI 可以分别渲染 markdown/think。
export function splitAssistantContent(content) {
  const normalized = normalizeThinkTags(content);
  if (!normalized) {
    return [];
  }

  const segments = [];
  const pattern = /<think>([\s\S]*?)(<\/think>|$)/gi;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'markdown',
        content: normalized.slice(lastIndex, match.index),
      });
    }

    segments.push({
      type: 'think',
      content: match[1] || '',
      closed: String(match[2] || '').toLowerCase() === '</think>',
    });

    lastIndex = pattern.lastIndex;
    if (!match[2]) {
      break;
    }
  }

  if (lastIndex < normalized.length) {
    segments.push({
      type: 'markdown',
      content: normalized.slice(lastIndex),
    });
  }

  return segments.filter(segment => segment.content);
}

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function inlineFormat(s) {
  let out = escapeHtml(s);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const safe = /^(https?:|mailto:|#|\/)/.test(url) ? url : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  return out;
}

// 这是一个很轻量的 markdown 解析器，目标不是完整支持 GFM，
// 而是覆盖当前产品里最常见的结构：标题、段落、列表、表格、代码块。
// 这样可以避免引入完整 markdown runtime 带来的体积和样式不确定性。
export function renderMarkdown(text) {
  if (!text) return [];
  const blocks = [];
  const lines = text.split('\n');
  let i = 0;

  function parseTable(startIdx) {
    const headerLine = lines[startIdx];
    const sepLine = lines[startIdx + 1];
    if (!sepLine || !/^\|?\s*[-:]+[-|\s:]*\|?\s*$/.test(sepLine)) return null;
    const headers = headerLine.split('|').map(c => c.trim()).filter(Boolean);
    const rows = [];
    let r = startIdx + 2;
    while (r < lines.length && lines[r].includes('|')) {
      rows.push(lines[r].split('|').map(c => c.trim()).filter(Boolean));
      r++;
    }
    return { headers, rows, endIdx: r };
  }

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: 'code', lang, content: codeLines.join('\n') });
      continue;
    }

    // table
    if (line.includes('|')) {
      const table = parseTable(i);
      if (table) {
        blocks.push({ type: 'table', ...table });
        i = table.endIdx;
        continue;
      }
    }

    // heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, content: headingMatch[2] });
      i++;
      continue;
    }

    // unordered list
    if (/^[-*]\s/.test(line)) {
      const items = [];
      while (i < lines.length) {
        if (/^[-*]\s/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, '')); i++; }
        else if (!lines[i].trim()) { i++; }
        else break;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // ordered list
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length) {
        if (/^\d+\.\s/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, '')); i++; }
        else if (!lines[i].trim()) { i++; }
        else break;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // paragraph
    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('```') && !lines[i].match(/^#{1,6}\s/) && !/^[-*]\s/.test(lines[i]) && !/^\d+\.\s/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      blocks.push({ type: 'p', content: paraLines.join('\n') });
    } else {
      i++;
    }
  }

  return blocks;
}

// Assistant 回复里如果包含截图路径，会同时渲染成图片。
// 文本里对应的文件路径会被清理掉，避免在气泡中既显示路径又显示图片。
export function extractScreenshots(text) {
  const screenshots = [];
  const cleaned = text.replace(/(?:\/[^\s\]]*)?\/(data\/screenshots|desktop-agent-observations)\/([^\s\]]+\.png)/g, (_, _base, file) => {
    screenshots.push('/screenshots/' + file);
    return '';
  }).trim();
  return { cleaned, screenshots };
}
