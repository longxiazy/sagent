/**
 * Code Graph — 项目代码知识图谱 / Project code knowledge graph
 *
 * 给 Agent「项目感知」能力:扫描项目源码,生成模块依赖图 + LLM 语义描述,
 * 落盘到 {dataDir}/codegraph.json(按项目隔离,与 agent-memory.json 同目录)。
 *
 * 设计原则(issue #206 MVP):
 *   - 结构静态算:文件树、import/export 依赖边、stats —— 确定、免费、本地。
 *   - 语义 LLM 补:每模块一句话 description + 分组 —— LLM 只花 token 在「读不出来的东西」。
 *   - LLM 失败回退:description 退化为文件头注释首行,保证「至少有一张图」。
 *
 * 调用场景:
 *   - routes/agent-codegraph.ts: reindex = scanSkeleton → buildCodegraphWithLLM → saveCodegraph
 *   - routes/agent-codegraph.ts / agent/tools/codegraph: loadCodegraph + queryCodegraph
 *
 * 存储位置: {dataDir}/codegraph.json(dataDir 由 resolveRunPaths 按 projectId 解析)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../../helpers/logger.ts';
import { cleanText } from './utils.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type { ModelInfo } from './providers/types.ts';

const CODEGRAPH_FILE = 'codegraph.json';
// 默认跳过的目录(依赖/产物/IDE/VCS);.gitignore 的简单目录名条目会追加进来。
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage',
  '.git', '.idea', '.vscode', '.next', '.cache', 'data',
]);
const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const MAX_FILES = 2000;        // 超大项目安全上限,超出截断并告警
const MAX_FILE_BYTES = 256_000; // 单文件读取上限,避免巨型生成文件拖垮扫描
// LLM 分批预算:每批文件数与字符数双限,先到先分。
const BATCH_MAX_FILES = 20;
const BATCH_MAX_CHARS = 8000;

// ── 数据模型 ──

export interface CodegraphModule {
  path: string;        // 相对项目根的 posix 路径(静态)
  exports: string[];   // 顶层导出符号名(静态)
  dependsOn: string[]; // 指向项目内其他模块的相对路径(静态,import 解析)
  description: string;  // 一句话职责(LLM;失败→头注释首行)
  group: string;        // 模块分组(LLM;失败→顶层目录名)
  loc: number;          // 行数(静态)
  mtime: string;        // 最后修改时间(静态)
}

export interface Codegraph {
  version: number;
  project: string;
  language: string;
  rootPath: string;
  lastIndexed: string;
  model: string;
  stats: { totalFiles: number; totalModules: number; coverage: string };
  modules: CodegraphModule[];
  entryPoints: string[];
  summary: string;
}

// ── 落盘读写(仿 memory.ts) ──

export async function loadCodegraph(dir: string): Promise<Codegraph | null> {
  try {
    const raw = await fs.readFile(path.join(dir, CODEGRAPH_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.modules)) return null;
    return parsed as Codegraph;
  } catch {
    return null;
  }
}

export async function saveCodegraph(dir: string, graph: Codegraph): Promise<void> {
  const filePath = path.join(dir, CODEGRAPH_FILE);
  const tmp = filePath + '.tmp';
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(graph, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

// ── 静态骨架扫描 ──

export interface FileSkeleton {
  path: string;          // 相对 posix 路径
  headComment: string;   // 文件头注释首行
  importSpecs: string[]; // 原始 import/require specifier
  dependsOn: string[];   // 解析后指向项目内文件的相对路径
  exports: string[];     // 顶层导出符号
  loc: number;
  mtime: string;
}

/** 把绝对路径转成相对项目根的 posix 风格路径(跨平台一致) */
function toPosixRel(rootPath: string, abs: string): string {
  return path.relative(rootPath, abs).split(path.sep).join('/');
}

/** 读 .gitignore 的「纯目录/文件名」简单条目,追加到跳过集合(复杂 glob 不处理) */
async function loadGitignoreDirs(rootPath: string): Promise<Set<string>> {
  const skip = new Set<string>();
  try {
    const raw = await fs.readFile(path.join(rootPath, '.gitignore'), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.includes('*') || t.includes('!')) continue;
      const name = t.replace(/^\/+/, '').replace(/\/+$/, '');
      if (name && !name.includes('/')) skip.add(name);
    }
  } catch { /* 没有 .gitignore 就只用默认 SKIP_DIRS */ }
  return skip;
}

/** 递归收集代码文件的绝对路径 */
async function walkFiles(rootPath: string): Promise<string[]> {
  const extra = await loadGitignoreDirs(rootPath);
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    let entries: any[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const name = entry.name;
      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        // 跳过隐藏目录(.git/.idea 等)与默认 / .gitignore 忽略目录
        if (name.startsWith('.') || SKIP_DIRS.has(name) || extra.has(name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (CODE_EXTS.includes(path.extname(name))) out.push(full);
      }
    }
  }

  await walk(rootPath);
  return out;
}

