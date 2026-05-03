import { useEffect, useRef, useState, Component, useMemo } from 'react';
import {
  Menu, Timer, Trash2, Square, Brain, ChevronDown, ChevronUp,
  Copy, Check, Send, RotateCcw,
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

// Top-level render guard. App.jsx 承担了整页绝大部分 UI 和状态管理，
// 一旦某个子组件因为异常崩掉，ErrorBoundary 至少还能保住基本交互，
// 避免用户只能看到整页白屏。
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
    { title: '网页摘要', text: '抓取 https://finance.sina.com.cn 的内容并总结经济新闻要点' },
    { title: '搜索新闻', text: '搜索最新的 AI 技术新闻，汇总前 5 条' },
    { title: '执行脚本', text: '运行 node -e "console.log(process.version)" 查看当前 Node 版本' },
    { title: '分析代码', text: '搜索项目中所有的 TODO 注释并列出来' },
    { title: '查汇率', text: '打开浏览器查询今日美元兑人民币汇率' },
    { title: '查股价', text: '打开浏览器搜索苹果公司最新股价' },
    { title: '查快递', text: '帮我搜索快递单号 SF1234567890 的物流信息' },
    { title: '查菜谱', text: '搜索番茄炒蛋的做法，列出食材和步骤' },
    { title: '翻译文档', text: '读取 README.md 并翻译为英文' },
    { title: '查论文', text: '搜索最近关于大语言模型的论文，列出标题和摘要' },
    { title: '查航班', text: '搜索明天北京到上海的航班信息' },
    { title: '整理文件', text: '列出当前目录下所有 .log 文件并统计大小' },
    { title: '查天气预报', text: '打开浏览器搜索北京未来三天的天气预报' },
    { title: '生成报告', text: '读取 package.json 并生成项目依赖报告' },
    { title: '查火车票', text: '搜索明天北京到上海的高铁票信息' },
    { title: '查星座', text: '搜索今日白羊座运势' },
    { title: '查电影', text: '搜索本周正在热映的电影列表' },
    { title: '查图书', text: '搜索《三体》的豆瓣评分和简介' },
    { title: '查音乐', text: '搜索 Spotify 最热门的中文歌曲排行' },
    { title: '查健身', text: '搜索适合初学者的家庭健身计划' },
    { title: '查旅游', text: '搜索杭州必去的十大景点及门票价格' },
    { title: '查驾照', text: '打开浏览器查询驾照违章扣分情况' },
    { title: '查公积金', text: '搜索北京住房公积金最新政策' },
    { title: '查社保', text: '搜索2025年社保缴费基数标准' },
    { title: '查个税', text: '搜索最新个人所得税计算方法' },
    { title: '查信用卡', text: '搜索招商银行信用卡最新优惠活动' },
    { title: '查油价', text: '打开浏览器查询今日 92 号汽油价格' },
    { title: '查疫情', text: '搜索最新的流感疫情数据' },
    { title: '查驾照新规', text: '搜索2025年驾照考试最新规定' },
    { title: '查房价', text: '搜索北京朝阳区最新二手房均价' },
    { title: '查租房', text: '搜索北京海淀区一居室租房价格' },
    { title: '查招聘', text: '搜索前端工程师最新招聘岗位要求' },
    { title: '查面试题', text: '搜索大厂前端面试高频题目 TOP 10' },
    { title: '查英语', text: '搜索商务英语常用邮件模板' },
    { title: '查PPT模板', text: '搜索免费PPT模板下载网站推荐' },
    { title: '查表情包', text: '搜索最近流行的搞笑表情包' },
    { title: '查养生', text: '搜索春季养生饮食注意事项' },
    { title: '查医保', text: '搜索北京医保报销比例最新标准' },
    { title: '查WiFi密码', text: '列出当前网络连接信息和IP地址' },
    { title: '查进程', text: '列出当前占用内存最多的10个进程' },
    { title: '查端口', text: '查看本机 3000 端口是否被占用' },
    { title: '查磁盘', text: '查看当前磁盘剩余空间' },
    { title: '查环境变量', text: '列出所有 Node.js 相关的环境变量' },
    { title: '查Git状态', text: '查看当前项目 Git 状态和最近提交' },
    { title: '查NPM包', text: '搜索 lodash 的 NPM 下载量和版本信息' },
    { title: '查开源项目', text: '搜索 GitHub 上最热门的 AI 项目' },
    { title: '查API文档', text: '打开浏览器搜索 OpenAI API 最新文档' },
    { title: '查Regex', text: '帮我写一个匹配邮箱地址的正则表达式并测试' },
    { title: '查Cron', text: '帮我写一个每天早上9点执行的 Cron 表达式' },
    { title: '查SQL', text: '写一个 SQL 查询：按销售额降序取前10名客户' },
    { title: '查Docker', text: '列出当前运行的 Docker 容器和镜像' },
    { title: '查证书', text: '查看 google.com 的 SSL 证书过期时间' },
    { title: '查网站状态', text: '检测 github.com 是否可以正常访问' },
    { title: '查压缩包', text: '列出当前目录下所有 zip 文件及大小' },
    { title: '查图片', text: '统计当前目录下所有图片文件数量和总大小' },
    { title: '查PDF', text: '统计当前目录下所有 PDF 文件列表' },
    { title: '查视频', text: '列出当前目录下所有视频文件及时长' },
    { title: '查音乐文件', text: '列出当前目录下所有 mp3 文件' },
    { title: '查大文件', text: '找出当前目录下超过 100MB 的文件' },
    { title: '查重复文件', text: '扫描当前目录下可能重复的文件' },
    { title: '查空目录', text: '列出当前项目下所有空的文件夹' },
    { title: '查TODO', text: '搜索所有源代码文件中的 TODO 和 FIXME 注释' },
    { title: '查console.log', text: '搜索前端代码中所有 console.log 调用' },
    { title: '查依赖版本', text: '检查 package.json 中依赖的最新版本' },
    { title: '查安全漏洞', text: '运行 npm audit 检查项目依赖的安全问题' },
    { title: '查代码行数', text: '统计项目中各类型文件的代码行数' },
    { title: '查最近修改', text: '列出最近7天修改过的文件' },
    { title: '查启动项', text: '查看 macOS 当前开机启动项列表' },
    { title: '查蓝牙', text: '查看当前连接的蓝牙设备列表' },
    { title: '查电池', text: '查看 MacBook 电池健康度和循环次数' },
    { title: '查内存', text: '查看当前系统内存使用详情' },
    { title: '查CPU', text: '查看当前 CPU 型号和使用率' },
    { title: '查显示器', text: '查看当前显示器分辨率和刷新率' },
    { title: '查剪贴板', text: '读取当前系统剪贴板内容' },
    { title: '查日历', text: '查看今天日期和本周日程安排' },
    { title: '查时区', text: '列出世界主要城市的当前时间' }
  ],
};

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const LEGACY_MESSAGES_KEY = 'nvidia_chat_messages';
const LEGACY_MODEL_KEY = 'nvidia_chat_model';
const SESSIONS_KEY = 'nvidia_chat_sessions';
const ACTIVE_SESSION_KEY = 'nvidia_chat_active_session';
const LAST_MODE_KEY = 'nvidia_chat_last_mode';
const PHONE_BREAKPOINT = 640;
const TABLET_BREAKPOINT = 768;
const DOCKED_LAYOUT_BREAKPOINT = 1100;
const APP_BG_COLOR = '#f5f5fa';
const APP_SURFACE_COLOR = '#ffffff';

