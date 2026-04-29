/**
 * Response Parsers — 工厂模式的模型响应解析器
 *
 * 不同模型通过 NVIDIA API 返回的响应格式各异：
 *   - 有些用标准 tool_calls（理论上支持，实际很少触发）
 *   - 有些把 JSON 放在 content 字段里（Nemotron, Kimi, Qwen, MiniMax）
 *   - MiniMax 有时用自定义 [TOOL_CALL] 块或 XML 格式
 *   - Nemotron/Kimi 有 reasoning 字段记录思维链
 *
 * 工厂 createModelResponseParser(model) 根据模型 ID 返回对应的解析器，
 * 每个解析器按配置的策略链依次尝试解析，第一个命中即返回。
 *
 * 五种解析策略：
 *   1. tryToolCalls      — 标准 OpenAI tool_calls 格式
 *   2. tryToolCallBlocks — MiniMax 自定义 [TOOL_CALL]...[/TOOL_CALL] 格式
 *   3. tryXmlToolCalls   — MiniMax XML <minimax:tool_call> 格式
 *   4. tryJsonContent    — 从 content 字段提取 JSON 对象
 *   5. tryTextFinish     — 兜底：把纯文本当作 finish 动作
 *
 * 调用场景：
 *   - planner.js 的 createJsonPlanner() 每次收到 LLM 响应后调用 parser(response)
 *   - 同一个 parser 实例也会用于解析重试响应
 */

import { cleanText } from './utils.js';

// ── JSON Parsing ──

function tryParseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractFirstJsonObject(source) {
  const direct = tryParseJsonObject(source);
  if (direct) return direct;

  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let end = start; end < source.length; end += 1) {
      const char = source[end];

      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') { inString = true; continue; }
      if (char === '{') { depth += 1; continue; }
      if (char !== '}') continue;
      depth -= 1;
      if (depth !== 0) continue;

      const candidate = source.slice(start, end + 1);
      const parsed = tryParseJsonObject(candidate);
      if (parsed) return parsed;
      break;
    }
  }

  return null;
}

function parseJsonObject(text) {
  if (typeof text !== 'string') throw new Error('模型未返回文本');

  let source = text.trim();
  source = source.replace(/([&?])(extractLinks)("\s*:\s*true)/gi, '$1$2=true"');

  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = extractFirstJsonObject(fenced[1].trim());
    if (parsed) return parsed;
  }

  const direct = extractFirstJsonObject(source);
  if (direct) return direct;

  const cleaned = source.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g, '');
  const afterClean = extractFirstJsonObject(cleaned);
  if (afterClean) return afterClean;

  throw new Error(`模型输出不是有效 JSON 对象: ${cleanText(source, 280)}`);
}

function getMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// ── MiniMax Tool Call Block Parsing ──

function parseToolCallBlock(raw) {
  const trimmed = raw.trim();
  const obj = tryParseJsonObject(trimmed);

  if (obj) {
    if (obj.rationale !== undefined && obj.action && typeof obj.action === 'object') {
      const { tool, type, ...rest } = obj.action;
      return { name: tool, type, ...rest, _rationale: obj.rationale };
    }
    if (obj.tool) {
      const args = obj.args || {};
      if (args.type) {
        const { type, ...rest } = args;
        return { name: obj.tool, type, ...rest };
      }
      if (obj.type) {
        const { tool, type, rationale, ...rest } = obj;
        return { name: tool, type, ...rest, ...(rationale ? { _rationale: rationale } : {}) };
      }
      return { name: obj.tool, type: null };
    }
    if (obj.type) {
      const { type, ...rest } = obj;
      return { name: null, type, ...rest };
    }
    return null;
  }

  const colonMatch = trimmed.match(/^\{[\s\S]*?tool\s*=>\s*"([^"]+)"[\s\S]*?args\s*=>\s*\{([\s\S]*?)\}\s*\}$/);
  if (colonMatch) {
    const toolName = colonMatch[1];
    const argsStr = colonMatch[2];
    const args = {};
    const kvRe = /--(\w+)\s+"([^"]*)"/g;
    let m;
    while ((m = kvRe.exec(argsStr)) !== null) {
      args[m[1]] = m[2];
    }
    return { name: toolName, type: args.type || null, ...args };
  }

  return null;
}