/** 提取文件头注释首行(支持 /** ... *\/ 与连续 // 两种) */
function extractHeadComment(content: string): string {
  const src = content.replace(/^﻿/, '').trimStart();
  if (src.startsWith('/*')) {
    const end = src.indexOf('*/');
    const block = end === -1 ? src : src.slice(0, end);
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/^\s*\/?\*+/, '').trim();
      if (line) return cleanText(line, 120);
    }
  } else if (src.startsWith('//')) {
    for (const rawLine of src.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('//')) break;
      const text = line.replace(/^\/+/, '').trim();
      if (text) return cleanText(text, 120);
    }
  }
  return '';
}

/** 提取 import/require specifier(原始字符串) */
function extractImportSpecs(content: string): string[] {
  const specs = new Set<string>();
  const importRe = /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  const bareImportRe = /import\s*['"]([^'"]+)['"]/g;
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const dynImportRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [importRe, bareImportRe, requireRe, dynImportRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

/** 提取顶层导出符号名 */
function extractExports(content: string): string[] {
  const names = new Set<string>();
  // export function/const/let/var/class/interface/type/enum NAME
  const declRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(content)) !== null) names.add(m[1]);
  // export { a, b as c }
  const braceRe = /export\s*\{([^}]*)\}/g;
  while ((m = braceRe.exec(content)) !== null) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().split(/\s+as\s+/);
      const name = (seg[1] || seg[0] || '').trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  if (/export\s+default/.test(content)) names.add('default');
  return [...names].slice(0, 30);
}

/** 把相对 import specifier 解析为项目内的实际相对路径(命中文件集才算) */
function resolveDep(spec: string, fromRel: string, relSet: Set<string>): string | null {
  if (!spec.startsWith('.')) return null; // 只处理项目内相对依赖,裸包忽略
  const fromDir = path.posix.dirname(fromRel);
  const base = path.posix.normalize(path.posix.join(fromDir, spec));
  const candidates = [
    base,
    ...CODE_EXTS.map(e => base + e),
    ...CODE_EXTS.map(e => path.posix.join(base, 'index' + e)),
  ];
  for (const c of candidates) {
    if (relSet.has(c)) return c;
  }
  return null;
}

/**
 * 扫描项目根,产出每文件的静态骨架(含解析后的项目内依赖边)。
 * 纯本地、确定性、零 LLM。
 */
export async function scanSkeleton(rootPath: string): Promise<FileSkeleton[]> {
  const absFiles = await walkFiles(rootPath);
  if (absFiles.length >= MAX_FILES) {
    log.warn(`[Codegraph] 文件数达到上限 ${MAX_FILES},已截断扫描`);
  }

  const partial: Array<Omit<FileSkeleton, 'dependsOn'> & { _abs: string }> = [];
  for (const abs of absFiles) {
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(abs, 'utf8');
      partial.push({
        path: toPosixRel(rootPath, abs),
        headComment: extractHeadComment(content),
        importSpecs: extractImportSpecs(content),
        exports: extractExports(content),
        loc: content.split('\n').length,
        mtime: stat.mtime.toISOString(),
        _abs: abs,
      });
    } catch { /* 读不了的文件跳过 */ }
  }

  // 第二遍:有了全量相对路径集合后再解析依赖边。
  const relSet = new Set(partial.map(p => p.path));
  return partial.map(p => {
    const dependsOn = [...new Set(
      p.importSpecs.map(spec => resolveDep(spec, p.path, relSet)).filter((x): x is string => !!x),
    )];
    const { _abs, ...rest } = p;
    return { ...rest, dependsOn };
  });
}

// ── 容错 JSON 解析(剥 ```json 围栏 + 提取首个数组/对象) ──