// 会话 id 会同时承担 React key、本地持久化索引、切换会话时的主键。
// 这里不要求全局唯一，只要在当前浏览器存储范围内稳定即可。
function generateSessionId() {
  return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 浏览器本地存储里的消息历史可能来自旧版本、异常写入，或者手工改动。
// 统一做一次清洗，后面的 UI/流式更新逻辑就可以直接假设结构正常。
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

// 统一修正整个聊天状态的外形：
// 1. sessions 至少保留一个
// 2. activeSessionId 必须落在现有 sessions 里
// 3. 每个 session 都走 createSession，保证字段完整
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

// 首先尝试读取新版多会话结构；如果不存在，再从旧版单会话存储迁移。
// 这样老用户刷新后不会丢历史，同时后续代码始终只处理新版状态。
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

// 对单个 session 做浅更新，同时刷新 updatedAt，保证会话排序或后续扩展
// 可以依赖这个时间戳，而不是到处手动补 Date.now()。
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

// 通用 SSE 读取器。Chat / Agent 两种流式接口都走这里，
// 上层只关心“每收到一个 data 事件该怎么处理”。
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

// 普通对话的流式包装。它只负责把 token 增量回调给调用方，
// 不关心 UI 更新方式，方便 sendChatMessage 统一处理消息替换。
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

// Agent 的首个 POST 既负责发起任务，也承载最初的一段 SSE。
// 如果这段连接中途断开，但服务端 run 已经创建成功，就退化为
// 通过 runId 继续订阅 /stream/:runId，而不是直接把整次任务判失败。
async function streamAgentRun({ task, model, models, strategy, headless, memory, signal, onEvent, messages, ...extra }) {
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
      body: { task, model, models, strategy, headless, memory, messages, ...extra },
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

// 桌面端 Agent 面板支持拖拽调整宽度，宽度直接写 localStorage，
// 这样刷新页面后仍然能保持用户上一次的布局偏好。
function ResizeDivider() {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = e => {
    if (window.innerWidth < DOCKED_LAYOUT_BREAKPOINT) return;
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

// Agent/Chat 的回答里可能带 <thinking> 或 <think> 片段。
// 这里先把不同来源的标记统一成同一套语法，后面的展示逻辑才好复用。
function normalizeThinkTags(content) {
  if (typeof content !== 'string') {
    return '';
  }

  return content.replace(/<thinking>/gi, '<think>').replace(/<\/thinking>/gi, '</think>');
}

function hasThinkContent(content) {
  return /<think>/i.test(normalizeThinkTags(content));
}

// Assistant 消息可能同时包含“可展示答案”和“可折叠思考过程”。
// 这里把一整段消息拆成多个片段，让 UI 可以分别渲染 markdown/think。
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

// 这是一个很轻量的 markdown 解析器，目标不是完整支持 GFM，
// 而是覆盖当前产品里最常见的结构：标题、段落、列表、表格、代码块。
// 这样可以避免引入完整 markdown runtime 带来的体积和样式不确定性。
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
          case 'heading': {
            const HeadingTag = `h${block.level}`;
            return <HeadingTag key={idx} dangerouslySetInnerHTML={{ __html: inlineFormat(block.content) }} />;
          }
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

// Assistant 回复里如果包含截图路径，会同时渲染成图片。
// 文本里对应的文件路径会被清理掉，避免在气泡中既显示路径又显示图片。
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

// 用户消息直接原样展示；助手消息则需要经过：
// 1. 提取截图
// 2. 拆分 think 片段
// 3. 再按 markdown 渲染
// 这样能兼容普通回答、带思考的回答、以及带桌面截图的 Agent 结果。
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
 onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(response); } }}
 autoFocus
        />
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onSkip} disabled={submitting}>
            跳过
          </button>
          <button
            className="dialog-btn confirm approval-confirm"
            onClick={() => onSubmit(response)}
            disabled={submitting}
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
  pending: '等待中…',
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
  pending: '🕐',
  thinking: '⏳',
  success: '✓',
  winner: '👑',
  failed: '✗',
  discarded: '…',
  abandoned: '—',
  cancelled: '⊘',
  consensus: '🏆',
};

