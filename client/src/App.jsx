import { useEffect, useRef, useState, Component, useMemo } from 'react';
import {
  Menu, Timer, Trash2, Square, Brain, ChevronDown, ChevronUp,
  Copy, Check, Send,
} from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import 'highlight.js/styles/github.css';
import './App.css';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('sql', sql);

class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#991b1b', fontSize: 14 }}>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>页面渲染出错</p>
          <p style={{ color: '#6b7280', marginBottom: 12 }}>{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 4, background: '#fff', cursor: 'pointer' }}
          >重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const API_URL = '/api/chat';
const AGENT_API_URL = '/api/agent';
const AGENT_APPROVAL_API_URL = '/api/agent/approvals';

const DEFAULT_MODELS = [
  { id: 'minimaxai/minimax-m2.7', label: 'MiniMax M2.7' },
];

const SUGGESTIONS = {
  chat: [
    { title: '解释概念', text: '解释一下量子计算的基本原理' },
    { title: '写代码', text: '用 Python 写一个快速排序算法' },
    { title: '写邮件', text: '帮我写一封请假邮件，事由是家中有急事' },
    { title: '技术对比', text: '对比 React 和 Vue 的优缺点' },
  ],
  agent: [
    { title: '查看文件', text: '查看当前目录的文件结构' },
    { title: '搜索天气', text: '打开浏览器搜索今天的天气' },
    { title: '读取文档', text: '读取 README.md 并总结内容' },
    { title: '屏幕截图', text: '截取当前屏幕截图' },
    { title: '网页摘要', text: '抓取 https://example.com 的内容并总结要点' },
    { title: '搜索新闻', text: '搜索最新的 AI 技术新闻，汇总前 5 条' },
    { title: '执行脚本', text: '运行 node -e "console.log(process.version)" 查看当前 Node 版本' },
    { title: '分析代码', text: '搜索项目中所有的 TODO 注释并列出来' },
  ],
};

const LEGACY_MESSAGES_KEY = 'nvidia_chat_messages';
const LEGACY_MODEL_KEY = 'nvidia_chat_model';
const SESSIONS_KEY = 'nvidia_chat_sessions';
const ACTIVE_SESSION_KEY = 'nvidia_chat_active_session';
const LAST_MODE_KEY = 'nvidia_chat_last_mode';

function generateSessionId() {
  return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMessages(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .map(item => ({
      role: item.role,
      content: item.content,
      ...(item.ts ? { ts: item.ts } : {}),
    }));
}

function createSession({
  id = generateSessionId(),
  messages = [],
  model,
  agentTrace = [],
  createdAt = Date.now(),
  updatedAt = Date.now(),
} = {}) {
  return {
    id,
    messages: normalizeMessages(messages),
    model: model || DEFAULT_MODELS[0].id,
    agentTrace: Array.isArray(agentTrace) ? agentTrace : [],
    createdAt,
    updatedAt,
  };
}

function normalizeChatState(rawState) {
  const sessions = Array.isArray(rawState?.sessions)
    ? rawState.sessions
        .map(session => {
          if (!session || typeof session !== 'object') {
            return null;
          }

          return createSession({
            id: typeof session.id === 'string' && session.id ? session.id : undefined,
            messages: session.messages,
            model: session.model,
            agentTrace: session.agentTrace,
            createdAt: Number.isFinite(session.createdAt) ? session.createdAt : Date.now(),
            updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : Date.now(),
          });
        })
        .filter(Boolean)
    : [];

  const nextSessions = sessions.length > 0 ? sessions : [createSession()];
  const activeSessionId = nextSessions.some(session => session.id === rawState?.activeSessionId)
    ? rawState.activeSessionId
    : nextSessions[0].id;

  return { sessions: nextSessions, activeSessionId };
}

function loadChatState() {
  try {
    const storedSessions = JSON.parse(localStorage.getItem(SESSIONS_KEY) || 'null');
    if (Array.isArray(storedSessions) && storedSessions.length > 0) {
      return normalizeChatState({
        sessions: storedSessions,
        activeSessionId: localStorage.getItem(ACTIVE_SESSION_KEY),
      });
    }
  } catch {
    // ignore malformed storage and fall back to migration/default state
  }

  let legacyMessages = [];
  try {
    legacyMessages = JSON.parse(localStorage.getItem(LEGACY_MESSAGES_KEY) || '[]');
  } catch {
    legacyMessages = [];
  }

  const migratedSession = createSession({
    messages: legacyMessages,
    model: localStorage.getItem(LEGACY_MODEL_KEY) || DEFAULT_MODELS[0].id,
  });

  return normalizeChatState({
    sessions: [migratedSession],
    activeSessionId: migratedSession.id,
  });
}

function touchSession(session, patch = {}) {
  return {
    ...session,
    ...patch,
    updatedAt: Date.now(),
  };
}

function getSessionTitle(messages) {
  const firstUserMessage = messages.find(item => item.role === 'user' && item.content.trim());
  if (!firstUserMessage) {
    return '新对话';
  }

  const text = firstUserMessage.content.replace(/\s+/g, ' ').trim();
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}

function getSessionPreview(messages) {
  const lastMessage = [...messages].reverse().find(item => item.content.trim());
  if (!lastMessage) {
    return '暂无消息';
  }

  const text = lastMessage.content.replace(/\s+/g, ' ').trim();
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

function formatSessionTime(value) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function formatMsgTime(ts) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(ts);
}

async function streamSseJson({ url, body, signal, onEvent }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    try {
      const parsed = JSON.parse(errorText);
      throw new Error(parsed.error || `HTTP ${res.status}`);
    } catch (parseErr) {
      if (parseErr.message && !parseErr.message.startsWith('HTTP')) throw parseErr;
      throw new Error(errorText || `HTTP ${res.status}`);
    }
  }

  if (!res.body) {
    throw new Error('响应流不可用');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleEvent = async rawEvent => {
    const line = rawEvent
      .split('\n')
      .map(item => item.trim())
      .find(item => item.startsWith('data: '));

    if (!line) {
      return;
    }

    const json = JSON.parse(line.slice(6));
    if (json.error && !json.type) {
      throw new Error(json.error);
    }
    await onEvent?.(json);
  };

  const flushBuffer = async final => {
    const events = buffer.split('\n\n');
    buffer = final ? '' : events.pop() ?? '';
    for (const rawEvent of events) {
      if (rawEvent.trim()) {
        await handleEvent(rawEvent);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    await flushBuffer(false);
  }

  buffer += decoder.decode();
  await flushBuffer(true);
}

async function streamChatCompletion({
  messages,
  model,
  signal,
  temperature = 1,
  top_p = 0.95,
  max_tokens = 8192,
  onContent,
  onDone,
}) {
  let donePayload = null;

  await streamSseJson({
    url: API_URL,
    body: { messages, model, temperature, top_p, max_tokens },
    signal,
    onEvent(json) {
      if (json.content) {
        onContent?.(json.content);
      }
      if (json.done) {
        donePayload = json;
        onDone?.(json);
      }
    },
  });

  return donePayload;
}

async function streamAgentRun({ task, model, models, strategy, headless, memory, signal, onEvent, messages }) {
  let runId = null;
  let gotDone = false;

  const wrappedEvent = (event) => {
    if (event.runId) runId = event.runId;
    if (event.type === 'done' || event.type === 'error') gotDone = true;
    onEvent(event);
  };

  try {
    await streamSseJson({
      url: AGENT_API_URL,
      body: { task, model, models, strategy, headless, memory, messages },
      signal,
      onEvent: wrappedEvent,
    });
  } catch {
    // initial POST may fail/disconnect, fall through to reconnect
  }

  // If SSE disconnected before done, reconnect to the stream
  if (!gotDone && runId && !signal.aborted) {
    try {
      const res = await fetch(`/api/agent/stream/${runId}`, { signal });
      if (!res.ok) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const dataLine = line.replace(/^data:\s*/, '');
          if (!dataLine || dataLine === '[DONE]') continue;
          try {
            const event = JSON.parse(dataLine);
            wrappedEvent(event);
          } catch { /* skip malformed */ }
        }
      }
    } catch {
      // reconnect also failed
    }
  }
}

async function submitAgentApproval({ runId, approvalId, decision }) {
  const res = await fetch(AGENT_APPROVAL_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, approvalId, decision }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(errorText || `HTTP ${res.status}`);
  }

  return res.json();
}