function parseJsonLoose(text: string): any {
  if (typeof text !== 'string') return null;
  let src = text.trim();
  const fenced = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) src = fenced[1].trim();
  // 直接尝试
  try { return JSON.parse(src); } catch { /* fallthrough */ }
  // 提取首个 [...] 或 {...}(平衡括号)
  for (const open of ['[', '{']) {
    const close = open === '[' ? ']' : '}';
    const start = src.indexOf(open);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(src.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

// ── LLM 语义增强(map-reduce 分批) ──

function batchByBudget(skeletons: FileSkeleton[]): FileSkeleton[][] {
  const batches: FileSkeleton[][] = [];
  let cur: FileSkeleton[] = [];
  let curChars = 0;
  for (const s of skeletons) {
    const cost = s.path.length + s.headComment.length + s.exports.join(',').length + s.importSpecs.join(',').length + 40;
    if (cur.length > 0 && (cur.length >= BATCH_MAX_FILES || curChars + cost > BATCH_MAX_CHARS)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(s);
    curChars += cost;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

function buildBatchMessages(batch: FileSkeleton[]): any[] {
  const fileLines = batch.map(s => {
    const parts = [`path: ${s.path}`];
    if (s.headComment) parts.push(`注释: ${s.headComment}`);
    if (s.exports.length) parts.push(`导出: ${s.exports.slice(0, 12).join(', ')}`);
    if (s.dependsOn.length) parts.push(`依赖: ${s.dependsOn.slice(0, 8).join(', ')}`);
    return `- ${parts.join(' | ')}`;
  }).join('\n');

  // 指令并入单条 user message，对 gemini/openai-compat 都安全。
  const instruction = [
    '你是代码库分析助手。根据每个文件的路径、头注释、导出符号、依赖,',
    '为每个文件生成一句话中文职责描述(description,≤30字)和一个模块分组(group,简短英文短横线命名,如 agent-core / routes / client-ui)。',
    '只输出一个 JSON 数组,每项形如 {"path":"...","description":"...","group":"..."},',
    'path 必须与输入完全一致。不要输出 JSON 以外的任何文字、不要用 markdown 围栏。',
  ].join('');

  return [
    {
      role: 'user',
      content: `${instruction}\n\n请分析以下 ${batch.length} 个文件:\n${fileLines}`,
    },
  ];
}

/**
 * 在静态骨架上叠加 LLM 语义,组装完整 codegraph。
 * onProgress(done, total) 在每批 LLM 完成后回调,驱动前端进度。
 * 任一批 LLM 失败 → 该批模块回退到头注释/目录名,流程不中断。
 */
export async function buildCodegraphWithLLM({
  skeleton,
  registry,
  model,
  modelConfig,
  projectName,
  rootPath,
  onProgress,
}: {
  skeleton: FileSkeleton[];
  registry: ProviderRegistry;
  model: string;
  modelConfig?: ModelInfo[] | null;
  projectName: string;
  rootPath: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<Codegraph> {
  const semantics = new Map<string, { description: string; group: string }>();
  const batches = batchByBudget(skeleton);
  const total = batches.length;
  let done = 0;

  for (const batch of batches) {
    try {
      const provider = registry.resolve(model, modelConfig);
      const result = await provider.completionJson({
        model,
        messages: buildBatchMessages(batch),
        temperature: 0.1,
        top_p: 1,
        max_tokens: 4096,
      });
      const content = result?.choices?.[0]?.message?.content ?? '';
      const arr = parseJsonLoose(typeof content === 'string' ? content : JSON.stringify(content));
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && typeof item.path === 'string') {
            semantics.set(item.path, {
              description: cleanText(String(item.description || ''), 60),
              group: cleanText(String(item.group || ''), 30),
            });
          }
        }
      }
    } catch (err: any) {
      log.warn(`[Codegraph] 批次语义生成失败,回退头注释: ${err?.message || err}`);
    }
    done += 1;
    onProgress?.(done, total);
  }

  const modules: CodegraphModule[] = skeleton.map(s => {
    const sem = semantics.get(s.path);
    const fallbackGroup = s.path.split('/')[0] || 'root';
    return {
      path: s.path,
      exports: s.exports,
      dependsOn: s.dependsOn,
      description: sem?.description || s.headComment || '',
      group: sem?.group || fallbackGroup,
      loc: s.loc,
      mtime: s.mtime,
    };
  });

  const describedCount = modules.filter(m => semantics.has(m.path)).length;
  const coverage = modules.length > 0 ? `${Math.round((describedCount / modules.length) * 100)}%` : '0%';

  return {
    version: 1,
    project: projectName,
    language: detectLanguage(skeleton),
    rootPath,
    lastIndexed: new Date().toISOString(),
    model,
    stats: { totalFiles: skeleton.length, totalModules: modules.length, coverage },
    modules,
    entryPoints: detectEntryPoints(skeleton),
    summary: '',
  };
}

function detectLanguage(skeleton: FileSkeleton[]): string {
  let ts = 0, js = 0;
  for (const s of skeleton) {
    if (s.path.endsWith('.ts') || s.path.endsWith('.tsx')) ts++;
    else js++;
  }
  if (ts > 0 && ts >= js) return 'TypeScript';
  if (js > 0) return 'JavaScript';
  return 'Unknown';
}

/** 启发式入口点:常见入口文件名(MVP 不调 LLM) */
function detectEntryPoints(skeleton: FileSkeleton[]): string[] {
  const prefer = ['server.ts', 'server.js', 'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js'];
  const set = new Set(skeleton.map(s => s.path));
  const found = prefer.filter(p => set.has(p));
  // 退而求其次:被依赖数为 0 但导出多的根级文件不易判断,这里保持简单只取常见入口。
  return found.slice(0, 6);
}

// ── 查询(纯静态关键词匹配) ──

export function queryCodegraph(graph: Codegraph | null, q: string, limit = 8): CodegraphModule[] {
  if (!graph || !Array.isArray(graph.modules)) return [];
  const query = String(q || '').trim().toLowerCase();
  if (!query) return [];
  const terms = query.split(/\s+/).filter(Boolean);

  const scored = graph.modules.map(m => {
    const hay = [
      m.path,
      m.description,
      m.group,
      m.exports.join(' '),
    ].join(' ').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!hay.includes(term)) continue;
      score += 1;
      if (m.path.toLowerCase().includes(term)) score += 2;       // 路径命中加权
      if (m.exports.some(e => e.toLowerCase().includes(term))) score += 2; // 导出符号命中加权
    }
    return { m, score };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => x.m);
}
