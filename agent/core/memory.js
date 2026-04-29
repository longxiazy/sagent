/**
 * Memory — Agent 跨会话记忆系统，让 Agent 积累项目经验和用户偏好
 *
 * 存储内容：
 *   - conversation: 最近 N 次任务的摘要（任务 → 结果）
 *   - conversationSummary: 早期任务的压缩摘要
 *   - projectKnowledge: 项目结构、常用路径、用户偏好、经验积累
 *
 * 记忆会被注入到 Agent 的 systemPrompt 中，让 Agent 知道之前做过什么。
 * 例如：Agent 记得上次项目用了哪些文件，就不用重新搜索。
 *
 * 调用场景：
 *   - routes/agent.js POST /api/agent 开始前：loadMemory → buildMemoryPrompt 注入 systemPrompt
 *   - routes/agent.js 任务完成后：extractConversationEntry → extractProjectKnowledge → saveMemory
 *   - 超过 20 条记录时 compactConversationMemory 自动压缩旧记录
 *
 * 存储位置：{MEMORY_DIR}/agent-memory.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanText } from './utils.js';

const MEMORY_FILE = 'agent-memory.json';
const MAX_CHARS = 3000;
const MAX_CONVERSATION_ENTRIES = 20;
const MAX_KNOWLEDGE_PER_CATEGORY = 50;

function emptyMemory() {
  return {
    version: 1,
    conversation: [],
    conversationSummary: '',
    lastCompactedAt: '',
    projectKnowledge: {
      structure: [],
      paths: {},
      preferences: [],
      learnings: [],
    },
  };
}

export async function loadMemory(dir) {
  const filePath = path.join(dir, MEMORY_FILE);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...emptyMemory(),
      ...parsed,
      projectKnowledge: {
        ...emptyMemory().projectKnowledge,
        ...(parsed.projectKnowledge || {}),
      },
    };
  } catch {
    return emptyMemory();
  }
}

export async function saveMemory(dir, memory) {
  const filePath = path.join(dir, MEMORY_FILE);
  const tmpPath = filePath + '.tmp';
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(memory, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return `${Math.floor(days / 30)}月前`;
}

export function buildMemoryPrompt(memory, { maxChars = MAX_CHARS } = {}) {
  const parts = [];

  // Conversation memory
  const convLines = [];
  if (memory.conversationSummary) {
    convLines.push(`(早期) ${memory.conversationSummary}`);
  }
  const recent = memory.conversation.slice(-8);
  for (const entry of recent) {
    const taskShort = cleanText(entry.task || '', 60);
    const summaryShort = cleanText(entry.summary || '', 80);
    const ago = formatTimeAgo(entry.timestamp);
    convLines.push(`- ${taskShort} → ${summaryShort} (${ago})`);
  }
  if (convLines.length > 0) {
    parts.push(`最近的任务:\n${convLines.join('\n')}`);
  }

  // Project knowledge
  const pk = memory.projectKnowledge || {};
  const knowledgeLines = [];
  if (pk.structure?.length) {
    knowledgeLines.push(`- 结构: ${pk.structure.slice(-5).join('; ')}`);
  }
  if (pk.paths && Object.keys(pk.paths).length) {
    const pathStr = Object.entries(pk.paths)
      .slice(-8)
      .map(([k, v]) => `${v}`)
      .join(', ');
    knowledgeLines.push(`- 常用路径: ${pathStr}`);
  }
  if (pk.preferences?.length) {
    knowledgeLines.push(`- 偏好: ${pk.preferences.slice(-5).join('; ')}`);
  }
  if (pk.learnings?.length) {
    knowledgeLines.push(`- 经验: ${pk.learnings.slice(-5).join('; ')}`);
  }
  if (knowledgeLines.length > 0) {
    parts.push(`项目知识:\n${knowledgeLines.join('\n')}`);
  }

  if (parts.length === 0) {
    return '';
  }

  let result = `[Agent 记忆]\n${parts.join('\n\n')}`;

  if (result.length > maxChars) {
    result = result.slice(0, maxChars);
    const lastNewline = result.lastIndexOf('\n');
    if (lastNewline > maxChars * 0.7) {
      result = result.slice(0, lastNewline);
    }
    result += '\n...';
  }

  return result;
}

export function extractConversationEntry({ task, result, model, stepModels }) {
  const steps = result?.steps || [];
  const filesTouched = [];
  const toolsUsed = new Set();
  const usedModels = new Set();

  for (const step of steps) {
    const action = step.action;
    if (!action) continue;
    toolsUsed.add(action.type || '?');
    if (action.tool === 'fs' && action.path) {
      filesTouched.push(action.path);
    }
    if (action.tool === 'terminal' && action.command) {
      const fileHints = action.command.match(/[\w./-]+\.\w+/g);
      if (fileHints) {
        filesTouched.push(...fileHints);
      }
    }
    if (stepModels && step.step != null && stepModels[step.step]) {
      usedModels.add(stepModels[step.step]);
    }
  }

  return {
    task: cleanText(task || '', 80),
    summary: cleanText(result?.answer || '', 120),
    filesTouched: [...new Set(filesTouched)].slice(0, 10),
    toolsUsed: [...toolsUsed],
    models: [...usedModels],
    model: model || '',
    timestamp: new Date().toISOString(),
  };
}

export function extractProjectKnowledge(memory, { task, result }) {
  const pk = memory.projectKnowledge;
  const steps = result?.steps || [];

  for (const step of steps) {
    const action = step.action;
    if (!action) continue;

    // Learn directory structures from list_dir results
    if (action.type === 'list_dir' && step.result) {
      const dirInfo = cleanText(step.result, 120);
      const existing = pk.structure || [];
      if (!existing.some(e => e.includes(action.path || '.'))) {
        pk.structure = [...existing, dirInfo].slice(-MAX_KNOWLEDGE_PER_CATEGORY);
      }
    }

    // Learn file paths from read_file / write_file
    if (action.type === 'read_file' || action.type === 'write_file') {
      if (action.path) {
        const key = action.path.split('/').pop().replace(/\.\w+$/, '') || 'file';
        pk.paths[key] = action.path;
      }
    }

    // Learn from search results
    if (action.type === 'search_files' && action.path) {
      pk.paths['searchRoot'] = action.path;
    }

    // Learn preferences from terminal commands
    if (action.type === 'run_safe' || action.type === 'run_confirmed') {
      const cmd = action.command || '';
      const editorMatch = cmd.match(/^(nano|vim|code|subl|emacs)\b/);
      if (editorMatch && !pk.preferences.some(p => p.includes('编辑器'))) {
        pk.preferences.push(`常用编辑器: ${editorMatch[1]}`);
        pk.preferences = pk.preferences.slice(-MAX_KNOWLEDGE_PER_CATEGORY);
      }
    }
  }

  // Extract task-level learnings from the answer
  const answer = result?.answer || '';
  if (answer.length > 20) {
    const learnings = pk.learnings || [];
    // Only add if there's a file path in the answer (indicates a meaningful finding)
    const fileRefs = answer.match(/[\w./-]+\.\w{2,4}/g);
    if (fileRefs && fileRefs.length > 0 && learnings.length < MAX_KNOWLEDGE_PER_CATEGORY) {
      const finding = cleanText(answer, 80);
      if (!learnings.some(l => l === finding)) {
        pk.learnings = [...learnings, finding].slice(-MAX_KNOWLEDGE_PER_CATEGORY);
      }
    }
  }
}

export async function compactConversationMemory(memory, { maxEntries = MAX_CONVERSATION_ENTRIES, summarizeFn } = {}) {
  const conv = memory.conversation;
  if (conv.length <= maxEntries) {
    return;
  }

  const allText = conv
    .map(e => `${cleanText(e.task || '', 60)} → ${cleanText(e.summary || '', 80)}`)
    .join('\n');

  const input = memory.conversationSummary
    ? `${memory.conversationSummary}\n\n--- 历史记录 ---\n${allText}`
    : allText;

  if (summarizeFn) {
    try {
      memory.conversationSummary = await summarizeFn(input);
    } catch {
      memory.conversationSummary = input.replace(/\n/g, '; ').slice(0, 2000);
    }
  } else {
    memory.conversationSummary = input.replace(/\n/g, '; ').slice(0, 2000);
  }

  memory.conversation = conv.slice(-maxEntries);
  memory.lastCompactedAt = new Date().toISOString();
}