// 单个模型卡片负责展示某一步里某个模型的“决策快照”：
// 当前状态、理由、动作、tokens，以及在竞速模式下是否被采纳。
function ModelPlanCard({ event, isWinner, modelList, result }) {
  const label = getModelLabel(event.model, modelList);
  const stage = event.stage;
  const [showReasoning, setShowReasoning] = useState(false);
  const [showFullResult, setShowFullResult] = useState(false);

  if (stage === 'start') return null;

  return (
    <div className={`model-card ${stage} ${isWinner ? 'winner' : ''}`}>
      <div className="model-card-head">
        <span className="model-card-icon">{PLAN_STAGE_ICON[stage] || '·'}</span>
        <span className="model-card-label">{label}</span>
        <span className={`model-card-status ${stage}`}>{PLAN_STAGE_LABELS[stage] || stage}</span>
      </div>
      {stage === 'pending' && (
        <div className="model-card-body">
          <p style={{ color: 'var(--c-text-tertiary)', fontSize: 12 }}>
            {event.delay ? `${Math.round(event.delay / 1000)}s 后启动` : '排队中'}
          </p>
        </div>
      )}
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
              <p>{showFullResult || result.length <= 50 ? result : result.slice(0, 50) + '…'}</p>
              {result.length > 50 && (
                <button className="model-card-result-toggle" onClick={() => setShowFullResult(v => !v)}>
                  {showFullResult ? '收起' : '展开全部'}
                </button>
              )}
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

// 多模型一步会产生多条 model_plan 事件。这个组件负责把零散事件重新聚合成
// 一个“按 step 分组”的展示块，让用户能看到同一步里不同模型如何竞争/投票。
function ModelPlanGroup({ trace, step, models, modelList, running }) {
  let strategyMode = 'race';
  let consensusEvent = null;
  const modelEvents = {};
  let stepResult = null;

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
    }
  }

  // Agent is truly finished when trace has a terminal event (done/error) for this run
  const agentFinished = !running && trace.some(e => e.type === 'done' || e.type === 'error');

  const winnerModel = consensusEvent?.model || Object.values(modelEvents).find(e => e.stage === 'winner')?.model;

  const getEvent = m => {
    const ev = modelEvents[m];
    if (!ev) return { model: m, stage: agentFinished ? 'cancelled' : (strategyMode === 'race' ? 'pending' : 'thinking') };
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

// AgentPanel 既是执行面板，也是运行时仪表盘：
function MemoryPanel({ onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [compacting, setCompacting] = useState(false);
  const [tab, setTab] = useState('conversation');

  useEffect(() => {
    setLoading(true);
    fetch('/api/agent/memory')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleCompact = async () => {
    setCompacting(true);
    try {
      const r = await fetch('/api/agent/compact', { method: 'POST' });
      const result = await r.json();
      if (result.ok) {
        const r2 = await fetch('/api/agent/memory');
        setData(await r2.json());
      }
    } finally {
      setCompacting(false);
    }
  };

  const pk = data?.projectKnowledge || {};

  return (
    <div className="memory-panel">
      <div className="memory-panel-head">
        <div className="memory-panel-tabs">
          <button className={`memory-tab ${tab === 'conversation' ? 'active' : ''}`} onClick={() => setTab('conversation')}>
            对话 ({data?.conversationCount ?? 0})
          </button>
          <button className={`memory-tab ${tab === 'knowledge' ? 'active' : ''}`} onClick={() => setTab('knowledge')}>
            知识 ({(pk.structure?.length || 0) + Object.keys(pk.paths || {}).length + (pk.preferences?.length || 0) + (pk.learnings?.length || 0)})
          </button>
        </div>
        <button className="memory-panel-close" onClick={onClose}><ChevronUp size={14} /></button>
      </div>
      <div className="memory-panel-body">
        {loading ? (
          <div className="memory-loading">加载中…</div>
        ) : tab === 'conversation' ? (
          <>
            {data?.conversationSummary && (
              <div className="memory-section">
                <p className="memory-section-title">历史摘要{data.lastCompactedAt ? ` · 压缩于 ${new Date(data.lastCompactedAt).toLocaleString()}` : ''}</p>
                <p className="memory-summary-text">{data.conversationSummary}</p>
              </div>
            )}
            {(data?.conversation || []).length === 0 ? (
              <div className="memory-empty">暂无对话记录</div>
            ) : (
              <div className="memory-conversation-list">
                {[...(data.conversation || [])].reverse().map((entry, i) => (
                  <div key={i} className="memory-conv-item">
                    <div className="memory-conv-task">{entry.task}</div>
                    <div className="memory-conv-summary">{entry.summary}</div>
                    <div className="memory-conv-meta">
                      {entry.models?.length > 0 ? (
                        entry.models.map(m => <span key={m} className="memory-conv-model">{m.split('/').pop()}</span>)
                      ) : entry.model ? (
                        <span className="memory-conv-model">{entry.model.split('/').pop()}</span>
                      ) : null}
                      {entry.timestamp && <span className="memory-conv-time">{new Date(entry.timestamp).toLocaleString()}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {pk.structure?.length > 0 && (
              <div className="memory-section">
                <p className="memory-section-title">项目结构</p>
                {pk.structure.map((s, i) => <p key={i} className="memory-kv">{s}</p>)}
              </div>
            )}
            {Object.keys(pk.paths || {}).length > 0 && (
              <div className="memory-section">
                <p className="memory-section-title">常用路径</p>
                {Object.entries(pk.paths).map(([k, v]) => <p key={k} className="memory-kv"><span className="memory-k">{k}</span> {v}</p>)}
              </div>
            )}
            {pk.preferences?.length > 0 && (
              <div className="memory-section">
                <p className="memory-section-title">偏好</p>
                {pk.preferences.map((p, i) => <p key={i} className="memory-kv">{p}</p>)}
              </div>
            )}
            {pk.learnings?.length > 0 && (
              <div className="memory-section">
                <p className="memory-section-title">经验</p>
                {pk.learnings.map((l, i) => <p key={i} className="memory-kv">{l}</p>)}
              </div>
            )}
            {!pk.structure?.length && !Object.keys(pk.paths || {}).length && !pk.preferences?.length && !pk.learnings?.length && (
              <div className="memory-empty">暂无项目知识</div>
            )}
          </>
        )}
      </div>
      <div className="memory-panel-footer">
        <button className="memory-compact-btn" onClick={handleCompact} disabled={compacting}>
          {compacting ? '压缩中…' : '压缩历史'}
        </button>
      </div>
    </div>
  );
}

// - 负责展示 trace
// - 负责显示暂停/审批/用时/token 等运行态指标
// - 在移动端和桌面端之间复用同一套事件展示逻辑
function AgentPanel({ mode, running, trace, headless, onHeadlessChange, startedAt, modelList, collapsed, onToggleCollapse, onStop, agentStopping, pendingApproval, onToggleMemory, showMemoryPanel, onRollback, rollbackLoading }) {
  const traceBottomRef = useRef(null);
  const startTimeRef = useRef(null);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < PHONE_BREAKPOINT;
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
    traceBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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
        {running && onStop && (
          <button className="agent-stop-btn" onClick={onStop} disabled={agentStopping} title="停止 Agent">
            <Square size={10} /> {agentStopping ? '停止中…' : pendingApproval ? '停止并拒绝' : '停止'}
          </button>
        )}
        <label className="agent-headless-toggle" title={headless ? '浏览器在后台运行' : '浏览器窗口可见'}>
          <input
            type="checkbox"
            checked={headless}
            disabled={running}
            onChange={e => onHeadlessChange(e.target.checked)}
          />
          <span>Headless</span>
        </label>
        <button className="agent-memory-btn" onClick={onToggleMemory} title="查看记忆">
          <Brain size={12} />
        </button>
        {trace.length > 0 && (
          <button className="agent-collapse-btn agent-tablet-only" onClick={e => { e.stopPropagation(); onToggleCollapse(); }} title={collapsed ? '展开' : '收起'}>
            {collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        )}
      </div>

      {showContent && (
        <>
          {showMemoryPanel ? (
            <MemoryPanel onClose={() => onToggleMemory()} />
          ) : (
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
                    {event.meta?.models_used?.length > 0 && (
                      <div className="agent-models-used">
                        {event.meta.models_used.map(m => {
                          const short = m.split('/').pop();
                          return <span key={m} className="agent-model-chip">{short}</span>;
                        })}
                      </div>
                    )}
                    {event.answer && (
                      <div className="agent-done-answer">
                        <MarkdownBlock content={event.answer} />
                      </div>
                    )}
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
                    {event.rollbackSuggestion && (() => {
                      const rs = event.rollbackSuggestion;
                      return (
                        <div className="rollback-suggestion">
                          <p className="rollback-suggestion-info">
                            建议回滚到 Step {rs.step} 重新执行
                            {rs.lastAction && <span className="rollback-suggestion-detail">（上一步: {rs.lastAction.tool}.{rs.lastAction.type}）</span>}
                          </p>
                          {rs.lastRationale && <p className="rollback-suggestion-ctx">决策: {rs.lastRationale}</p>}
                          {rs.lastResult && <p className="rollback-suggestion-ctx">结果: {rs.lastResult}</p>}
                          <button className="rollback-suggestion-btn" onClick={() => onRollback(rs.step)} disabled={rollbackLoading}>
                            <RotateCcw size={12} /> 回滚到 Step {rs.step}
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                </>
              )}

              {event.type === 'rollback' && (
                <>
                  <span className="agent-trace-badge rollback">回滚</span>
                  <div className="agent-trace-content">
                    <strong>已回滚到 Step {event.targetStep}</strong>
                    <p>{event.message}</p>
                  </div>
                </>
              )}

              {event.type === 'session_checkpoint' && (
                <>
                  <span className="agent-trace-badge plan">快照</span>
                  <div className="agent-trace-content">
                    <strong>Step {event.step} 健康快照已保存</strong>
                  </div>
                  <button className="trace-rollback-btn" onClick={() => onRollback(event.step)} disabled={rollbackLoading || running} title={`回滚到 Step ${event.step}`}>
                    <RotateCcw size={10} />
                  </button>
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
        </>
      )}
    </section>
  );
}

export default function App() {
  // chatState 是“会话级业务状态”的根对象：消息历史、会话列表、当前激活会话。
  // 其余 state 大多是 UI 控件状态或运行时状态。
  const [chatState, setChatState] = useState(loadChatState);
  const [availableModels, setAvailableModels] = useState(DEFAULT_MODELS);
  // availableModels 在首屏渲染时先用 DEFAULT_MODELS 占位；
  // modelsLoaded 用来区分“占位值”和“真实从后端拿到的列表”，
  // 避免启动阶段误把用户已选的多模型裁成一个。
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState(() => localStorage.getItem(LAST_MODE_KEY) || 'chat');
  const [streaming, setStreaming] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentStopping, setAgentStopping] = useState(false);
  const [_agentRunId, setAgentRunId] = useState(null);
  const [reconnectedRun, setReconnectedRun] = useState(false);
  const agentRunIdRef = useRef(null);
  const [agentHeadless, setAgentHeadless] = useState(() => localStorage.getItem('agent_headless') !== 'false');
  const [agentMemory, setAgentMemory] = useState(() => localStorage.getItem('agent_memory') !== 'false');
  const [agentTrace, setAgentTrace] = useState([]);
  const [showReset, setShowReset] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [agentMobileTab, setAgentMobileTab] = useState('agent');
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [showSessions, setShowSessions] = useState(window.innerWidth >= DOCKED_LAYOUT_BREAKPOINT);
  const [agentStartedAt, setAgentStartedAt] = useState(null);
  // Agent 的模型集合、策略、headless、memory 目前是“应用级偏好”，
  // 不跟随 chat session 存储；chat session 只保存单模型对话所用的 model。
  const [selectedAgentModels, setSelectedAgentModels] = useState(() => {
    try {
      const saved = localStorage.getItem('agent_models');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  // Filter out models no longer available
  useEffect(() => {
    if (!modelsLoaded) {
      return;
    }
    // 只有在真正拿到后端模型列表之后才做清理：
    // 否则启动时会拿 DEFAULT_MODELS 这个占位值去过滤，
    // 把本地保存的多模型选择错误地写回成单模型。
    if (selectedAgentModels.length > 0 && availableModels.length > 0) {
      const valid = selectedAgentModels.filter(m => availableModels.some(avail => avail.id === m));
      if (valid.length !== selectedAgentModels.length) {
        setSelectedAgentModels(valid);
        localStorage.setItem('agent_models', JSON.stringify(valid));
      }
    }
  }, [availableModels, modelsLoaded, selectedAgentModels]);
  const [agentStrategy, setAgentStrategy] = useState(() => localStorage.getItem('agent_strategy') || 'race');

  const abortRef = useRef(null);
  const agentAbortRef = useRef(null);
  // 当前待审批/待回答的问题不只要进 state 展示，还要持有 resolve，
  // 方便 UI 按钮点击后继续推进被 Promise 阻塞的 Agent 流程。
  const approvalRequestRef = useRef(null);
  const questionRequestRef = useRef(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);
  const reconnectTaskRef = useRef(null);
  const lastAgentTaskRef = useRef(null);

  // 拉取后端可用模型。这里除了更新下拉/模型标签，
  // 还要顺手修正那些引用了已下线模型的历史聊天会话。
  useEffect(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data.models) && data.models.length > 0) {
          setAvailableModels(data.models);
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
      .catch(() => {})
      .finally(() => {
        setModelsLoaded(true);
      });
  }, []);

  const { sessions, activeSessionId } = chatState;
  const activeSession = sessions.find(session => session.id === activeSessionId) || sessions[0];
  const messages = activeSession.messages;
  const chatModel = activeSession.model;
  const selectedChatModelLabel = availableModels.find(item => item.id === chatModel)?.label || chatModel;
  const sessionLocked = streaming || agentRunning;

  // 会话历史和当前激活会话 id 都是持久化状态；这里统一落盘。
  useEffect(() => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    localStorage.setItem(ACTIVE_SESSION_KEY, activeSession.id);
    localStorage.removeItem(LEGACY_MESSAGES_KEY);
    localStorage.removeItem(LEGACY_MODEL_KEY);
  }, [activeSession.id, sessions]);

  useEffect(() => {
    localStorage.setItem(LAST_MODE_KEY, mode);
  }, [mode]);

  // 在移动端/窄屏时，会话侧栏和 Agent 面板会改变页面主色块区域。
  // 同步 <meta name="theme-color"> 是为了让浏览器地址栏颜色也跟着切换。
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;

    const isPhoneViewport = window.innerWidth <= PHONE_BREAKPOINT;
    const showSurfaceChrome = (isPhoneViewport && mode === 'agent' && agentMobileTab === 'agent')
      || (window.innerWidth < DOCKED_LAYOUT_BREAKPOINT && showSessions);

    meta.setAttribute('content', showSurfaceChrome ? APP_SURFACE_COLOR : APP_BG_COLOR);
  }, [mode, agentMobileTab, showSessions]);

  // 页面刷新后，如果后端还有运行中的 agent，这里会尝试“接回去”：
  // 1. 先查 /api/agent/active
  // 2. 再订阅 /api/agent/stream/:runId
  // 3. 同时把 UI 切回 Agent 模式，并用占位消息保住聊天视图连续性
  useEffect(() => {
    const controller = new AbortController();
    let aborted = false;

    // 订阅回调可能在很久之后才触发，不能依赖闭包里的 activeSession。
    // 每次都从最新 chatState 里拿 activeSessionId，避免事件写错会话。
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
        setAgentTrace([]);
        setReconnectedRun(true);
        setAgentStartedAt(data.startedAt || null);
        setAgentRunId(data.runId);
        agentRunIdRef.current = data.runId;
        setMode('agent');
        agentAbortRef.current = controller;

        // 刷新重连时，如果当前会话看起来不是这次 Agent 任务对应的会话，
        // 就临时创建一个“占位会话”承接运行态，避免把其他历史会话的消息替换掉。
        const task = data.task || 'Agent 任务';
        setChatState(prev => {
          const cur = prev.sessions.find(s => s.id === prev.activeSessionId);
          const firstUser = cur?.messages?.find(m => m.role === 'user');
          if (firstUser && firstUser.content === task) return prev;
          const cleanSession = createSession({
            messages: [
              { role: 'user', content: task, ts: data.startedAt || Date.now() },
              { role: 'assistant', content: 'Desktop Agent 正在执行任务，请稍候…', ts: Date.now() },
            ],
          });
          return normalizeChatState({
            sessions: [cleanSession, ...prev.sessions],
            activeSessionId: cleanSession.id,
          });
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
                if (event.task) reconnectTaskRef.current = event.task;
                continue;
              }

              // SSE 重连时同一批事件可能会回放两次；这里按关键字段去重，
              // 否则 trace 面板会出现重复步骤。
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

              if (event.type === 'rollback') {
                setAgentTrace(prev => {
                  const target = event.targetStep;
                  return prev.filter(e => (e.step == null && e.type !== 'done' && e.type !== 'error') || e.step <= target);
                });
              }

              if (event.type === 'done') {
                setAgentRunning(false);
                updateActiveSession(session => {
                  const msgs = [...session.messages];
                  const idx = (() => { for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'assistant' && msgs[i].content.includes('正在执行任务')) return i; } return -1; })();
                  if (idx >= 0) {
                    msgs[idx] = { role: 'assistant', content: event.answer || 'Agent 已完成任务。' };
                  } else if (!msgs.some(m => m.role === 'assistant' && m.content === (event.answer || ''))) {
                    msgs.push({ role: 'user', content: reconnectTaskRef.current || data.task || 'Agent 任务', ts: data.startedAt || Date.now() });
                    msgs.push({ role: 'assistant', content: event.answer || 'Agent 已完成任务。', ts: Date.now() });
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
    // 普通切换会话时，Agent trace 跟着 active session 走；
    // 但如果当前正处在“刷新后重连中的运行态”，不要被旧 session 覆盖掉。
    if (agentRunning) return;
    const savedTrace = activeSession.agentTrace || [];
    setAgentTrace(savedTrace);
    // Recover runId from saved trace (survives page refresh / backend restart)
    const runEvent = savedTrace.find(e => e.runId);
    if (runEvent) {
      agentRunIdRef.current = runEvent.runId;
      setAgentRunId(runEvent.runId);
    } else {
      agentRunIdRef.current = null;
      setAgentRunId(null);
    }
    // Recover last agent task text from session messages for rollback retry
    const lastUserMsg = [...(activeSession.messages || [])].reverse().find(m => m.role === 'user');
    lastAgentTaskRef.current = lastUserMsg?.content || null;
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
      // 页面卸载时同时中止 chat / agent 的网络流，
      // 也顺手拒绝掉所有等待中的审批 Promise，避免悬挂。
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
    if (saved && window.innerWidth >= DOCKED_LAYOUT_BREAKPOINT) {
      const panel = document.querySelector('.layout-body > .agent-panel-wrap');
      if (panel) panel.style.flex = `0 0 ${saved}px`;
    }
  }, []);

  useEffect(() => {
    // 这里统一处理窗口宽度变化带来的布局状态同步：
    // - 面板宽度在桌面端恢复拖拽值
    // - 平板/手机端自动关闭侧栏
    const syncResponsiveState = () => {
      const panel = document.querySelector('.layout-body > .agent-panel-wrap');
      if (panel) {
        if (window.innerWidth >= DOCKED_LAYOUT_BREAKPOINT) {
          const saved = localStorage.getItem(PANEL_SIZE_KEY);
          panel.style.flex = saved ? `0 0 ${saved}px` : '';
        } else {
          panel.style.flex = '';
        }
      }

      if (window.innerWidth < TABLET_BREAKPOINT) {
        setShowSessions(false);
      }
    };

    window.addEventListener('resize', syncResponsiveState);
    return () => window.removeEventListener('resize', syncResponsiveState);
  }, []);

  const stopGeneration = () => abortRef.current?.abort();
  const stopAgent = () => {
    // 停止 Agent 既要通知后端取消 run，也要尽快把前端 SSE 断掉。
    // 这里给一个很短的缓冲时间，让最后一两个 in-flight 事件有机会落到 UI。
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

  const fetchCheckpoints = async () => {
    try {
      const rid = agentRunIdRef.current;
      const url = rid ? `/api/agent/checkpoints?runId=${rid}` : '/api/agent/checkpoints';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
      }
    } catch { /* ignore fetch errors */ }
  };

  const handleRollback = async targetStep => {
    const rid = agentRunIdRef.current;
    console.log('[Rollback] targetStep:', targetStep, 'runId:', rid, 'running:', agentRunning);
    if (!rid) {
      console.warn('[Rollback] no runId, cannot rollback');
      return;
    }
    setRollbackLoading(true);
    try {
      if (agentRunning) {
        // Running task — use pendingRollback for in-place rollback
        const res = await fetch('/api/agent/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetStep }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || '回滚失败');
        }
      } else {
        // Finished task — restart from checkpoint
        setAgentTrace(prev => prev.filter(e => (e.step == null && e.type !== 'done' && e.type !== 'error') || e.step <= targetStep));
        await sendAgentTask(lastAgentTaskRef.current || '继续任务', {
          fromCheckpoint: { runId: rid, step: targetStep },
        });
      }
    } catch {
      alert('回滚请求失败');
    } finally {
      setRollbackLoading(false);
    }
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

  const setChatModel = nextModel => {
    updateSession(activeSession.id, session => touchSession(session, { model: nextModel }));
  };

  // 普通对话的核心流程：
  // 1. 先写入 user message + 一个空 assistant 占位
  // 2. 流式把 token 追加到最后一条 assistant 消息
  // 3. 中断/失败时把状态折叠成用户可见的文本结果
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
        model: chatModel,
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

  // Agent 流程和普通对话不一样：聊天区只保留“任务 + 最终回答”，
  // 详细的中间步骤全部写进 agentTrace，再由 AgentPanel 单独展示。
  const sendAgentTask = async (text, extraBody) => {
    const sessionId = activeSession.id;
    const isRetry = !!extraBody?.fromCheckpoint;
    lastAgentTaskRef.current = text;
    const history = isRetry ? messages : [...messages, { role: 'user', content: text, ts: Date.now() }];

    if (!isRetry) {
      updateSession(sessionId, session =>
        touchSession(session, {
          messages: [...history, { role: 'assistant', content: 'Desktop Agent 正在执行任务，请稍候…', ts: Date.now() }],
        })
      );
      setInput('');
      setAgentTrace([]);
    } else {
      // Retry from checkpoint — update chat placeholder to show re-executing
      updateSession(sessionId, session => {
        const msgs = [...session.messages];
        msgs.push({ role: 'assistant', content: 'Desktop Agent 正在从检查点重新执行任务…', ts: Date.now() });
        return touchSession(session, { messages: msgs });
      });
    }
    setAgentStartedAt(Date.now());
    setAgentRunning(true);
    setPendingApproval(null);

    const controller = new AbortController();
    agentAbortRef.current = controller;

    try {
      await streamAgentRun({
        task: text,
        // Agent 至少要有一个主模型。多模型时第一个模型作为主请求参数，
        // 完整模型集合再通过 models 传给后端做并发规划。
        model: selectedAgentModels.length > 0 ? selectedAgentModels[0] : chatModel,
        models: selectedAgentModels.length > 0
          ? selectedAgentModels.filter(m => availableModels.some(available => available.id === m))
          : [chatModel],
        strategy: selectedAgentModels.length > 1 ? agentStrategy : 'race',
        headless: agentHeadless,
        memory: agentMemory,
        signal: controller.signal,
        messages: history.slice(-10),
        ...extraBody,
        async onEvent(event) {
          console.log(`[AgentUI] event type=${event.type} step=${event.step ?? '-'} stage=${event.stage ?? '-'} model=${event.model || '-'}`);
          setAgentTrace(prev => {
            // Deduplicate: same type+step+stage+model already exists
            const key = `${event.type}:${event.step ?? ''}:${event.stage ?? ''}:${event.model ?? ''}`;
            if (prev.some(e => `${e.type}:${e.step ?? ''}:${e.stage ?? ''}:${e.model ?? ''}` === key)) {
              console.log(`[AgentUI] DEDUP skipped: ${key}`);
              return prev;
            }
            return [...prev, event];
          });

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

          if (event.type === 'rollback') {
            setAgentTrace(prev => {
              const target = event.targetStep;
              return prev.filter(e => (e.step == null && e.type !== 'done' && e.type !== 'error') || e.step <= target);
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
      // SSE 可能断连导致 done/error 事件丢失，检查占位消息是否未被替换
      setAgentTrace(prev => {
        const doneEvent = prev.find(e => e.type === 'done');
        const errorEvent = prev.find(e => e.type === 'error');
        if (doneEvent || errorEvent) {
          updateSession(sessionId, session => {
            const msgs = session.messages;
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant' && msgs[lastIdx].content.includes('正在执行任务')) {
              const next = [...msgs];
              if (doneEvent) {
                next[lastIdx] = { role: 'assistant', content: doneEvent.answer || 'Agent 已完成任务。' };
              } else {
                next[lastIdx] = { role: 'assistant', content: `⚠️ Desktop Agent 失败：${errorEvent.error || '连接中断'}` };
              }
              return touchSession(session, { messages: next, agentTrace: prev });
            }
            return touchSession(session, { agentTrace: prev });
          });
        } else if (prev.length === 0 || !prev.some(e => e.type === 'done' || e.type === 'error')) {
          // No events received at all or SSE disconnected without done/error
          updateSession(sessionId, session => {
            const msgs = session.messages;
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant' && msgs[lastIdx].content.includes('正在执行任务')) {
              const next = [...msgs];
              next[lastIdx] = { role: 'assistant', content: '⚠️ Desktop Agent 连接中断，未收到执行结果。' };
              return touchSession(session, { messages: next, agentTrace: prev });
            }
            return touchSession(session, { agentTrace: prev });
          });
        }
        return prev;
      });

      agentAbortRef.current = null;
      // Keep agentRunIdRef for post-task checkpoint queries
      setAgentRunning(false);
      setAgentStopping(false);
      setReconnectedRun(false);
      setPendingApproval(null);
      approvalRequestRef.current = null;
      if (window.innerWidth < PHONE_BREAKPOINT) setAgentMobileTab('chat');
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || sessionLocked) {
      return;
    }

    // 同一输入框根据 mode 分流到两套完全不同的执行链路。
    if (mode === 'agent') {
      await sendAgentTask(text);
      return;
    }

    await sendChatMessage(text);
  };

  const handleKeyDown = e => {
    const isMobile = window.innerWidth < TABLET_BREAKPOINT;
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
    setSelectedAgentModels(prev => {
      const next = prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id];
      localStorage.setItem('agent_models', JSON.stringify(next));
      return next;
    });
  };

  const moveAgentModel = (id, dir) => {
    setSelectedAgentModels(prev => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const next = [...prev];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      localStorage.setItem('agent_models', JSON.stringify(next));
      return next;
    });
  };

  const modelSelect = !sessionStarted
    ? mode === 'agent' ? (
      <div className="model-tags-wrap">
        <div className="model-tags">
          {availableModels.map(item => {
            const isSelected = selectedAgentModels.includes(item.id);
            const orderIdx = selectedAgentModels.indexOf(item.id);
            return (
              <span key={item.id} className={`model-tag-wrapper ${isSelected ? 'selected' : ''}`}>
                <button
                  className={`model-tag ${isSelected ? 'selected' : ''}`}
                  onClick={() => toggleAgentModel(item.id)}
                  disabled={sessionLocked}
                  title={isSelected ? '取消选择' : '选择并发执行'}
                >
                  {item.label}
                </button>
                {isSelected && selectedAgentModels.length > 1 && (
                  <span className="model-tag-order">
                    <button className="order-arrow" onClick={() => moveAgentModel(item.id, -1)} disabled={orderIdx <= 0 || sessionLocked} title="提高优先级"><ChevronUp size={10} /></button>
                    <span className="order-number">{orderIdx + 1}</span>
                    <button className="order-arrow" onClick={() => moveAgentModel(item.id, 1)} disabled={orderIdx >= selectedAgentModels.length - 1 || sessionLocked} title="降低优先级"><ChevronDown size={10} /></button>
                  </span>
                )}
              </span>
            );
          })}
        </div>
        {selectedAgentModels.length > 1 && (
          <div className="strategy-toggle">
            <button
              className={`strategy-btn ${agentStrategy === 'race' ? 'active' : ''}`}
              onClick={() => { setAgentStrategy('race'); localStorage.setItem('agent_strategy', 'race'); }}
              disabled={sessionLocked}
              title="按优先级分批启动，先到先得"
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
      <select className="model-select" value={chatModel} onChange={e => setChatModel(e.target.value)} title="切换模型">
        {availableModels.map(item => (
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

  const showHero = messages.length === 0 && !agentRunning;

  return (
    <ErrorBoundary>
    <div className="app-shell">
      <div className={`sidebar ${showSessions ? 'open' : ''}`}>
        <SessionList
          sessions={sessions}
          activeSessionId={activeSession.id}
          modelList={availableModels}
          onCreate={handleCreateSession}
          onDelete={handleDeleteSession}
          onClearAll={handleClearAllSessions}
          onSelect={(id) => { handleSelectSession(id); if (window.innerWidth < 768) setShowSessions(false); }}
          locked={sessionLocked}
        />
      </div>
      <button
        className={`sidebar-backdrop ${showSessions ? 'visible' : ''}`}
        onClick={() => setShowSessions(false)}
        aria-label="关闭会话列表"
      />

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
              {shuffled(SUGGESTIONS[mode]).slice(0, mode === 'agent' ? 8 : 4).map(s => (
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
              {sessionStarted && mode !== 'agent' && (
                <span className="header-model-label">{selectedChatModelLabel}</span>
              )}
              <button className="header-icon-btn" onClick={() => setShowReset(true)} title="清空" disabled={messages.length === 0 || sessionLocked}><Trash2 size={14} /></button>
            </div>
          </div>

          <div className={`layout-body ${mode === 'agent' ? 'agent-layout' : 'chat-layout'}`}>
          {mode === 'agent' && (
            <>
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
              <div className={`agent-panel-wrap ${agentMobileTab === 'chat' ? 'mobile-hidden' : ''}`}>
                <AgentPanel
                  mode={mode}
                  running={agentRunning}
                  trace={agentTrace}
                  headless={agentHeadless}
                  startedAt={agentStartedAt}
                  modelList={availableModels}
                  collapsed={agentCollapsed}
                  onToggleCollapse={() => setAgentCollapsed(c => !c)}
                  onHeadlessChange={v => {
                    setAgentHeadless(v);
                    localStorage.setItem('agent_headless', String(v));
                  }}
                  onStop={stopAgent}
                  agentStopping={agentStopping}
                  pendingApproval={pendingApproval}
                  onToggleMemory={() => setShowMemoryPanel(v => !v)}
                  showMemoryPanel={showMemoryPanel}
                  onRollback={handleRollback}
                  rollbackLoading={rollbackLoading}
                />
              </div>

              <ResizeDivider side="agent" />
            </>
          )}

          {messages.length > 0 && (
            <div className={`chat-panel-wrap ${mode === 'agent' && agentMobileTab === 'agent' ? 'mobile-hidden' : ''}`}>
              <div className="messages">
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
