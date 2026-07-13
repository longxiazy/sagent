/**
 * Memory — Agent 跨会话记忆系统 / Cross-session memory system
 *
 * 让 Agent 积累项目经验和用户偏好，跨会话持久化。
 * Persists project knowledge across sessions.
 *
 * 存储内容 / Storage:
 *   - projectKnowledge: 项目结构、常用路径、用户偏好、经验积累
 *
 * 注入方式 / Injection:
 *   buildMemoryPrompt() 将记忆注入 Agent 的 systemPrompt（上限 3000 字）
 *
 * 调用场景 / Callers:
 *   - routes/agent.js POST /api/agent 开始前: loadMemory → buildMemoryPrompt
 *   - routes/agent.js 任务完成后: extractProjectKnowledge → saveMemory
 *   - routes/agent.js GET /api/agent/memory: 返回完整记忆数据供前端展示
 *
 * 存储位置: {MEMORY_DIR}/agent-memory.json
 *
 * TODO: 将知识提取拆为可插拔模块。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanText } from './utils.ts';

const MEMORY_FILE = 'agent-memory.json';
const MAX_CHARS = 3000;
const MAX_KNOWLEDGE_PER_CATEGORY = 50;

function emptyMemory() {
  return {
    version: 1,
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

export function buildMemoryPrompt(memory, { maxChars = MAX_CHARS } = {}) {
  const parts = [];

  // Project knowledge
  const pk = memory.projectKnowledge || {};
  const knowledgeLines = [];
  if (pk.structure?.length) {
    knowledgeLines.push(`- 结构: ${pk.structure.slice(-5).join('; ')}`);
  }
  if (pk.paths && Object.keys(pk.paths).length) {
    const pathStr = Object.entries(pk.paths)
      .slice(-8)
      .map(([_k, v]) => `${v}`)
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

export function extractProjectKnowledge(memory, { task: _task, result }) {
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

export async function clearMemory(dir) {
  const fresh = emptyMemory();
  await saveMemory(dir, fresh);
  return fresh;
}

export async function clearProjectKnowledge(dir) {
  const memory = await loadMemory(dir);
  memory.projectKnowledge = emptyMemory().projectKnowledge;
  await saveMemory(dir, memory);
  return memory;
}
