/**
 * Vision Tool — image_analyze 工具实现
 *
 * 把一张图片（本地路径或 http(s) URL）转成 data URL，
 * 通过 NVIDIA NIM 的 OpenAI 兼容接口调用一个多模态视觉模型，
 * 让模型针对 question 给出回答（一次性单轮调用，不进入主 agent loop）。
 *
 * 默认模型: meta/llama-3.2-90b-vision-instruct（NIM 上常驻的视觉模型）
 *   可通过环境变量 VISION_MODEL 覆盖，例如 meta/llama-3.2-11b-vision-instruct
 *   或 microsoft/phi-3.5-vision-instruct。
 *
 * 调用场景：
 *   - 主 agent loop 中模型返回 { tool: 'vision', type: 'image_analyze', image, question }
 *   - 由 desktop/agent.ts 的 actionRouter 路由到此处
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const REQUEST_TIMEOUT_MS = 60000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
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
  return 'image/png';
}

async function toImageDataUrl(image: string): Promise<string> {
  if (/^data:image\//i.test(image)) {
    return image;
  }

  if (/^https?:\/\//i.test(image)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(image, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`下载图片失败 HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) {
        throw new Error(`图片过大（${(buf.length / 1024 / 1024).toFixed(1)} MB），上限 10 MB`);
      }
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim();
      const mime = contentType && /^image\//.test(contentType) ? contentType : mimeFromExt(image);
      return `data:${mime};base64,${buf.toString('base64')}`;
    } finally {
      clearTimeout(timer);
    }
  }

  const abs = path.isAbsolute(image) ? image : path.resolve(process.cwd(), image);
  const buf = await fs.readFile(abs);
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大（${(buf.length / 1024 / 1024).toFixed(1)} MB），上限 10 MB`);
  }
  return `data:${mimeFromExt(abs)};base64,${buf.toString('base64')}`;
}

export async function executeVisionAction(action, context = {}) {
  const image = typeof action?.image === 'string' ? action.image.trim() : '';
  const question = typeof action?.question === 'string' ? action.question.trim() : '';
  if (!image) return 'image_analyze 失败：缺少 image 参数';
  if (!question) return 'image_analyze 失败：缺少 question 参数';

  const openai = (context as any)?.openai_client;
  if (!openai) {
    return 'image_analyze 失败：未配置 NVIDIA_API_KEY，无法调用 NIM 多模态接口';
  }

  const model = String((context as any)?.visionModel || process.env.VISION_MODEL || DEFAULT_VISION_MODEL).trim();

  let imageUrl: string;
  try {
    imageUrl = await toImageDataUrl(image);
  } catch (err: any) {
    return `image_analyze 失败：${err?.message || String(err)}`;
  }

  try {
    const completion = await openai.chat.completions.create({
      model,
      max_tokens: 1024,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${VISION_ANALYSIS_GUIDE}\n\n用户问题：${question}` },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    });
    const text = completion?.choices?.[0]?.message?.content;
    const answer = typeof text === 'string' ? text.trim() : '';
    if (!answer) return `image_analyze 模型 ${model} 未返回内容`;
    return `image_analyze 结果（model=${model}）:\n${answer}`;
  } catch (err: any) {
    const msg = err?.message || String(err);
    return `image_analyze 调用 NIM 失败：${msg}`;
  }
}
