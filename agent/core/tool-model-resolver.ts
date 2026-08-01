/**
 * Tool Model Resolver — 解析 vision / distill 等工具子任务该用哪个模型。
 *
 * 三层优先级(高→低):
 *   1. 项目级 override:<projectDataDir>/config.json 的 tools.<tool>.model
 *   2. 全局配置:configStore.tools().<tool>.model
 *   3. 环境变量兜底:envModel(如 VISION_MODEL / DISTILL_MODEL)
 *   4. 主模型:mainModel(当前 run 的决策模型)——都未设时回退到它
 *
 * 全局态 run 时 dataDir 即 MEMORY_DIR,项目 override 读到的就是全局 config,
 * 与第 2 层同值,结果不变(无害)。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ToolName = 'vision' | 'distill';

export interface ToolsOverride {
  vision?: { model?: string };
  distill?: { model?: string };
}

/** 读 <dataDir>/config.json 的 tools 段;读不到 / 坏文件 / 无 dataDir → 空。 */
export async function readProjectToolsOverride(dataDir: string | null | undefined): Promise<ToolsOverride> {
  if (!dataDir) return {};
  try {
    const raw = await readFile(join(dataDir, 'config.json'), 'utf-8');
    const tools = JSON.parse(raw)?.tools;
    if (!tools || typeof tools !== 'object') return {};
    const out: ToolsOverride = {};
    if (typeof tools.vision?.model === 'string' && tools.vision.model.trim()) {
      out.vision = { model: tools.vision.model.trim() };
    }
    if (typeof tools.distill?.model === 'string' && tools.distill.model.trim()) {
      out.distill = { model: tools.distill.model.trim() };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 四级解析，逐级回退：项目覆盖 → 全局配置 → 环境变量 → 当前主模型。
 * 主模型是最后兜底，未必具备该工具所需的能力（如多模态），
 * 因此返回值可能为空字符串，也可能是个不适用的模型，由调用方决定如何降级。
 */
export function resolveToolModel(
  tool: ToolName,
  {
    projectTools,
    globalTools,
    envModel,
    mainModel,
  }: {
    projectTools?: ToolsOverride | null;
    globalTools?: ToolsOverride | null;
    envModel?: string | null;
    mainModel?: string | null;
  },
): string {
  const project = projectTools?.[tool]?.model?.trim();
  if (project) return project;
  const global = globalTools?.[tool]?.model?.trim();
  if (global) return global;
  const env = (envModel || '').trim();
  if (env) return env;
  return (mainModel || '').trim();
}

/** 写项目级 tools override 到 <dataDir>/config.json(合并保留其他字段);model 空串=清除该项。 */
export async function writeProjectToolsOverride(
  dataDir: string,
  tools: ToolsOverride,
): Promise<ToolsOverride> {
  const file = join(dataDir, 'config.json');
  let doc: any = {};
  try {
    doc = JSON.parse(await readFile(file, 'utf-8')) || {};
  } catch {
    doc = {};
  }
  const nextTools = { ...(doc.tools && typeof doc.tools === 'object' ? doc.tools : {}) };
  for (const tool of ['vision', 'distill'] as ToolName[]) {
    if (!(tool in tools)) continue;
    const model = tools[tool]?.model?.trim();
    nextTools[tool] = model ? { model } : {};
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...doc, version: doc.version || 1, tools: nextTools }, null, 2)}\n`, 'utf-8');
  const out: ToolsOverride = {};
  if (nextTools.vision?.model) out.vision = { model: nextTools.vision.model };
  if (nextTools.distill?.model) out.distill = { model: nextTools.distill.model };
  return out;
}
