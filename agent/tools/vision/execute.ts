/**
 * Vision Tool — image_analyze 工具实现
 *
 * 把一张图片（本地路径或 http(s) URL）转成 data URL，
 * 优先调用本次 Agent 选择的可视觉模型，否则回退到 VISION_MODEL，
 * 让模型针对 question 给出回答（一次性单轮调用，不进入主 agent loop）。
 *
 * 默认模型: meta/llama-3.2-90b-vision-instruct（NIM 上常驻的视觉模型）
 *   可通过环境变量 VISION_MODEL 覆盖，例如 meta/llama-3.2-11b-vision-instruct
 *   或 microsoft/phi-3.5-vision-instruct。
 *
 * 调用场景：
 *   - 主 agent loop 中模型返回 { tool: 'vision', type: 'image_analyze', image, question }
 *   - 由 desktop/agent.ts 的 actionRouter 路由到此处
 *
 * 返回值契约：
 *   本工具的返回字符串会被主 loop 当作该步的 result 写入 history，并参与后续决策，
 *   因此「拿不到内容」与「内容不完整」必须在文本里可分辨——否则模型只能靠猜，
 *   要么把半截结论当定论，要么对同一张图反复重试直到触发循环保护。
 *   为此约定三种形态：
 *     - 正常：image_analyze 结果（model=…）
 *     - 降级：image_analyze 结果（model=…，仅推理内容）——正文通道为空时的兜底
 *     - 失败：image_analyze 模型 … 未返回内容 / image_analyze 失败：…
 *   前两种在输出被长度上限截断时，额外追加 TRUNCATION_NOTICE。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelInfo } from '../../core/providers/types.ts';
import { createAbortScope, throwIfAborted } from '../../core/abort.ts';
import type { ActionForTool } from '../../core/contracts.ts';
import type { ProviderRegistry } from '../../core/providers/registry.ts';

const REQUEST_TIMEOUT_MS = 60000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
// 识图往往要逐项描述图中内容，输出长度远高于一次决策；且推理型模型会先消耗
// 一部分预算在推理通道上，留给正文的额度更少。预算过紧会让回答在中途被硬切。
const MAX_OUTPUT_TOKENS = 4096;
const TRUNCATION_NOTICE = '\n\n[注意] 上述回答因达到输出长度上限而被截断，内容不完整。';
export const DEFAULT_VISION_MODEL = 'meta/llama-3.2-90b-vision-instruct';

const VISION_ANALYSIS_GUIDE = [
  '请严格基于图片可见内容回答。',
  '把可见事实和低置信猜测分开；如果无法可靠确认具体作品、游戏、地点、人物或品牌名称，请明确说“无法仅凭这张图确认”。',
  '不要编造图片里没有的 UI、文字、按钮、角色名、怪物、道具或数值。',
  '识别具体来源时，只有在图片中存在清晰文字、标志、独特角色/场景或其它强证据时才给出确定结论；否则给出可能类别和不确定性。',
].join('\n');

function mimeFromExt(target: string): string {
  const cleaned = String(target).toLowerCase().split('?')[0].split('#')[0];
  const ext = cleaned.split('.').pop();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  return 'image/png';
}

// 依据文件头魔数识别常见图片类型，用于扩展名/content-type 不可靠时的兜底，
// 避免把非 png 图片一律标成 image/png 送给严格的 provider。
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

interface VisionContext {
  registry?: Pick<ProviderRegistry, 'resolve'>;
  openai_client?: unknown;
  modelConfig?: ModelInfo[];
  visionModel?: string;
  model?: string;
  models?: string[];
  agentModels?: string[];
  selectedModels?: string[];
  signal?: AbortSignal;
  projectRoot?: string | null;
  dataDir?: string | null;
  /** 当前任务描述；模型漏填 question 时作为兜底提问。 */
  task?: string | null;
}

type CompletionLike = {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
    finish_reason?: unknown;
  }>;
};
type OpenAIClientLike = {
  chat: { completions: { create(request: unknown, options?: { signal?: AbortSignal }): Promise<unknown> } };
};

function asOpenAIClient(value: unknown): OpenAIClientLike | null {
  if (!value || typeof value !== 'object') return null;
  const chat = (value as Record<string, unknown>).chat;
  if (!chat || typeof chat !== 'object') return null;
  const completions = (chat as Record<string, unknown>).completions;
  if (!completions || typeof completions !== 'object') return null;
  return typeof (completions as Record<string, unknown>).create === 'function'
    ? value as OpenAIClientLike
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean)
    : [];
}