async function submitAgentQuestion({ runId, approvalId, response }) {
  const res = await fetch('/api/agent/question', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, approvalId, response }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(errorText || `HTTP ${res.status}`);
  }

  return res.json();
}

const PANEL_MIN = 280;
const PANEL_MAX_RATIO = 0.7;
const PANEL_SIZE_KEY = 'agent_panel_width';

function ResizeDivider() {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = e => {
    if (window.innerWidth < 1200) return;
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    const panel = document.querySelector('.layout-body > .agent-panel-wrap');
    startWidth.current = panel ? panel.getBoundingClientRect().width : 420;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const onMouseMove = e => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const maxW = Math.round(window.innerWidth * PANEL_MAX_RATIO);
      const next = Math.min(Math.max(startWidth.current + delta, PANEL_MIN), maxW);
      localStorage.setItem(PANEL_SIZE_KEY, String(next));
      const panel = document.querySelector('.layout-body > .agent-panel-wrap');
      if (panel) panel.style.flex = `0 0 ${next}px`;
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return <div className="resize-divider" onMouseDown={onMouseDown} />;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handle = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={handle} title="复制">
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function normalizeThinkTags(content) {
  if (typeof content !== 'string') {
    return '';
  }

  return content.replace(/<thinking>/gi, '<think>').replace(/<\/thinking>/gi, '</think>');
}

function hasThinkContent(content) {
  return /<think>/i.test(normalizeThinkTags(content));
}

function splitAssistantContent(content) {
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

function CodeBlock({ language, children, ...props }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && language && hljs.getLanguage(language)) {
      hljs.highlightElement(ref.current);
    }
  }, [children, language]);
  return (
    <pre className="code-block" {...props}>
      <code ref={ref} className={language ? `hljs language-${language}` : ''}>
        {children}
      </code>
    </pre>
  );
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineFormat(s) {
  let out = escapeHtml(s);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const safe = /^(https?:|mailto:|#|\/)/.test(url) ? url : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  return out;
}

function renderMarkdown(text) {
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
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // ordered list
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
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

function MarkdownBlock({ content, className = '', showCursor = false }) {
  const blocks = useMemo(() => renderMarkdown(content), [content]);
  return (
    <div className={className ? `md-body ${className}` : 'md-body'}>
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'code':
            return <CodeBlock key={idx} language={block.lang}>{block.content}</CodeBlock>;
          case 'heading':
            const Tag = `h${block.level}`;
            return <Tag key={idx} dangerouslySetInnerHTML={{ __html: inlineFormat(block.content) }} />;
          case 'p':
            return <p key={idx} dangerouslySetInnerHTML={{ __html: inlineFormat(block.content) }} />;
          case 'ul':
            return <ul key={idx}>{block.items.map((item, j) => <li key={j} dangerouslySetInnerHTML={{ __html: inlineFormat(item) }} />)}</ul>;
          case 'ol':
            return <ol key={idx}>{block.items.map((item, j) => <li key={j} dangerouslySetInnerHTML={{ __html: inlineFormat(item) }} />)}</ol>;
          case 'table':
            return (
              <table key={idx}>
                <thead><tr>{block.headers.map((h, j) => <th key={j} dangerouslySetInnerHTML={{ __html: inlineFormat(h) }} />)}</tr></thead>
                <tbody>{block.rows.map((row, j) => <tr key={j}>{row.map((cell, k) => <td key={k} dangerouslySetInnerHTML={{ __html: inlineFormat(cell) }} />)}</tr>)}</tbody>
              </table>
            );
          case 'hr':
            return <hr key={idx} />;
          default:
            return null;
        }
      })}
      {showCursor && <span className="cursor" />}
    </div>
  );
}

function ThinkBlock({ content, closed, showCursor }) {
  const preview = content.replace(/\s+/g, ' ').trim();

  return (
    <details className={`think-block ${closed ? 'ready' : 'streaming'}`} open={!closed || showCursor}>
      <summary className="think-summary">
        <span className="think-summary-badge">THINK</span>
        <span className="think-summary-copy">
          <strong>{closed ? '思考过程' : '思考中'}</strong>
          <span>{preview ? (preview.length > 72 ? `${preview.slice(0, 72)}…` : preview) : '正在组织思路…'}</span>
        </span>
        <span className={`think-summary-meta ${closed ? 'ready' : 'running'}`}>{closed ? '展开' : '更新中'}</span>
      </summary>

      <div className="think-body">
        <MarkdownBlock className="think-content" content={content || '正在组织思路…'} showCursor={showCursor && !closed} />
      </div>
    </details>
  );
}

function extractScreenshots(text) {
  const screenshots = [];
  // Match any path containing data/screenshots/xxx.png or desktop-agent-observations/xxx.png
  const cleaned = text.replace(/(?:\/[^\s\]]*)?\/(data\/screenshots|desktop-agent-observations)\/([^\s\]]+\.png)/g, (_, _base, file) => {
    screenshots.push('/screenshots/' + file);
    return '';
  }).trim();
  return { cleaned, screenshots };
}

function ScreenshotImages({ urls }) {
  if (!urls.length) return null;
  return (
    <div className="chat-screenshots">
      {urls.map((url, i) => (
        <img key={i} className="chat-screenshot-img" src={url} alt={`screenshot-${i}`} />
      ))}
    </div>
  );
}

function MessageContent({ role, content, showCursor }) {
  if (role === 'user') {
    return <span >{content}</span>;
  }

  const { cleaned, screenshots } = extractScreenshots(content);
  const displayContent = cleaned || content;

  const segments = splitAssistantContent(displayContent);
  const hasThink = segments.some(segment => segment.type === 'think');

  const textBlock = !hasThink
    ? <MarkdownBlock content={displayContent} showCursor={showCursor} />
    : (
      <div className="assistant-sections">
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          if (segment.type === 'think') {
            return <ThinkBlock key={`think-${index}`} content={segment.content} closed={segment.closed} showCursor={showCursor && isLast} />;
          }
          return (
            <div key={`markdown-${index}`} className="assistant-answer">
              <MarkdownBlock content={segment.content} showCursor={showCursor && isLast} />
            </div>
          );
        })}
      </div>
    );

  return (
    <>
      {textBlock}
      <ScreenshotImages urls={screenshots} />
    </>
  );
}

function ResetDialog({ onConfirm, onCancel }) {
  return (
    <div className="dialog-mask">
      <div className="dialog">
        <p className="dialog-title">清空当前会话内容？</p>
        <p className="dialog-desc">当前会话会保留，但消息记录会被移除。</p>
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onCancel}>
            取消
          </button>
          <button className="dialog-btn confirm" onClick={onConfirm}>
            清空
          </button>
        </div>
      </div>
    </div>
  );
}

function ApprovalDialog({ approval, submitting, onApprove, onReject }) {
  if (!approval) {
    return null;
  }

  return (
    <div className="dialog-mask">
      <div className="dialog approval-dialog">
        <p className="approval-eyebrow">需要确认</p>
        <p className="dialog-title">Step {approval.step} 请求执行敏感操作</p>
        <p className="dialog-desc">{approval.message}</p>
        <pre className="agent-json approval-json">{JSON.stringify(approval.action, null, 2)}</pre>
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onReject} disabled={submitting}>
            拒绝
          </button>
          <button className="dialog-btn confirm approval-confirm" onClick={onApprove} disabled={submitting}>
            {submitting ? '提交中…' : '批准'}
          </button>
        </div>
      </div>
    </div>
  );
}