// ── Parsing Strategies ──
// Each: (message, content) → { rationale?, action } | null

function tryToolCalls(message) {
  const toolCalls = message?.tool_calls || [];
  if (toolCalls.length === 0) return null;

  const toolCall = toolCalls[0];
  let input = toolCall.function.arguments;
  if (typeof input === 'string') {
    input = JSON.parse(input);
  }
  return { action: { type: toolCall.function.name, ...input } };
}

function tryToolCallBlocks(_message, content) {
  const blocks = content.match(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g);
  if (!blocks || blocks.length === 0) return null;

  const calls = [];
  let rationale = null;

  for (const block of blocks) {
    const raw = block
      .replace(/^\[TOOL_CALL\]/, '')
      .replace(/\[\/TOOL_CALL\]$/, '');
    const noFence = raw.replace(/```[^\n]*\n?/g, '').trim();
    const parsed = parseToolCallBlock(noFence);
    if (!parsed) continue;
    rationale = parsed._rationale || rationale;
    if (parsed.name) {
      calls.push({ name: parsed.name, input: { type: parsed.type, ...parsed } });
    } else if (parsed.type) {
      calls.push({ name: parsed.type, input: { type: parsed.type, ...parsed } });
    }
  }

  if (calls.length === 0) return null;
  const first = calls[0];
  return { rationale, action: { type: first.name, ...first.input } };
}

function tryXmlToolCalls(_message, content) {
  const xmlBlocks = content.match(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g);
  if (!xmlBlocks || xmlBlocks.length === 0) return null;

  const calls = [];
  for (const block of xmlBlocks) {
    const outerRe = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
    let outerMatch;
    while ((outerMatch = outerRe.exec(block)) !== null) {
      const toolName = outerMatch[1];
      const inner = outerMatch[2];
      const innerRe = /<invoke\s+name="([^"]+)"((?:\s+\w+="[^"]*")*)\s*\/>/g;
      let innerMatch;
      while ((innerMatch = innerRe.exec(inner)) !== null) {
        const actionType = innerMatch[1];
        const attrsStr = innerMatch[2];
        const attrs = {};
        const attrRe = /(\w+)="([^"]*)"/g;
        let attrMatch;
        while ((attrMatch = attrRe.exec(attrsStr)) !== null) {
          attrs[attrMatch[1]] = attrMatch[2];
        }
        calls.push({ name: toolName, input: { type: actionType, ...attrs } });
      }
    }
  }

  if (calls.length === 0) return null;
  const first = calls[0];
  return { action: { type: first.input.type, tool: first.name, ...first.input } };
}

function tryJsonContent(_message, content) {
  try {
    const parsed = parseJsonObject(content);
    if (parsed.action && typeof parsed.action === 'object') {
      return parsed;
    }
    if (parsed.tool || parsed.type) {
      return { action: parsed };
    }
    return parsed;
  } catch {
    return null;
  }
}

function looksLikeSubstantiveAnswer(text) {
  const firstLine = text.split('\n')[0].trim();
  if (/^(我需要|让我先|请稍|我想|首先|好的[，,]|明白了|I need|Let me|I'll|Wait)/i.test(firstLine)) return false;
  if (/^[^！!。.]*[？?]$/.test(firstLine) && text.length < 200) return false;
  const hasChineseSentence = /[。！；：]/.test(text) && text.length >= 80;
  const hasStructure = /\n/.test(text) && text.length >= 100;
  const hasListItems = /^[•\-\d][\s、]/m.test(text);
  const hasFilePath = /[\w./]+\.\w{1,6}/.test(text) && text.length >= 80;
  return hasChineseSentence || hasStructure || hasListItems || hasFilePath;
}

function tryTextFinish(_message, content) {
  const trimmed = content.trim();
  const isLikelyBrokenJson = trimmed.startsWith('{') && /"(rationale|action|tool|type)"/.test(trimmed);
  if (isLikelyBrokenJson) return null;
  if (trimmed.length >= 80 && looksLikeSubstantiveAnswer(trimmed)) {
    return { rationale: '模型直接输出了完整回答', action: { type: 'finish', answer: trimmed } };
  }
  return null;
}

// ── Model Configurations ──

const STRATEGIES = {
  toolCalls: tryToolCalls,
  toolCallBlocks: tryToolCallBlocks,
  xmlToolCalls: tryXmlToolCalls,
  jsonContent: tryJsonContent,
  textFinish: tryTextFinish,
};

const MODEL_CONFIGS = {
  // MiniMax: supports custom [TOOL_CALL] blocks and XML format
  'minimaxai/minimax-m2.7': {
    chain: ['toolCalls', 'toolCallBlocks', 'xmlToolCalls', 'jsonContent', 'textFinish'],
  },
  // Nemotron: JSON in content, has reasoning/reasoning_content fields
  'nvidia/nemotron-3-super-120b-a12b': {
    chain: ['toolCalls', 'jsonContent', 'textFinish'],
    extractReasoning: true,
  },
  // Kimi: JSON in content, has reasoning field
  'moonshotai/kimi-k2.5': {
    chain: ['toolCalls', 'jsonContent', 'textFinish'],
    extractReasoning: true,
  },
  // Qwen: standard tool_calls or JSON in content
  'qwen/qwen3.5-397b-a17b': {
    chain: ['toolCalls', 'jsonContent', 'textFinish'],
  },
  // Llama: standard tool_calls or JSON in content
  'meta/llama-3.3-70b-instruct': {
    chain: ['toolCalls', 'jsonContent', 'textFinish'],
  },
  // Gemma: standard tool_calls or JSON in content
  'google/gemma-4-31b-it': {
    chain: ['toolCalls', 'jsonContent', 'textFinish'],
  },
};

const DEFAULT_CONFIG = {
  chain: ['toolCalls', 'toolCallBlocks', 'jsonContent', 'textFinish'],
};

// ── Factory ──

export function createModelResponseParser(model) {
  const config = MODEL_CONFIGS[model] || DEFAULT_CONFIG;
  const chain = config.chain.map(name => STRATEGIES[name]);
  const extractReasoning = config.extractReasoning || false;

  return function parseResponse(response) {
return function parseResponse(response) {
    const message = response.choices[0]?.message;
    const content = getMessageText(message?.content);
    const usage = response.usage || null;
    const reasoning = extractReasoning ? (message?.reasoning || message?.reasoning_content || null) : null;

    // Check if message has BOTH text narration AND tool_calls (Zeroclaw #5584)
    const messageContent = message?.content;
    const hasNarration = Array.isArray(messageContent)
      ? messageContent.some(b => b.type === 'text' && b.text?.trim())
      : (typeof content === 'string' && content.trim().length > 0);
    const hasToolCalls = (message?.tool_calls?.length ?? 0) > 0;

    for (const strategy of chain) {
      const result = strategy(message, content);
      if (result) {
        return {
          ...result,
          usage,
          reasoning,
          rawContent: content,
          // Mark coexist to trigger dedup on frontend
          _hasNarrationAndToolCalls: (hasNarration && hasToolCalls) ? content.slice(0, 200) : null,
        };
      }
    }
    return { parseFailed: true, rawContent: content, usage, reasoning };
  };
};
    for (const strategy of chain) {
      const result = strategy(message, content);
      if (result) {
        return { ...result, usage, reasoning, rawContent: content };
      }
    }

    return { parseFailed: true, rawContent: content, usage, reasoning };
  };
}