// 兼容 content 为字符串或分段数组（[{type:'text',text}]）两种返回形态。
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
          return (part as Record<string, string>).text;
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

// 不同 OpenAI 兼容端点对推理通道的字段命名不一致，逐个尝试已知别名。
function extractReasoningText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const source = message as Record<string, unknown>;
  for (const value of [source.reasoning_content, source.reasoning]) {
    const text = extractMessageText(value);
    if (text) return text;
  }
  return '';
}

function uniqueModels(values: unknown[]): string[] {
  return [...new Set(values
    .flatMap(value => Array.isArray(value) ? value : [value])
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean))];
}

function findModelInfo(model: string, modelConfig: ModelInfo[] = []) {
  return modelConfig.find(item => (
    item?.id === model
    || asStringArray(item?.aliases).includes(model)
  )) || null;
}

function modelSupportsImageInput(model: string, modelConfig: ModelInfo[] = []) {
  const info = findModelInfo(model, modelConfig);
  const inputs = asStringArray(info?.inputModalities)
    .map(item => item.toLowerCase());
  const outputs = asStringArray(info?.outputModalities)
    .map(item => item.toLowerCase());

  if (outputs.length > 0 && !outputs.includes('text')) return false;
  if (inputs.includes('image')) return true;
  if (inputs.length > 0) return false;

  const haystack = [
    model,
    info?.label,
    info?.description,
    info?.provider,
  ].filter(Boolean).join(' ').toLowerCase();

  return /^gemini-/i.test(model)
    || /\b(vision|vlm|multimodal|multi-modal|omni-modal)\b/i.test(haystack)
    || /image (understanding|input|analysis)|understands? images?|text\/img/i.test(haystack);
}

export function resolveVisionModel(context: VisionContext = {}) {
  const modelConfig = Array.isArray(context.modelConfig) ? context.modelConfig : [];
  const selectedModels = uniqueModels([
    context.model,
    context.models,
    context.agentModels,
    context.selectedModels,
  ]);
  const selectedVisionModel = selectedModels.find(model => modelSupportsImageInput(model, modelConfig));
  if (selectedVisionModel) {
    return { model: selectedVisionModel, source: 'selected' };
  }

  return {
    model: String(context.visionModel || process.env.VISION_MODEL || DEFAULT_VISION_MODEL).trim(),
    source: 'fallback',
  };
}