function QuestionDialog({ question, submitting, onSubmit, onSkip }) {
  const [response, setResponse] = useState('');
  if (!question) return null;

  return (
    <div className="dialog-mask">
      <div className="dialog approval-dialog">
        <p className="approval-eyebrow">Agent 提问</p>
        <p className="dialog-title">Step {question.step} 需要你的回答</p>
        <p className="dialog-desc">{question.message}</p>
        <textarea
          className="system-textarea"
          value={response}
          onChange={e => setResponse(e.target.value)}
          placeholder="输入你的回答..."
          rows={3}
          autoFocus
        />
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onSkip} disabled={submitting}>
            跳过
          </button>
          <button
            className="dialog-btn confirm approval-confirm"
            onClick={() => onSubmit(response)}
            disabled={submitting || !response.trim()}
          >
            {submitting ? '提交中…' : '回答'}
          </button>
        </div>
      </div>
    </div>
  );
}


function SessionList({ sessions, activeSessionId, modelList, onCreate, onDelete, onClearAll, onSelect, locked }) {
  return (
    <aside className="session-panel">
      <div className="session-panel-header">
        <h2 className="session-panel-title">会话</h2>
        <button className="session-create-btn" onClick={onCreate} disabled={locked} title="新建会话">
          + 新建
        </button>
      </div>

      <div className="session-list">
        {sessions.map(session => {
          const active = session.id === activeSessionId;
          const modelLabel = modelList.find(item => item.id === session.model)?.label || session.model;

          return (
            <div key={session.id} className={`session-card ${active ? 'active' : ''}`}>
              <button className="session-main" onClick={() => onSelect(session.id)} disabled={locked || active}>
                <span className="session-card-title">{getSessionTitle(session.messages)}</span>
                <span className="session-card-meta">{modelLabel} · {session.messages.length} 条</span>
              </button>

              {sessions.length > 1 && (
                <button
                  className="session-delete-btn"
                  onClick={() => onDelete(session.id)}
                  disabled={locked}
                  title="删除会话"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {sessions.length > 1 && (
        <button className="session-clear-all-btn" onClick={onClearAll} disabled={locked}>清空全部</button>
      )}
    </aside>
  );
}

function getModelLabel(modelId, modelList) {
  const found = modelList.find(m => m.id === modelId);
  return found ? found.label : modelId.split('/').pop();
}

const PLAN_STAGE_LABELS = {
  thinking: '思考中…',
  success: '完成',
  winner: '采纳',
  failed: '失败',
  discarded: '已丢弃',
  abandoned: '放弃',
  cancelled: '已取消',
  consensus: '共识',
};

const PLAN_STAGE_ICON = {
  thinking: '⏳',
  success: '✓',
  winner: '👑',
  failed: '✗',
  discarded: '…',
  abandoned: '—',
  cancelled: '⊘',
  consensus: '🏆',
};

function ModelPlanCard({ event, isWinner, modelList, strategy, result }) {
  const label = getModelLabel(event.model, modelList);
  const stage = event.stage;
  const [showReasoning, setShowReasoning] = useState(false);

  if (stage === 'start') return null;

  return (
    <div className={`model-card ${stage} ${isWinner ? 'winner' : ''}`}>
      <div className="model-card-head">
        <span className="model-card-icon">{PLAN_STAGE_ICON[stage] || '·'}</span>
        <span className="model-card-label">{label}</span>
        <span className={`model-card-status ${stage}`}>{PLAN_STAGE_LABELS[stage] || stage}</span>
      </div>
      {stage === 'thinking' && (
        <div className="model-card-body">
          <div className="model-card-thinking">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
          </div>
        </div>
      )}
      {(stage === 'winner' || stage === 'success') && event.rationale && (
        <div className="model-card-body">
          <p>{event.rationale}</p>
          {event.reasoning && (
            <div className="model-card-reasoning">
              <button className="model-card-reasoning-toggle" onClick={() => setShowReasoning(v => !v)}>
                思考过程 {showReasoning ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              </button>
              {showReasoning && (
                <pre className="model-card-reasoning-text">{event.reasoning}</pre>
              )}
            </div>
          )}
          <div className="model-card-action-row">
            <span className="model-card-action">{event.action?.tool}.{event.action?.type}</span>
            {event.usage && (
              <span className="model-card-tokens">{event.usage.prompt_tokens + event.usage.completion_tokens} tokens</span>
            )}
          </div>
          <pre className="model-card-json">{JSON.stringify(event.action, null, 2)}</pre>
          {isWinner && result && (
            <div className="model-card-result">
              <span className="model-card-result-label">执行结果</span>
              <p>{result.length > 300 ? result.slice(0, 300) + '…' : result}</p>
            </div>
          )}
        </div>
      )}
      {stage === 'failed' && event.error && (
        <div className="model-card-body">
          <p className="model-card-error">{event.error}</p>
        </div>
      )}
      {stage === 'discarded' && event.rationale && (
        <div className="model-card-body">
          <p className="model-card-discarded">{event.rationale.slice(0, 80)}…</p>
        </div>
      )}
      {stage === 'abandoned' && (
        <div className="model-card-body">
          <p className="model-card-discarded">未完成，已被其他模型抢先</p>
        </div>
      )}
      {stage === 'cancelled' && event.rationale && (
        <div className="model-card-body">
          <p>{event.rationale}</p>
          {event.reasoning && (
            <div className="model-card-reasoning">
              <button className="model-card-reasoning-toggle" onClick={() => setShowReasoning(v => !v)}>
                思考过程 {showReasoning ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              </button>
              {showReasoning && (
                <pre className="model-card-reasoning-text">{event.reasoning}</pre>
              )}
            </div>
          )}
          <div className="model-card-action-row">
            <span className="model-card-action">{event.action?.tool}.{event.action?.type}</span>
            {event.usage && (
              <span className="model-card-tokens">{event.usage.prompt_tokens + event.usage.completion_tokens} tokens</span>
            )}
          </div>
          <pre className="model-card-json">{JSON.stringify(event.action, null, 2)}</pre>
        </div>
      )}
      {stage === 'cancelled' && !event.rationale && (
        <div className="model-card-body">
          <p className="model-card-discarded">任务已取消</p>
        </div>
      )}
    </div>
  );
}

function ModelPlanGroup({ trace, step, models, modelList, running }) {
  let strategyMode = 'race';
  let consensusEvent = null;
  const modelEvents = {};
  let stepResult = null;
  let stepAction = null;

  // Collect ALL model_plan events + step result for this step from the entire trace
  for (const e of trace) {
    if (e.step !== step) continue;
    if (e.type === 'model_plan') {
      if (e.stage === 'start') {
        strategyMode = e.strategy || 'race';
        continue;
      }
      if (e.stage === 'consensus') {
        consensusEvent = e;
        continue;
      }
      modelEvents[e.model] = e;
    } else if (e.type === 'step' && e.stage === 'result') {
      stepResult = e.result;
    } else if (e.type === 'step' && e.stage === 'action') {
      stepAction = e;
    }
  }

  // Agent is truly finished when trace has a terminal event (done/error) for this run
  const agentFinished = !running && trace.some(e => e.type === 'done' || e.type === 'error');

  const winnerModel = consensusEvent?.model || Object.values(modelEvents).find(e => e.stage === 'winner')?.model;

  const getEvent = m => {
    const ev = modelEvents[m];
    if (!ev) return { model: m, stage: agentFinished ? 'cancelled' : 'thinking' };
    if (agentFinished && ev.stage === 'thinking') return { ...ev, stage: 'cancelled' };
    return ev;
  };

  return (
    <div className="model-plan-group">
      <span className="agent-trace-badge plan">
        {strategyMode === 'vote' ? '投票' : '决策'}
      </span>
      <div className="model-plan-cards">
        {models.map(m => (
          <ModelPlanCard
            key={m}
            event={getEvent(m)}
            isWinner={winnerModel === m}
            modelList={modelList}
            strategy={strategyMode}
            result={winnerModel === m ? stepResult : null}
          />
        ))}
      </div>
    </div>
  );
}

function AgentPanel({ mode, running, trace, headless, onHeadlessChange, startedAt, modelList, collapsed, onToggleCollapse }) {
  const traceBottomRef = useRef(null);
  const startTimeRef = useRef(null);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  const showContent = isMobile || !collapsed;
  const pauseRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);

  const lastStep = trace.reduce((max, e) => (e.step != null ? Math.max(max, e.step) : max), 0);
  const doneEvent = trace.find(e => e.type === 'done');
  const doneMeta = doneEvent?.meta || {};

  // Detect if waiting for user question
  const hasPendingQuestion = running && trace.some(e => e.type === 'question_required') &&
    !trace.some(e => e.type === 'user_response');

  const totalTokens = trace.reduce((sum, e) => {
    if (e.usage) {
      return sum + (e.usage.prompt_tokens || 0) + (e.usage.completion_tokens || 0);
    }
    return sum;
  }, 0);

  useEffect(() => {
    if (!running) {
      startTimeRef.current = null;
      pauseRef.current = null;
      return;
    }
    startTimeRef.current = startedAt || Date.now();
    pauseRef.current = null;
    const timer = setInterval(() => {
      if (startTimeRef.current) {
        const paused = pauseRef.current ? Date.now() - pauseRef.current : 0;
        setElapsed(Math.round((Date.now() - startTimeRef.current - paused) / 1000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  // Pause/resume elapsed when waiting for question
  useEffect(() => {
    if (hasPendingQuestion && !pauseRef.current) {
      pauseRef.current = Date.now();
    } else if (!hasPendingQuestion && pauseRef.current) {
      startTimeRef.current += Date.now() - pauseRef.current;
      pauseRef.current = null;
    }
  }, [hasPendingQuestion]);

  useEffect(() => {
    // Only auto-scroll trace on small screens where it has a max-height
    if (window.innerWidth < 1200) {
      traceBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [trace]);

  if (mode !== 'agent') {
    return null;
  }

  const formatElapsed = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m${s < 10 ? '0' : ''}${s}s` : `${s}s`;
  };

  const displayElapsed = running
    ? formatElapsed(elapsed)
    : doneMeta.elapsed_ms
      ? formatElapsed(Math.round(doneMeta.elapsed_ms / 1000))
      : elapsed > 0 ? formatElapsed(elapsed) : '-';

  return (
    <section className={`agent-panel ${!isMobile && collapsed ? 'collapsed' : ''}`}>
      <div className="agent-panel-head" onClick={collapsed && trace.length > 0 ? onToggleCollapse : undefined}>
        <div>
          <p className="agent-panel-eyebrow">Desktop Agent</p>
          <h3 className="agent-panel-title">{running ? '执行中' : '最近一次执行'}</h3>
        </div>
        <div className="agent-metrics">
          {lastStep > 0 && <span className="agent-metric">Step {lastStep}</span>}
          <span className={`agent-metric ${running ? 'agent-metric-timer' : ''}`}>
            {running ? <>{displayElapsed} <Timer size={12} /></> : displayElapsed}
          </span>
          {totalTokens > 0 && (
            <span className="agent-metric agent-metric-tokens">{totalTokens} tokens</span>
          )}
          {!running && doneMeta.step_count && (
            <span className="agent-metric">共 {doneMeta.step_count} 步</span>
          )}
        </div>
        <span className={`agent-status-chip ${running ? 'running' : 'idle'}`}>{running ? 'Running' : 'Idle'}</span>
        <label className="agent-headless-toggle" title={headless ? '浏览器在后台运行' : '浏览器窗口可见'}>
          <input
            type="checkbox"
            checked={headless}
            disabled={running}
            onChange={e => onHeadlessChange(e.target.checked)}
          />
          <span>Headless</span>
        </label>
        {trace.length > 0 && (
          <button className="agent-collapse-btn" onClick={e => { e.stopPropagation(); onToggleCollapse(); }} title={collapsed ? '展开' : '收起'}>
            {collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        )}
      </div>

      {showContent && (
        <>
          <p className="agent-panel-note">
            当前支持 `browser`、`fs`、`terminal`、`macos` 工具。需要确认的动作会在这里暂停，等待你的批准或拒绝。
          </p>

          {trace.length === 0 ? (
            <div className="agent-empty">切到 Agent 模式后输入任务，例如"查看当前目录并告诉我 README 开头写了什么"。</div>
          ) : (
            <div className="agent-trace">
          {(() => {
            // Track which steps have multi-model planning (action/result shown inside cards)
            const multiModelSteps = new Set();
            for (const e of trace) {
              if (e.type === 'model_plan' && e.stage === 'start' && e.models?.length > 1) {
                multiModelSteps.add(e.step);
              }
            }
            return trace.map((event, index) => {
            // model_plan events: only render 'start' as ModelPlanGroup, 'consensus' as standalone
            // (other stages like thinking/success/failed are collected inside ModelPlanGroup)
            if (event.type === 'model_plan' && event.stage !== 'start' && event.stage !== 'consensus') return null;
            if (event.type === 'model_plan' && event.stage === 'start') {
              return <ModelPlanGroup key={`model-plan-step-${event.step || index}`} trace={trace} step={event.step} models={event.models} modelList={modelList} running={running} />;
            }
            // For multi-model steps, skip separate action/result items (shown inside model cards)
            if (event.type === 'step' && (event.stage === 'action' || event.stage === 'result') && multiModelSteps.has(event.step)) {
              return null;
            }
            // Render consensus event as standalone trace item
            if (event.type === 'model_plan' && event.stage === 'consensus') {
              return (
                <div key={`consensus-${event.step || index}`} className="agent-trace-item">
                  <span className="agent-trace-badge consensus">投票</span>
                  <div className="agent-trace-content consensus-content">
                    <div className="consensus-bar">
                      <span className="consensus-badge">
                        {event.consensus?.unanimous ? '全票通过' : `${event.consensus?.agreed}/${event.consensus?.total} 多数`}
                      </span>
                      <span className="consensus-action">{event.consensus?.actionKey}</span>
                      <div className="consensus-votes">
                        {event.consensus?.allResults?.map(r => (
                          <span key={r.model} className={`consensus-vote ${r.actionKey === event.consensus?.actionKey ? 'agree' : 'dissent'}`}>
                            {getModelLabel(r.model, modelList)}: {r.actionKey}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }
            return (
            <div key={`${event.type}-${event.step || index}-${event.stage || index}`} className="agent-trace-item">
              {event.type === 'status' && (
                <>
                  <span className="agent-trace-badge">状态</span>
                  <div className="agent-trace-content">
                    <strong>{event.message}</strong>
                  </div>
                </>
              )}

              {event.type === 'step' && event.stage === 'observe' && (
                <>
                  <span className="agent-trace-badge">观察</span>
                  <div className="agent-trace-content">
                    <strong>Step {event.step}</strong>
                    {event.observation?.desktop?.frontmostApp && (
                      <p>
                        桌面: {event.observation.desktop.frontmostApp}
                        {event.observation.desktop.frontmostWindowTitle ? ` · ${event.observation.desktop.frontmostWindowTitle}` : ''}
                      </p>
                    )}
                    {event.observation?.desktop?.screenshotPath && (() => {
                      const p = event.observation.desktop.screenshotPath;
                      const url = '/screenshots/' + p.split('desktop-agent-observations').pop()?.replace(/^\//, '');
                      return (
                        <details className="screenshot-details">
                          <summary>屏幕截图</summary>
                          <img className="screenshot-img" src={url} alt="screenshot" />
                        </details>
                      );
                    })()}
                    {event.observation?.browser?.title && <p>{event.observation.browser.title}</p>}
                    {event.observation?.browser?.url && <p className="agent-trace-url">{event.observation.browser.url}</p>}
                    {event.observation?.browser?.text && <p>{event.observation.browser.text}</p>}
                    {event.observation?.desktop?.windows?.length > 0 && (
                      <div className="agent-element-list">
                        {event.observation.desktop.windows.slice(0, 6).map((window, windowIndex) => (
                          <span key={`${window.app}-${window.title}-${windowIndex}`} className="agent-element-chip">
                            {window.app} {window.title || 'Untitled'}
                          </span>
                        ))}
                      </div>
                    )}
                    {event.observation?.browser?.elements?.length > 0 && (
                      <div className="agent-element-list">
                        {event.observation.browser.elements.slice(0, 6).map(element => (
                          <span key={element.id} className="agent-element-chip">
                            #{element.id} {element.tag} {element.text || element.href || ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {event.type === 'step' && event.stage === 'action' && (
                <>
                  <span className="agent-trace-badge action">动作</span>
                  <div className="agent-trace-content">
                    <div className="agent-step-header">
                      <strong>
                        Step {event.step} · {event.action?.tool || 'core'}.{event.action?.type}
                      </strong>
                      {event.usage && (
                        <span className="agent-token-badge">
                          {event.usage.prompt_tokens + event.usage.completion_tokens} tokens
                          <span className="agent-token-detail">
                            ↑{event.usage.prompt_tokens} ↓{event.usage.completion_tokens}
                          </span>
                        </span>
                      )}
                    </div>
                    {event.rationale && <p>{event.rationale}</p>}
                    <pre className="agent-json">{JSON.stringify(event.action, null, 2)}</pre>
                  </div>
                </>
              )}

              {event.type === 'step' && event.stage === 'result' && (() => {
                const screenshotMatch = event.result?.match(/(?:\/[^\s\]]*)?\/(data\/screenshots|desktop-agent-observations)\/([^\s\]]+\.png)/);
                if (screenshotMatch) {
                  const url = '/screenshots/' + screenshotMatch[2];
                  return (
                    <>
                      <span className="agent-trace-badge result">结果</span>
                      <div className="agent-trace-content">
                        <strong>Step {event.step}</strong>
                        <details className="screenshot-details" open>
                          <summary>屏幕截图</summary>
                          <img className="screenshot-img" src={url} alt="screenshot" />
                        </details>
                      </div>
                    </>
                  );
                }
                return (
                  <>
                    <span className="agent-trace-badge result">结果</span>
                    <div className="agent-trace-content">
                      <strong>Step {event.step}</strong>
                      <p>{event.result}</p>
                    </div>
                  </>
                );
              })()}

              {event.type === 'done' && (
                <>
                  <span className="agent-trace-badge done">完成</span>
                  <div className="agent-trace-content">
                    <strong>Agent 已完成</strong>
                    {event.meta?.step_count && <span className="agent-trace-meta">共 {event.meta.step_count} 步</span>}
                  </div>
                </>
              )}

              {event.type === 'notification' && (
                <>
                  <span className={`agent-trace-badge ${event.level === 'warning' ? 'error' : event.level === 'discovery' ? 'approval' : 'result'}`}>
                    {event.level === 'warning' ? '警告' : event.level === 'discovery' ? '发现' : '通知'}
                  </span>
                  <div className="agent-trace-content">
                    <p>{event.message}</p>
                  </div>
                </>
              )}

              {event.type === 'user_response' && (
                <>
                  <span className="agent-trace-badge approval">回答</span>
                  <div className="agent-trace-content">
                    <strong>用户回答</strong>
                    <p style={{color: '#888', fontSize: '12px'}}><em>问:</em> {event.question}</p>
                    <p>{event.response}</p>
                  </div>
                </>
              )}

              {event.type === 'approval_required' && (
                <>
                  <span className="agent-trace-badge approval">审批</span>
                  <div className="agent-trace-content">
                    <strong>Step {event.step} 等待批准</strong>
                    <p>{event.message}</p>
                    <pre className="agent-json">{JSON.stringify(event.action, null, 2)}</pre>
                  </div>
                </>
              )}

              {event.type === 'approval_result' && (
                <>
                  <span className={`agent-trace-badge ${event.decision === 'approve' ? 'result' : 'error'}`}>审批</span>
                  <div className="agent-trace-content">
                    <strong>Step {event.step} 审批结果</strong>
                    <p>{event.message}</p>
                  </div>
                </>
              )}

              {event.type === 'error' && (
                <>
                  <span className="agent-trace-badge error">错误</span>
                  <div className="agent-trace-content">
                    <strong>Agent 失败</strong>
                    <p>{event.error}</p>
                  </div>
                </>
              )}
            </div>
            );
          })})()}
          <div ref={traceBottomRef} />
        </div>
      )}
        </>
      )}
    </section>
  );
}

export default function App() {
  const [chatState, setChatState] = useState(loadChatState);
  const [models, setModels] = useState(DEFAULT_MODELS);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState(() => localStorage.getItem(LAST_MODE_KEY) || 'chat');
  const [streaming, setStreaming] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentStopping, setAgentStopping] = useState(false);
  const [agentRunId, setAgentRunId] = useState(null);
  const [reconnectedRun, setReconnectedRun] = useState(false);
  const agentRunIdRef = useRef(null);
  const [agentHeadless, setAgentHeadless] = useState(() => localStorage.getItem('agent_headless') !== 'false');
  const [agentMemory, setAgentMemory] = useState(() => localStorage.getItem('agent_memory') !== 'false');
  const [agentTrace, setAgentTrace] = useState([]);
  const [showReset, setShowReset] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const [agentMobileTab, setAgentMobileTab] = useState('agent');
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [showSessions, setShowSessions] = useState(window.innerWidth >= 768);
  const [agentStartedAt, setAgentStartedAt] = useState(null);
  const [agentModels, setAgentModels] = useState(() => {
    try {
      const saved = localStorage.getItem('agent_models');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  // Filter out models no longer available
  useEffect(() => {
    if (agentModels.length > 0 && models.length > 0) {
      const valid = agentModels.filter(m => models.some(avail => avail.id === m));
      if (valid.length !== agentModels.length) {
        setAgentModels(valid);
        localStorage.setItem('agent_models', JSON.stringify(valid));
      }
    }
  }, [models]);
  const [agentStrategy, setAgentStrategy] = useState(() => localStorage.getItem('agent_strategy') || 'race');

  const abortRef = useRef(null);
  const agentAbortRef = useRef(null);
  const approvalRequestRef = useRef(null);
  const questionRequestRef = useRef(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

  // Fetch available models from backend
  useEffect(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data.models) && data.models.length > 0) {
          setModels(data.models);
          // Fix sessions with models not available on backend
          setChatState(prev => {
            const changed = prev.sessions.some(s => s.model && !data.models.some(m => m.id === s.model));
            if (!changed) return prev;
            const sessions = prev.sessions.map(s => {
              if (s.model && !data.models.some(m => m.id === s.model)) {
                return { ...s, model: data.models[0].id };
              }
              return s;
            });
            return { ...prev, sessions };
          });
        }
      })
      .catch(() => {});
  }, []);

  const { sessions, activeSessionId } = chatState;
  const activeSession = sessions.find(session => session.id === activeSessionId) || sessions[0];
  const messages = activeSession.messages;
  const model = activeSession.model;
  const selectedModelLabel = models.find(item => item.id === model)?.label || model;
  const sessionLocked = streaming || agentRunning;
  const currentModeLabel = mode === 'agent' ? '桌面 Agent' : '普通对话';

  useEffect(() => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    localStorage.setItem(ACTIVE_SESSION_KEY, activeSession.id);
    localStorage.removeItem(LEGACY_MESSAGES_KEY);
    localStorage.removeItem(LEGACY_MODEL_KEY);
  }, [activeSession.id, sessions]);

  useEffect(() => {
    localStorage.setItem(LAST_MODE_KEY, mode);
  }, [mode]);

  // Reconnect to running agent on page refresh
  useEffect(() => {
    const controller = new AbortController();
    let aborted = false;

    // Update current active session without stale closure
    const updateActiveSession = updater => {
      setChatState(prev => {
        const sid = prev.activeSessionId;
        const sessions = prev.sessions.map(session => {
          if (session.id === sid) return updater(session);
          return session;
        });
        return normalizeChatState({ ...prev, sessions });
      });
    };

    (async () => {
      try {
        const res = await fetch('/api/agent/active', { signal: controller.signal });
        if (aborted) return;
        const data = await res.json();
        if (!data.active || aborted) return;

        setAgentRunning(true);
        setReconnectedRun(true);
        setAgentStartedAt(data.startedAt || null);
        setAgentRunId(data.runId);
        agentRunIdRef.current = data.runId;
        setMode('agent');
        agentAbortRef.current = controller;

        // 确保 session 有消息，让 showHero=false 以显示 Agent 面板
        updateActiveSession(session => {
          if (session.messages.length === 0) {
            return touchSession(session, {
              messages: [
                { role: 'user', content: data.task || 'Agent 任务', ts: data.startedAt || Date.now() },
                { role: 'assistant', content: 'Desktop Agent 正在执行任务，已重连…', ts: Date.now() },
              ],
            });
          }
          return session;
        });

        const response = await fetch(`/api/agent/stream/${data.runId}`, { signal: controller.signal });
        if (!response.ok || aborted) {
          setAgentRunning(false);
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const dataLine = line.replace(/^data:\s*/, '');
            if (!dataLine || dataLine === '[DONE]') continue;
            try {
              const event = JSON.parse(dataLine);

              if (event.type === 'run_meta') {
                setAgentStartedAt(event.startedAt || null);
                continue;
              }

              // Deduplicate: skip events already in the session's saved trace
              setAgentTrace(prev => {
                if (prev.some(e => e.type === event.type && e.step === event.step && e.stage === event.stage && e.model === event.model)) {
                  return prev;
                }
                return [...prev, event];
              });

              if (event.type === 'approval_required') {
                approvalRequestRef.current = { ...event, resolve: () => {} };
                setPendingApproval(event);
              }

              if (event.type === 'question_required') {
                questionRequestRef.current = { ...event, resolve: () => {} };
                setPendingQuestion(event);
              }

              if (event.type === 'user_response') {
                setPendingApproval(null);
                setPendingQuestion(null);
                approvalRequestRef.current = null;
                questionRequestRef.current = null;
              }

              if (event.type === 'approval_result') {
                setPendingApproval(null);
                approvalRequestRef.current = null;
              }

              if (event.type === 'done') {
                setAgentRunning(false);
                updateActiveSession(session => {
                  const msgs = [...session.messages];
                  const idx = (() => { for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'assistant' && msgs[i].content.includes('正在执行任务')) return i; } return -1; })();
                  if (idx >= 0) {
                    msgs[idx] = { role: 'assistant', content: event.answer || 'Agent 已完成任务。' };
                  } else if (!msgs.some(m => m.role === 'assistant' && m.content === (event.answer || ''))) {
                    msgs.push({ role: 'assistant', content: event.answer || 'Agent 已完成任务。' });
                  }
                  return touchSession(session, { messages: msgs });
                });
              }

              if (event.type === 'error') {
                setAgentRunning(false);
              }
            } catch { /* skip malformed SSE lines */ }
          }
        }
        setAgentRunning(false);
      } catch (err) {
        if (err.name === 'AbortError') {
          setAgentRunning(false);
          agentRunIdRef.current = null;
          setAgentRunId(null);
        }
      }
    })();

    return () => {
      aborted = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    // Don't change trace if we're reconnecting to a running agent
    if (agentRunning) return;
    setAgentTrace(activeSession.agentTrace || []);
    setAgentStartedAt(null);
    setPendingApproval(null);
    approvalRequestRef.current = null;
  }, [activeSession.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeSession.id, agentTrace]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [input]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      agentAbortRef.current?.abort();
      approvalRequestRef.current?.resolve?.('reject');
    };
  }, []);

  const updateSession = (sessionId, updater) => {
    setChatState(prev =>
      normalizeChatState({
        ...prev,
        sessions: prev.sessions.map(session => (session.id === sessionId ? updater(session) : session)),
      })
    );
  };

  // Restore saved agent panel width on mount
  useEffect(() => {
    const saved = localStorage.getItem(PANEL_SIZE_KEY);
    if (saved && window.innerWidth >= 1200) {
      const panel = document.querySelector('.layout-body > .agent-panel-wrap');
      if (panel) panel.style.flex = `0 0 ${saved}px`;
    }
  }, []);

  const stopGeneration = () => abortRef.current?.abort();
  const stopAgent = () => {
    setAgentStopping(true);
    approvalRequestRef.current?.resolve?.('reject');
    setPendingApproval(null);
    const rid = agentRunIdRef.current;
    if (rid) {
      fetch('/api/agent/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: rid }),
      }).catch(() => {});
    }
    // Abort SSE after a short grace period for in-flight results
    setTimeout(() => agentAbortRef.current?.abort(), 1500);
  };
  const requestAgentApproval = event =>
    new Promise(resolve => {
      approvalRequestRef.current = {
        ...event,
        resolve,
      };
      setPendingApproval(event);
    });

  const handleApprovalDecision = async decision => {
    const request = approvalRequestRef.current;
    if (!request) {
      return;
    }

    setApprovalSubmitting(true);
    try {
      await submitAgentApproval({
        runId: request.runId,
        approvalId: request.approvalId,
        decision,
      });
      request.resolve(decision);
      approvalRequestRef.current = null;
      setPendingApproval(null);
    } catch (err) {
      window.alert(`提交审批失败：${err.message}`);
    } finally {
      setApprovalSubmitting(false);
    }
  };

  const handleCreateSession = () => {
    if (sessionLocked) {
      return;
    }

    const nextSession = createSession();

    setChatState(prev =>
      normalizeChatState({
        sessions: [nextSession, ...prev.sessions],
        activeSessionId: nextSession.id,
      })
    );
    setInput('');
    setShowReset(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleSelectSession = sessionId => {
    if (sessionLocked || sessionId === activeSession.id) {
      return;
    }

    setChatState(prev =>
      normalizeChatState({
        ...prev,
        activeSessionId: sessionId,
      })
    );
    setInput('');
    setShowReset(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleDeleteSession = sessionId => {
    if (sessionLocked || !window.confirm('删除这个会话？此操作不可撤销。')) {
      return;
    }

    setChatState(prev => {
      const nextSessions = prev.sessions.filter(session => session.id !== sessionId);
      const nextActiveSessionId =
        sessionId === prev.activeSessionId ? nextSessions[0]?.id || createSession().id : prev.activeSessionId;

      return normalizeChatState({
        sessions: nextSessions,
        activeSessionId: nextActiveSessionId,
      });
    });
    setInput('');
    setShowReset(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleClearAllSessions = () => {
    if (sessionLocked || !window.confirm('清空所有会话？此操作不可撤销。')) {
      return;
    }
    setChatState(normalizeChatState({ sessions: [], activeSessionId: null }));
    setInput('');
    setShowReset(false);
    setShowSessions(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleReset = () => {
    updateSession(activeSession.id, session => touchSession(session, { messages: [] }));
    setInput('');
    setShowReset(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const setCurrentModel = nextModel => {
    updateSession(activeSession.id, session => touchSession(session, { model: nextModel }));
  };

  const sendChatMessage = async text => {
    const sessionId = activeSession.id;
    const now = Date.now();
    const userMsg = { role: 'user', content: text, ts: now };
    const history = [...messages, userMsg];
    const apiMessages = history;

    updateSession(sessionId, session =>
      touchSession(session, {
        messages: [...history, { role: 'assistant', content: '', ts: now }],
      })
    );
    setInput('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChatCompletion({
        messages: apiMessages,
        model,
        signal: controller.signal,
        onContent(content) {
          updateSession(sessionId, session => {
            const nextMessages = [...session.messages];
            const lastMessage = nextMessages[nextMessages.length - 1] || { role: 'assistant', content: '' };
            nextMessages[nextMessages.length - 1] = {
              role: 'assistant',
              content: (lastMessage.content || '') + content,
            };

            return touchSession(session, { messages: nextMessages });
          });
        },
      });
    } catch (err) {
      if (err.name === 'AbortError' || (err.name === 'TypeError' && /load failed|network|fetch/i.test(err.message))) {
        updateSession(sessionId, session => {
          const nextMessages = [...session.messages];
          const lastMessage = nextMessages[nextMessages.length - 1];
          nextMessages[nextMessages.length - 1] = {
            ...lastMessage,
            content: `${lastMessage?.content || ''}${lastMessage?.content ? '\n\n' : ''}_已停止生成_`,
          };

          return touchSession(session, { messages: nextMessages });
        });
      } else {
        const detail = err.stack ? `\n\`\`\`\n${err.stack.split('\n').slice(0, 3).join('\n')}\n\`\`\`` : '';
        updateSession(sessionId, session => {
          const nextMessages = [...session.messages];
          nextMessages[nextMessages.length - 1] = {
            role: 'assistant',
            content: `⚠️ 请求失败：${err.message}${detail}`,
          };

          return touchSession(session, { messages: nextMessages });
        });
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const sendAgentTask = async text => {
    const sessionId = activeSession.id;
    const userMsg = { role: 'user', content: text, ts: Date.now() };
    const history = [...messages, userMsg];

    updateSession(sessionId, session =>
      touchSession(session, {
        messages: [...history, { role: 'assistant', content: 'Desktop Agent 正在执行任务，请稍候…', ts: Date.now() }],
      })
    );
    setInput('');
    setAgentTrace([]);
    setAgentStartedAt(Date.now());
    setAgentRunning(true);
    setPendingApproval(null);

    const controller = new AbortController();
    agentAbortRef.current = controller;

    try {
      await streamAgentRun({
        task: text,
        model,
        models: agentModels.length > 0 ? agentModels.filter(m => models.some(available => available.id === m)) : [model],
        strategy: agentModels.length > 1 ? agentStrategy : 'race',
        headless: agentHeadless,
        memory: agentMemory,
        signal: controller.signal,
        messages: history.slice(-10),
        async onEvent(event) {
          if (event.type === 'model_plan') {
            console.log(`[AgentUI] model_plan step=${event.step} stage=${event.stage} model=${event.model || '-'} models=${event.models?.join(',') || '-'}`);
          }
          setAgentTrace(prev => [...prev, event]);

          if (event.runId && !agentRunIdRef.current) {
            agentRunIdRef.current = event.runId;
            setAgentRunId(event.runId);
          }

          if (event.type === 'approval_required') {
            await requestAgentApproval(event);
            return;
          }

          if (event.type === 'question_required') {
            await new Promise(resolve => {
              questionRequestRef.current = { ...event, resolve };
              setPendingQuestion(event);
            });
            return;
          }

          if (event.type === 'done') {
            setAgentTrace(prev => {
              updateSession(sessionId, session => {
                const nextMessages = [...session.messages];
                nextMessages[nextMessages.length - 1] = {
                  role: 'assistant',
                  content: event.answer || 'Agent 已完成任务。',
                };
                return touchSession(session, { messages: nextMessages, agentTrace: prev });
              });
              return prev;
            });
          }

          if (event.type === 'error') {
            setAgentTrace(prev => {
              updateSession(sessionId, session => {
                const nextMessages = [...session.messages];
                nextMessages[nextMessages.length - 1] = {
                  role: 'assistant',
                  content: `⚠️ Desktop Agent 失败：${event.error}`,
                };
                return touchSession(session, { messages: nextMessages, agentTrace: prev });
              });
              return prev;
            });
          }
        },
      });
    } catch (err) {
      const isPageUnload = err.name === 'AbortError'
        || controller.signal.aborted
        || (err.name === 'TypeError' && /load failed|network|fetch/i.test(err.message));
      if (isPageUnload) {
        // Page navigation cancelled the request — don't show error
      } else {
        const detail = err.stack ? `\n\`\`\`\n${err.stack.split('\n').slice(0, 3).join('\n')}\n\`\`\`` : '';
        updateSession(sessionId, session => {
          const nextMessages = [...session.messages];
          nextMessages[nextMessages.length - 1] = {
            role: 'assistant',
            content: `⚠️ Desktop Agent 请求失败：${err.message}${detail}`,
          };

          return touchSession(session, { messages: nextMessages });
        });
      }
    } finally {
      // SSE 可能断连导致 done 事件丢失，检查占位消息是否未被替换
      setAgentTrace(prev => {
        const doneEvent = prev.find(e => e.type === 'done');
        if (doneEvent) {
          updateSession(sessionId, session => {
            const msgs = session.messages;
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant' && msgs[lastIdx].content.includes('正在执行任务')) {
              const next = [...msgs];
              next[lastIdx] = { role: 'assistant', content: doneEvent.answer || 'Agent 已完成任务。' };
              return touchSession(session, { messages: next, agentTrace: prev });
            }
            return touchSession(session, { agentTrace: prev });
          });
        }
        return prev;
      });

      agentAbortRef.current = null;
      agentRunIdRef.current = null;
      setAgentRunId(null);
      setAgentRunning(false);
      setAgentStopping(false);
      setReconnectedRun(false);
      setPendingApproval(null);
      approvalRequestRef.current = null;
      if (window.innerWidth < 640) setAgentMobileTab('chat');
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || sessionLocked) {
      return;
    }

    if (mode === 'agent') {
      await sendAgentTask(text);
      return;
    }

    await sendChatMessage(text);
  };

  const handleKeyDown = e => {
    const isMobile = window.innerWidth < 768;
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const sessionStarted = messages.length > 0;

  const modeSwitch = !sessionStarted && (
    <div className="mode-switch" aria-label="模式切换">
      <button className={`mode-btn ${mode === 'chat' ? 'active' : ''}`} onClick={() => setMode('chat')} disabled={sessionLocked}>
        对话
      </button>
      <button className={`mode-btn ${mode === 'agent' ? 'active' : ''}`} onClick={() => setMode('agent')} disabled={sessionLocked}>
        Agent
      </button>
    </div>
  );

  const toggleAgentModel = id => {
    setAgentModels(prev => {
      const next = prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id];
      localStorage.setItem('agent_models', JSON.stringify(next));
      return next;
    });
  };

  const modelSelect = !sessionStarted
    ? mode === 'agent' ? (
      <div className="model-tags-wrap">
        <div className="model-tags">
          {models.map(item => (
            <button
              key={item.id}
              className={`model-tag ${agentModels.includes(item.id) ? 'selected' : ''}`}
              onClick={() => toggleAgentModel(item.id)}
              disabled={sessionLocked}
              title={agentModels.includes(item.id) ? '取消选择' : '选择并发执行'}
            >
              {item.label}
            </button>
          ))}
        </div>
        {agentModels.length > 1 && (
          <div className="strategy-toggle">
            <button
              className={`strategy-btn ${agentStrategy === 'race' ? 'active' : ''}`}
              onClick={() => { setAgentStrategy('race'); localStorage.setItem('agent_strategy', 'race'); }}
              disabled={sessionLocked}
              title="先到先得，速度优先"
            >竞速</button>
            <button
              className={`strategy-btn ${agentStrategy === 'vote' ? 'active' : ''}`}
              onClick={() => { setAgentStrategy('vote'); localStorage.setItem('agent_strategy', 'vote'); }}
              disabled={sessionLocked}
              title="等待所有模型完成，投票选最优"
            >汇总</button>
          </div>
        )}
      </div>
    ) : (
      <select className="model-select" value={model} onChange={e => setCurrentModel(e.target.value)} title="切换模型">
        {models.map(item => (
          <option key={item.id} value={item.id}>{item.label}</option>
        ))}
      </select>
    )
    : null;

  const sendButton = streaming ? (
    <button className="send-btn stop" onClick={stopGeneration}><Square size={12} /> 停止</button>
  ) : agentRunning ? (
    <button className="send-btn stop" onClick={stopAgent} disabled={agentStopping}>
      <Square size={12} /> {agentStopping ? '正在停止…' : pendingApproval ? '停止并拒绝' : '停止'}
    </button>
  ) : (
    <button className="send-btn idle" onClick={handleSubmit} disabled={!input.trim()}>
      <Send size={14} /> 发送
    </button>
  );

  const memoryToggle = mode === 'agent' && !sessionStarted && (
    <button
      className={`toolbar-chip ${agentMemory ? 'active' : ''}`}
      onClick={() => { setAgentMemory(v => { const n = !v; localStorage.setItem('agent_memory', String(n)); return n; }); }}
      title={agentMemory ? '使用历史记忆辅助任务' : '不使用记忆'}
    >
      <Brain size={12} /> {agentMemory ? '记忆开' : '记忆关'}
    </button>
  );

  const showHero = messages.length === 0;

  return (
    <ErrorBoundary>
    <div className="app-shell">
      <div className={`sidebar ${showSessions ? 'open' : ''}`}>
        <SessionList
          sessions={sessions}
          activeSessionId={activeSession.id}
          modelList={models}
          onCreate={handleCreateSession}
          onDelete={handleDeleteSession}
          onClearAll={handleClearAllSessions}
          onSelect={(id) => { handleSelectSession(id); if (window.innerWidth < 768) setShowSessions(false); }}
          locked={sessionLocked}
        />
      </div>

      <div className="main-area">
      {showHero ? (
        <div className="hero-wrap">
          <div className="hero">
            <button className="session-toggle-btn hero-menu" onClick={() => setShowSessions(v => !v)} title="会话列表">
              <Menu size={16} />
            </button>

            <div className="hero-brand">
              <h1 className="hero-title">sagent</h1>
              <p className="hero-subtitle">多模型 AI 聊天 + 桌面 Agent</p>
            </div>

            <div className="hero-input-card">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={mode === 'agent' ? '描述要让 Agent 完成的任务…' : '输入消息…'}
                rows={2}
                disabled={sessionLocked}
              />
              <div className="hero-toolbar">
                {modeSwitch}
                {modelSelect}
                {memoryToggle}
                {sendButton}
              </div>
            </div>

            <div className="suggestions">
              {SUGGESTIONS[mode].map(s => (
                <button key={s.title} className="suggestion-card"
                  onClick={() => { setInput(s.text); textareaRef.current?.focus(); }}
                  onDoubleClick={() => { setInput(s.text); setTimeout(() => handleSubmit(), 0); }}
                >
                  <span className="suggestion-title">{s.title}</span>
                  <span className="suggestion-text">{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="layout">
          {reconnectedRun && agentRunning && (
            <div className="reconnect-banner">
              检测到运行中的 Agent 任务，已自动连接。可点击"停止"取消。
            </div>
          )}
          <div className="header">
            <div className="header-left">
              <button className="session-toggle-btn" onClick={() => setShowSessions(v => !v)} title="会话列表">
                <Menu size={16} />
              </button>
              <span className="header-session-title">{getSessionTitle(messages)}</span>
            </div>
            <div className="header-right">
              {modeSwitch}
              {modelSelect}
              {sessionStarted && (
                <span className="header-model-label">{selectedModelLabel}</span>
              )}
              <button className="header-icon-btn" onClick={() => setShowReset(true)} title="清空" disabled={messages.length === 0 || sessionLocked}><Trash2 size={14} /></button>
            </div>
          </div>

          <div className="layout-body">
          {mode === 'agent' && (
            <div className="agent-mobile-tabs">
              <button className={`agent-mobile-tab ${agentMobileTab === 'agent' ? 'active' : ''}`} onClick={() => setAgentMobileTab('agent')}>
                Agent{agentRunning && <span className="tab-status-dot" />}
              </button>
              {agentTrace.length > 0 && (() => {
                const lastStep = agentTrace.reduce((max, e) => (e.step != null ? Math.max(max, e.step) : max), 0);
                const totalTokens = agentTrace.reduce((sum, e) => {
                  if (e.type === 'step' && e.stage === 'action' && e.usage) return sum + e.usage.prompt_tokens + e.usage.completion_tokens;
                  return sum;
                }, 0);
                const doneEvent = [...agentTrace].reverse().find(e => e.type === 'done');
                const stepCount = doneEvent?.meta?.step_count || lastStep;
                return (
                  <div className="agent-mobile-metrics">
                    {lastStep > 0 && <span className="agent-mobile-metric">Step {lastStep}/{stepCount}</span>}
                    {totalTokens > 0 && <span className="agent-mobile-metric">{totalTokens > 999 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens} tok</span>}
                  </div>
                );
              })()}
              <button className={`agent-mobile-tab ${agentMobileTab === 'chat' ? 'active' : ''}`} onClick={() => setAgentMobileTab('chat')}>对话</button>
            </div>
          )}
          <div className={`agent-panel-wrap ${mode === 'agent' && agentMobileTab === 'chat' ? 'mobile-hidden' : ''}`}>
          <AgentPanel
            mode={mode}
            running={agentRunning}
            trace={agentTrace}
            headless={agentHeadless}
            startedAt={agentStartedAt}
            modelList={models}
            collapsed={agentCollapsed}
            onToggleCollapse={() => setAgentCollapsed(c => !c)}
            onHeadlessChange={v => {
              setAgentHeadless(v);
              localStorage.setItem('agent_headless', String(v));
            }}
          />
          </div>

          <ResizeDivider side="agent" />

          {messages.length > 0 && (
            <div className={`messages ${mode === 'agent' && agentMobileTab === 'agent' ? 'mobile-hidden' : ''}`}>
              {messages.map((msg, i) => (
                <div key={i} className={`bubble-row ${msg.role}`}>
                  {msg.role === 'assistant' && (
                    <>
                      <div className={`bubble assistant ${hasThinkContent(msg.content) ? 'has-think' : ''}`}>
                        <MessageContent role="assistant" content={msg.content} showCursor={streaming && i === messages.length - 1} />
                        {msg.ts && <div className="msg-time">{formatMsgTime(msg.ts)}</div>}
                      </div>
                      <CopyButton text={msg.content} />
                    </>
                  )}
                  {msg.role === 'user' && (
                    <>
                      <CopyButton text={msg.content} />
                      <div className="bubble user">
                        <MessageContent role="user" content={msg.content} />
                        {msg.ts && <div className="msg-time">{formatMsgTime(msg.ts)}</div>}
                      </div>
                    </>
                  )}
                </div>
              ))}
              <div ref={bottomRef} />
              <div className="input-area">
                <div className="input-card">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      mode === 'agent'
                        ? '描述要让 Agent 完成的任务…'
                        : '输入消息…'
                    }
                    rows={1}
                    disabled={sessionLocked}
                  />
                  <div className="input-toolbar">
                    {memoryToggle}
                    {sendButton}
                  </div>
                </div>
              </div>
            </div>
          )}

          </div>

        </div>
      )}

      </div>

      <ApprovalDialog
        approval={pendingApproval}
        submitting={approvalSubmitting}
        onApprove={() => handleApprovalDecision('approve')}
        onReject={() => handleApprovalDecision('reject')}
      />

      <QuestionDialog
        question={pendingQuestion}
        submitting={questionSubmitting}
        onSubmit={async (response) => {
          if (!pendingQuestion) return;
          setQuestionSubmitting(true);
          try {
            await submitAgentQuestion({
              runId: pendingQuestion.runId,
              approvalId: pendingQuestion.approvalId,
              response,
            });
            setPendingQuestion(null);
            questionRequestRef.current?.resolve?.(response);
          } catch (err) {
            console.error('Question submit failed:', err);
          } finally {
            setQuestionSubmitting(false);
          }
        }}
        onSkip={() => {
          setPendingQuestion(null);
          questionRequestRef.current?.resolve?.('');
        }}
      />

      {showReset && <ResetDialog onConfirm={handleReset} onCancel={() => setShowReset(false)} />}
    </div>
    </ErrorBoundary>
  );
}