async function toImageDataUrl(
  image: string,
  signal?: AbortSignal,
  projectRoot?: string | null,
  dataDir?: string | null,
): Promise<string> {
  throwIfAborted(signal);
  if (/^data:image\//i.test(image)) {
    // data URL 分支也要做大小限制，否则可构造超大 data URL 绕过 10MB 上限。
    const comma = image.indexOf(',');
    const meta = comma >= 0 ? image.slice(5, comma) : '';
    const payload = comma >= 0 ? image.slice(comma + 1) : '';
    const approxBytes = /;base64/i.test(meta) ? Math.floor(payload.length * 3 / 4) : payload.length;
    if (approxBytes > MAX_IMAGE_BYTES) {
      throw new Error(`图片过大（${(approxBytes / 1024 / 1024).toFixed(1)} MB），上限 10 MB`);
    }
    return image;
  }

  if (/^https?:\/\//i.test(image)) {
    const scope = createAbortScope({ signals: [signal], timeoutMs: REQUEST_TIMEOUT_MS, timeoutMessage: '下载图片超时' });
    try {
      const res = await fetch(image, { signal: scope.signal });
      if (!res.ok) {
        throw new Error(`下载图片失败 HTTP ${res.status}`);
      }
      // 先按 Content-Length 预检，再边下边累计字节数，超限立即中止，
      // 避免把超大响应体一次性读入内存导致 OOM。
      const declaredLength = Number(res.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
        throw new Error(`图片过大（${(declaredLength / 1024 / 1024).toFixed(1)} MB），上限 10 MB`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error('下载图片失败：响应无内容');
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error('图片过大，超过上限 10 MB');
        }
        chunks.push(value);
      }
      const buf = Buffer.concat(chunks);
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim();
      const mime = contentType && /^image\//i.test(contentType) ? contentType : (sniffImageMime(buf) || mimeFromExt(image));
      return `data:${mime};base64,${buf.toString('base64')}`;
    } finally {
      scope.cleanup();
    }
  }

  if (path.isAbsolute(image)) throw new Error(`禁止使用绝对路径: ${image}`);
  const isUpload = image.startsWith('@uploads/');
  if (isUpload && !dataDir) throw new Error('当前会话没有附件数据目录');
  const root = await fs.realpath(isUpload ? path.join(dataDir!, 'uploads') : projectRoot || process.cwd());
  const relativeImage = isUpload ? image.slice('@uploads/'.length) : image;
  const lexicalPath = path.resolve(root, relativeImage);
  const relative = path.relative(root, lexicalPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`路径越界，禁止读取项目目录之外: ${image}`);
  }
  const abs = await fs.realpath(lexicalPath);
  const canonicalRelative = path.relative(root, abs);
  if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw new Error(`路径越界，禁止读取项目目录之外: ${image}`);
  }
  const buf = await fs.readFile(abs, { signal });
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大（${(buf.length / 1024 / 1024).toFixed(1)} MB），上限 10 MB`);
  }
  return `data:${sniffImageMime(buf) || mimeFromExt(abs)};base64,${buf.toString('base64')}`;
}

export async function executeVisionAction(
  action: Pick<ActionForTool<'vision'>, 'image'>
    & Partial<Pick<ActionForTool<'vision'>, 'question' | 'tool' | 'type'>>,
  context: VisionContext = {},
) {
  const image = typeof action?.image === 'string' ? action.image.trim() : '';
  // question 本质就是用户对这张图的要求，任务描述本身即可充当。
  // 模型漏填时回落到任务，避免整个 run 因一个可推导的参数直接失败。
  const question = (typeof action?.question === 'string' ? action.question.trim() : '')
    || (typeof context.task === 'string' ? context.task.trim() : '');
  if (!image) return 'image_analyze 失败：缺少 image 参数';
  if (!question) return 'image_analyze 失败：缺少 question 参数';

  const openai = asOpenAIClient(context.openai_client);
  const registry = context.registry;
  const modelConfig = Array.isArray(context.modelConfig) ? context.modelConfig : [];
  const signal = context.signal;
  if (!registry && !openai) {
    return 'image_analyze 失败：未配置可用视觉模型供应商，无法调用多模态接口';
  }
  const scope = createAbortScope({
    signals: [signal],
    timeoutMs: REQUEST_TIMEOUT_MS,
    timeoutMessage: `image_analyze 超时 (${Math.round(REQUEST_TIMEOUT_MS / 1000)}s)`,
  });
  const { model } = resolveVisionModel(context);

  let imageUrl: string;
  try {
    imageUrl = await toImageDataUrl(
      image,
      scope.signal,
      context.projectRoot,
      context.dataDir,
    );
  } catch (err: unknown) {
    scope.cleanup();
    return `image_analyze 失败：${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${VISION_ANALYSIS_GUIDE}\n\n用户问题：${question}` },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ];
    const completion = (registry
      ? await registry.resolve(model, modelConfig).completionJson({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          temperature: 0.2,
          top_p: 1,
          messages,
          signal: scope.signal,
        })
      : await openai.chat.completions.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          temperature: 0.2,
          messages,
        }, { signal: scope.signal })) as CompletionLike;
    const choice = completion?.choices?.[0];
    const raw = choice?.message?.content;
    // 部分 OpenAI 兼容/多模态实现会把 content 返回为分段数组，需拼接文本片段，
    // 否则会被当作空内容误报“未返回内容”。
    const answer = extractMessageText(raw);
    // 输出预算耗尽时回答会停在半句，下游无法从文本本身分辨完整与否；
    // 显式标注截断，避免把不完整结论当作定论，也便于上层决定是否重试。
    const suffix = choice?.finish_reason === 'length' ? TRUNCATION_NOTICE : '';

    if (answer) return `image_analyze 结果（model=${model}）:\n${answer}${suffix}`;

    // 推理型模型可能把全部输出放进推理通道而让 content 为空，此时推理文本里
    // 往往已包含可用的观察结果，作为降级结果返回好过丢弃整次调用。
    // 只在 content 为空时兜底：正常返回不掺入推理文本，否则会挤占下游对结果的截断额度。
    // 这也是不走 provider 的 preserveReasoningContent 的原因——那个选项会把推理
    // 无条件前置到正文之前，正文反而会被下游截断规则挤出可见范围。
    const reasoning = extractReasoningText(choice?.message);
    if (reasoning) {
      return `image_analyze 结果（model=${model}，仅推理内容）:\n${reasoning}${suffix}`;
    }
    return `image_analyze 模型 ${model} 未返回内容${suffix}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `image_analyze 调用 NIM 失败：${msg}`;
  } finally {
    scope.cleanup();
  }
}
