/**
 * trace-eval — 基于录制 trace 的离线回归评测 CLI。
 *
 * 用法：
 *   bun scripts/trace-eval.ts                          # 离线评测全部夹具，与基线对比
 *   bun scripts/trace-eval.ts capture <runId> [...]    # 把 data/traces 里的一个 run 脱敏后固化为夹具
 *   bun scripts/trace-eval.ts --update-baseline        # 接受当前值，重写基线
 *   bun scripts/trace-eval.ts --live --models m1,m2    # 决策回放：真实模型对录制步骤逐步重新决策（烧 token）
 *
 * 通用参数：
 *   --data-dir <path>       运行时数据目录（默认 ./data；worktree 下可指向主仓库 data）
 *   --fixtures-dir <path>   夹具目录（默认 <data-dir>/eval-fixtures）
 *   --warn-drift <pct>      prompt token 漂移 warn 阈值（默认 10）
 *   --fail-drift <pct>      prompt token 漂移 fail 阈值（默认 25）
 *   --no-report             不写 JSON 报告（默认写到 <data-dir>/eval-reports/）
 *   --fixtures fx1,fx2      只评测指定夹具
 * capture 参数：
 *   --id <fixtureId>        夹具 id（默认由 runId 派生）
 *   --tags a,b              标签，写入 meta
 * live 参数：
 *   --models m1,m2          参与回放的模型（缺省用夹具 run_meta.agentModels）
 *   --max-steps <n>         全部夹具累计的最大回放步数（默认 20）
 *
 * 退出码：0=全部 pass / 1=有 warn / 2=有 fail 或执行异常（与 smoke 一致）。
 *
 * 确定性：离线评测把 configStore.init 指向临时空目录，隔离本地 data/config.json
 * 的工具开关对 prompt 构建的影响；因此重建 prompt 是「标准烛光」而非当时请求的
 * 精确复刻，用于同口径下的 A/B 漂移对比。
 */

import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readTraceEvents } from '../helpers/trace-store.ts';
import { redactSensitiveData } from '../helpers/redact.ts';
import { configStore } from '../agent/core/config-store.ts';
import { assessResultQuality } from '../agent/core/result-quality.ts';
import { buildGeminiAgentPromptPayload, buildNvidiaTaskMessages } from '../agent/core/prompts.ts';
import { estimatePayloadTokens } from '../agent/core/context-estimate.ts';
import { createModelResponseParser } from '../agent/core/nvidia-response-parsers.ts';
import { normalizeDesktopAgentDecision } from '../agent/core/schemas.ts';
import {
  listPromptContexts,
  parseTraceLines,
  reconstructRunFromTrace,
  type ReplayParseFailure,
  type ReplayRun,
} from '../agent/core/trace-replay.ts';

// ── 类型 ──

export interface FixtureMeta {
  id: string;
  sourceRunId: string;
  capturedAt: string;
  task: string;
  tags: string[];
  endedWith: ReplayRun['endedWith'];
  stepCount: number;
  agentModels: string[];
  parseFailures: Array<Pick<ReplayParseFailure, 'step' | 'model' | 'rawOutput'>>;
  notes: string;
}

export type ParserOutcome = 'parse_ok' | 'parse_fail' | 'normalize_fail';

export interface PromptTokenTotals {
  nvidia: number;
  nvidiaCompact: number;
  gemini: number;
}

export interface FixtureBaseline {
  endedWith: ReplayRun['endedWith'];
  qualityStatus: string;
  promptContexts: number;
  promptTokens: PromptTokenTotals;
  parserOutcomes: ParserOutcome[];
}

export interface BaselineFile {
  updatedAt: string;
  fixtures: Record<string, FixtureBaseline>;
}

export interface FixtureCurrent {
  id: string;
  meta: FixtureMeta;
  run: ReplayRun;
  endedWith: ReplayRun['endedWith'];
  qualityStatus: string;
  qualityReasons: string[];
  promptContexts: number;
  promptTokens: PromptTokenTotals;
  parserOutcomes: ParserOutcome[];
}

export type Severity = 'pass' | 'warn' | 'fail';

export interface FixtureVerdict {
  fixture: string;
  severity: Severity;
  notes: string[];
  current: {
    endedWith: string;
    qualityStatus: string;
    promptTokens: PromptTokenTotals;
    promptContexts: number;
    parserOutcomes: ParserOutcome[];
  };
  baseline: FixtureBaseline | null;
  drift: Partial<Record<keyof PromptTokenTotals, number>>;
}

interface CliConfig {
  command: 'eval' | 'capture';
  runId?: string;
  fixtureId?: string;
  tags: string[];
  dataDir: string;
  fixturesDir: string;
  onlyFixtures: string[] | null;
  updateBaseline: boolean;
  warnDrift: number;
  failDrift: number;
  writeReport: boolean;
  live: boolean;
  liveModels: string[] | null;
  maxLiveSteps: number;
}

// ── 纯逻辑（供 vitest 导入）──

export function severityMax(a: Severity, b: Severity): Severity {
  const order: Severity[] = ['pass', 'warn', 'fail'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

export function driftPercent(current: number, baseline: number): number {
  if (!Number.isFinite(baseline) || baseline <= 0) return current > 0 ? 100 : 0;
  return Math.abs(current - baseline) / baseline * 100;
}

export function compareParserOutcomes(current: ParserOutcome[], baseline: ParserOutcome[]): { severity: Severity; notes: string[] } {
  const notes: string[] = [];
  let severity: Severity = 'pass';
  if (current.length !== baseline.length) {
    return { severity: 'fail', notes: [`解析器语料数量变化: ${baseline.length} -> ${current.length}（夹具应不可变，疑似提取逻辑变动）`] };
  }
  current.forEach((outcome, index) => {
    const expected = baseline[index];
    if (outcome === expected) return;
    if (expected !== 'parse_ok' && outcome === 'parse_ok') {
      notes.push(`语料 #${index + 1} 由 ${expected} 变为可解析（improved）`);
      severity = severityMax(severity, 'warn');
      return;
    }
    notes.push(`语料 #${index + 1} 回归: ${expected} -> ${outcome}`);
    severity = 'fail';
  });
  return { severity, notes };
}

export function evaluateFixtureAgainstBaseline(
  current: FixtureCurrent,
  baseline: FixtureBaseline | null,
  thresholds: { warnDrift: number; failDrift: number },
): FixtureVerdict {
  const notes: string[] = [];
  let severity: Severity = 'pass';
  const drift: FixtureVerdict['drift'] = {};

  if (!baseline) {
    return {
      fixture: current.id,
      severity: 'warn',
      notes: ['基线中无此夹具，运行 --update-baseline 收录'],
      current: currentSummary(current),
      baseline: null,
      drift,
    };
  }

  if (current.endedWith !== baseline.endedWith) {
    severity = 'fail';
    notes.push(`endedWith 变化: ${baseline.endedWith} -> ${current.endedWith}（夹具不可变，疑似重建逻辑变动）`);
  }

  if (current.qualityStatus !== baseline.qualityStatus) {
    severity = 'fail';
    notes.push(`质量重打分变化: ${baseline.qualityStatus} -> ${current.qualityStatus}（当前 reasons: ${current.qualityReasons.join('；') || '无'}）`);
  }

  if (current.promptContexts !== baseline.promptContexts) {
    severity = 'fail';
    notes.push(`prompt 构建点数量变化: ${baseline.promptContexts} -> ${current.promptContexts}`);
  } else {
    for (const key of ['nvidia', 'nvidiaCompact', 'gemini'] as const) {
      const pct = driftPercent(current.promptTokens[key], baseline.promptTokens[key]);
      drift[key] = Math.round(pct * 10) / 10;
      if (pct > thresholds.failDrift) {
        severity = 'fail';
        notes.push(`${key} prompt token 漂移 ${drift[key]}%（${baseline.promptTokens[key]} -> ${current.promptTokens[key]}）超过 fail 阈值 ${thresholds.failDrift}%`);
      } else if (pct > thresholds.warnDrift) {
        severity = severityMax(severity, 'warn');
        notes.push(`${key} prompt token 漂移 ${drift[key]}%（${baseline.promptTokens[key]} -> ${current.promptTokens[key]}）超过 warn 阈值 ${thresholds.warnDrift}%`);
      }
    }
  }

  const parser = compareParserOutcomes(current.parserOutcomes, baseline.parserOutcomes);
  severity = severityMax(severity, parser.severity);
  notes.push(...parser.notes);

  return { fixture: current.id, severity, notes, current: currentSummary(current), baseline, drift };
}

function currentSummary(current: FixtureCurrent) {
  return {
    endedWith: current.endedWith,
    qualityStatus: current.qualityStatus,
    promptTokens: current.promptTokens,
    promptContexts: current.promptContexts,
    parserOutcomes: current.parserOutcomes,
  };
}

export function replayParserCorpus(entries: Array<{ model?: string; rawOutput: string }>): ParserOutcome[] {
  return entries.map(entry => {
    const parser = createModelResponseParser(entry.model || 'unknown/model');
    const parsed = parser({ choices: [{ message: { content: entry.rawOutput } }] });
    if (parsed.parseFailed) return 'parse_fail';
    try {
      normalizeDesktopAgentDecision(parsed);
      return 'parse_ok';
    } catch {
      return 'normalize_fail';
    }
  });
}

export function computePromptTokenTotals(run: ReplayRun): { totals: PromptTokenTotals; contexts: number } {
  const contexts = listPromptContexts(run);
  const totals: PromptTokenTotals = { nvidia: 0, nvidiaCompact: 0, gemini: 0 };
  for (const context of contexts) {
    totals.nvidia += estimatePayloadTokens(buildNvidiaTaskMessages(context));
    totals.nvidiaCompact += estimatePayloadTokens(buildNvidiaTaskMessages({ ...context, compact: true }));
    totals.gemini += estimatePayloadTokens(buildGeminiAgentPromptPayload(context));
  }
  return { totals, contexts: contexts.length };
}

export function computeFixtureCurrent(id: string, meta: FixtureMeta, run: ReplayRun): FixtureCurrent {
  const quality = assessResultQuality({ task: run.task, steps: run.steps, answer: run.answer });
  const { totals, contexts } = computePromptTokenTotals(run);
  return {
    id,
    meta,
    run,
    endedWith: run.endedWith,
    qualityStatus: quality.status,
    qualityReasons: quality.reasons,
    promptContexts: contexts,
    promptTokens: totals,
    parserOutcomes: replayParserCorpus(meta.parseFailures),
  };
}

export function baselineEntryFromCurrent(current: FixtureCurrent): FixtureBaseline {
  return {
    endedWith: current.endedWith,
    qualityStatus: current.qualityStatus,
    promptContexts: current.promptContexts,
    promptTokens: current.promptTokens,
    parserOutcomes: current.parserOutcomes,
  };
}

// ── IO ──

function fixtureTracePath(fixturesDir: string, id: string) {
  return join(fixturesDir, 'traces', `${id}.jsonl`);
}

function fixtureMetaPath(fixturesDir: string, id: string) {
  return join(fixturesDir, 'traces', `${id}.meta.json`);
}

function baselinePath(fixturesDir: string) {
  return join(fixturesDir, 'baseline.json');
}

export async function loadBaseline(fixturesDir: string): Promise<BaselineFile> {
  try {
    const raw = await readFile(baselinePath(fixturesDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.fixtures && typeof parsed.fixtures === 'object') {
      return parsed;
    }
  } catch {
    // 基线不存在或损坏都按空基线处理
  }
  return { updatedAt: '', fixtures: {} };
}

async function saveBaseline(fixturesDir: string, baseline: BaselineFile) {
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(baselinePath(fixturesDir), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

async function listFixtureIds(fixturesDir: string): Promise<string[]> {
  try {
    const files = await readdir(join(fixturesDir, 'traces'));
    return files
      .filter(file => file.endsWith('.jsonl'))
      .map(file => file.slice(0, -'.jsonl'.length))
      .sort();
  } catch {
    return [];
  }
}

async function loadFixture(fixturesDir: string, id: string): Promise<{ meta: FixtureMeta; run: ReplayRun }> {
  const raw = await readFile(fixtureTracePath(fixturesDir, id), 'utf8');
  const run = reconstructRunFromTrace(parseTraceLines(raw));
  let meta: FixtureMeta | null = null;
  try {
    meta = JSON.parse(await readFile(fixtureMetaPath(fixturesDir, id), 'utf8'));
  } catch {
    meta = null;
  }
  if (!meta || typeof meta !== 'object') {
    throw new Error(`夹具 ${id} 缺少 meta 文件（${fixtureMetaPath(fixturesDir, id)}）`);
  }
  return { meta, run };
}

// ── capture ──

function defaultFixtureId(runId: string) {
  return `fx-${runId.replace(/^run_/, '').replace(/_/g, '-')}`;
}

export async function captureFixture(cfg: CliConfig): Promise<{ id: string; run: ReplayRun }> {
  const runId = cfg.runId!;
  // trace 按 scope 落盘:先查 --data-dir 根(项目目录直接指到这里),
  // 再回退无项目全局桶 <data-dir>/projects/default。
  const traceDirs = [cfg.dataDir, join(cfg.dataDir, 'projects', 'default')];
  let events: any[] = [];
  for (const dir of traceDirs) {
    events = await readTraceEvents(dir, runId);
    if (events.length) break;
  }
  if (!events.length) {
    throw new Error(`在 ${traceDirs.map(dir => join(dir, 'traces')).join(' 或 ')} 下找不到 ${runId} 的 trace（或文件为空）`);
  }

  const run = reconstructRunFromTrace(events as any);
  if (!run.task) throw new Error(`trace 缺少 run_meta.task，无法作为夹具（runId=${runId}）`);
  if (!run.steps.length && !run.pendingObservation) {
    throw new Error(`trace 未包含任何已执行步骤，无法作为夹具（runId=${runId}）`);
  }
  if (run.endedWith === 'incomplete') {
    throw new Error(`run 未正常结束（无 done/error 事件，可能被取消或仍在运行），不适合作为夹具（runId=${runId}）`);
  }

  const id = cfg.fixtureId || defaultFixtureId(runId);
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
    throw new Error(`夹具 id 只允许字母数字与连字符: ${id}`);
  }

  const redactedEvents = (events as any[]).map(event => redactSensitiveData(event));
  const redactedRun = reconstructRunFromTrace(redactedEvents as any);

  const meta: FixtureMeta = {
    id,
    sourceRunId: runId,
    capturedAt: new Date().toISOString(),
    task: redactedRun.task,
    tags: cfg.tags,
    endedWith: redactedRun.endedWith,
    stepCount: redactedRun.steps.length,
    agentModels: redactedRun.agentModels,
    parseFailures: redactedRun.parseFailures.map(({ step, model, rawOutput }) => ({ step, model, rawOutput })),
    notes: '',
  };

  await mkdir(join(cfg.fixturesDir, 'traces'), { recursive: true });
  const jsonl = redactedEvents.map(event => JSON.stringify(event)).join('\n');
  await writeFile(fixtureTracePath(cfg.fixturesDir, id), `${jsonl}\n`, 'utf8');
  await writeFile(fixtureMetaPath(cfg.fixturesDir, id), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  // 立即把该夹具的当前值写入基线，作为后续对比的锚点。
  const current = computeFixtureCurrent(id, meta, redactedRun);
  const baseline = await loadBaseline(cfg.fixturesDir);
  baseline.fixtures[id] = baselineEntryFromCurrent(current);
  baseline.updatedAt = new Date().toISOString();
  await saveBaseline(cfg.fixturesDir, baseline);

  return { id, run: redactedRun };
}

// ── 离线评测 ──

interface OfflineEvalOutcome {
  verdicts: FixtureVerdict[];
  severity: Severity;
  currents: FixtureCurrent[];
}

async function runOfflineEval(cfg: CliConfig): Promise<OfflineEvalOutcome> {
  const ids = await listFixtureIds(cfg.fixturesDir);
  const selected = cfg.onlyFixtures ? ids.filter(id => cfg.onlyFixtures!.includes(id)) : ids;
  if (!selected.length) {
    throw new Error(`夹具目录 ${join(cfg.fixturesDir, 'traces')} 为空，先用 capture 固化几个 run（bun scripts/trace-eval.ts capture <runId>）`);
  }
  if (cfg.onlyFixtures) {
    const missing = cfg.onlyFixtures.filter(id => !ids.includes(id));
    if (missing.length) throw new Error(`找不到指定夹具: ${missing.join(', ')}`);
  }

  const baseline = await loadBaseline(cfg.fixturesDir);
  const verdicts: FixtureVerdict[] = [];
  const currents: FixtureCurrent[] = [];
  let severity: Severity = 'pass';

  for (const id of selected) {
    try {
      const { meta, run } = await loadFixture(cfg.fixturesDir, id);
      const current = computeFixtureCurrent(id, meta, run);
      currents.push(current);
      const verdict = evaluateFixtureAgainstBaseline(current, baseline.fixtures[id] ?? null, cfg);
      verdicts.push(verdict);
      severity = severityMax(severity, verdict.severity);
    } catch (err: any) {
      verdicts.push({
        fixture: id,
        severity: 'fail',
        notes: [`评测异常: ${err?.message || err}`],
        current: { endedWith: '?', qualityStatus: '?', promptTokens: { nvidia: 0, nvidiaCompact: 0, gemini: 0 }, promptContexts: 0, parserOutcomes: [] },
        baseline: baseline.fixtures[id] ?? null,
        drift: {},
      });
      severity = 'fail';
    }
  }

  if (cfg.updateBaseline) {
    const next: BaselineFile = { updatedAt: new Date().toISOString(), fixtures: { ...baseline.fixtures } };
    for (const current of currents) {
      next.fixtures[current.id] = baselineEntryFromCurrent(current);
    }
    await saveBaseline(cfg.fixturesDir, next);
  }

  return { verdicts, severity, currents };
}

// ── 报告与输出 ──

const SEVERITY_ICON: Record<Severity, string> = { pass: '✅', warn: '⚠️', fail: '❌' };

function printVerdicts(verdicts: FixtureVerdict[]) {
  console.table(verdicts.map(verdict => ({
    fixture: verdict.fixture,
    verdict: `${SEVERITY_ICON[verdict.severity]} ${verdict.severity}`,
    endedWith: verdict.current.endedWith,
    quality: verdict.current.qualityStatus,
    'nvidia tok': verdict.current.promptTokens.nvidia,
    'Δnvidia%': verdict.drift.nvidia ?? '-',
    'Δcompact%': verdict.drift.nvidiaCompact ?? '-',
    'Δgemini%': verdict.drift.gemini ?? '-',
    parser: verdict.current.parserOutcomes.join(',') || '-',
  })));
  for (const verdict of verdicts) {
    for (const note of verdict.notes) {
      console.log(`  ${SEVERITY_ICON[verdict.severity]} [${verdict.fixture}] ${note}`);
    }
  }
}

async function writeReportFile(cfg: CliConfig, payload: Record<string, unknown>): Promise<string> {
  const dir = join(cfg.dataDir, 'eval-reports');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `eval-${stamp}.json`);
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

// ── CLI ──

export function parseArgs(argv: string[]): CliConfig {
  const cfg: CliConfig = {
    command: 'eval',
    tags: [],
    dataDir: './data',
    fixturesDir: '',
    onlyFixtures: null,
    updateBaseline: false,
    warnDrift: 10,
    failDrift: 25,
    writeReport: true,
    live: false,
    liveModels: null,
    maxLiveSteps: 20,
  };

  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) {
    const command = rest.shift()!;
    if (command === 'capture') {
      cfg.command = 'capture';
      if (rest[0] && !rest[0].startsWith('-')) cfg.runId = rest.shift();
      if (!cfg.runId) throw new Error('capture 需要 runId: bun scripts/trace-eval.ts capture <runId>');
    } else {
      throw new Error(`未知子命令: ${command}`);
    }
  }

  while (rest.length) {
    const arg = rest.shift()!;
    switch (arg) {
      case '--data-dir': cfg.dataDir = rest.shift() || cfg.dataDir; break;
      case '--fixtures-dir': cfg.fixturesDir = rest.shift() || ''; break;
      case '--fixtures': cfg.onlyFixtures = splitList(rest.shift()); break;
      case '--id': cfg.fixtureId = rest.shift(); break;
      case '--tags': cfg.tags = splitList(rest.shift()) || []; break;
      case '--update-baseline': cfg.updateBaseline = true; break;
      case '--warn-drift': cfg.warnDrift = numberArg(rest.shift(), '--warn-drift'); break;
      case '--fail-drift': cfg.failDrift = numberArg(rest.shift(), '--fail-drift'); break;
      case '--no-report': cfg.writeReport = false; break;
      case '--live': cfg.live = true; break;
      case '--models': cfg.liveModels = splitList(rest.shift()); break;
      case '--max-steps': cfg.maxLiveSteps = numberArg(rest.shift(), '--max-steps'); break;
      default: throw new Error(`未知参数: ${arg}`);
    }
  }

  cfg.dataDir = resolve(cfg.dataDir);
  cfg.fixturesDir = resolve(cfg.fixturesDir || join(cfg.dataDir, 'eval-fixtures'));
  return cfg;
}

function splitList(value?: string): string[] | null {
  if (!value) return null;
  const items = value.split(',').map(item => item.trim()).filter(Boolean);
  return items.length ? items : null;
}

function numberArg(value: string | undefined, flag: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) throw new Error(`${flag} 需要一个非负数字，收到: ${value}`);
  return num;
}

async function initDeterministicConfig() {
  // 隔离本地 data/config.json：prompt 构建读 configStore（如 Chrome MCP/通用 MCP 开关），
  // 指向临时空目录后仅剩 schema 默认值，保证跨机器、跨本地配置可复现。
  const dir = await mkdtemp(join(tmpdir(), 'trace-eval-config-'));
  await configStore.init(dir);
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));

  if (cfg.command === 'capture') {
    const { id, run } = await captureFixture(cfg);
    console.log(`✅ 已捕获夹具 ${id}`);
    console.log(`   来源 run: ${cfg.runId}（${run.endedWith}，${run.steps.length} 步，解析失败语料 ${run.parseFailures.length} 条）`);
    console.log(`   task: ${run.task}`);
    console.log(`   文件: ${fixtureTracePath(cfg.fixturesDir, id)}`);
    console.log(`   基线已更新: ${baselinePath(cfg.fixturesDir)}`);
    console.log('   注意: 夹具含真实任务内容（已做密钥脱敏），保存在本地 data/ 下，不会进 git。');
    return;
  }

  await initDeterministicConfig();

  const offline = await runOfflineEval(cfg);
  console.log(`\ntrace-eval 离线评测（${offline.verdicts.length} 个夹具，warn>${cfg.warnDrift}% fail>${cfg.failDrift}%）\n`);
  printVerdicts(offline.verdicts);

  let liveSection: Record<string, unknown> | null = null;
  if (cfg.live) {
    const { runLiveEval } = await import('./trace-eval-live.ts');
    liveSection = await runLiveEval(cfg, offline.currents);
  }

  if (cfg.updateBaseline) {
    console.log(`\n✅ 基线已更新: ${baselinePath(cfg.fixturesDir)}`);
  }

  const summary = {
    pass: offline.verdicts.filter(v => v.severity === 'pass').length,
    warn: offline.verdicts.filter(v => v.severity === 'warn').length,
    fail: offline.verdicts.filter(v => v.severity === 'fail').length,
    verdict: offline.severity,
  };

  if (cfg.writeReport) {
    const file = await writeReportFile(cfg, {
      mode: cfg.live ? 'offline+live' : 'offline',
      finishedAt: new Date().toISOString(),
      dataDir: cfg.dataDir,
      fixturesDir: cfg.fixturesDir,
      thresholds: { warnDrift: cfg.warnDrift, failDrift: cfg.failDrift },
      summary,
      rows: offline.verdicts,
      ...(liveSection ? { live: liveSection } : {}),
    });
    console.log(`\n报告: ${file}`);
  }

  console.log(`\n${SEVERITY_ICON[offline.severity]} 总判定: ${offline.severity}（pass=${summary.pass} warn=${summary.warn} fail=${summary.fail}）`);
  process.exitCode = offline.severity === 'fail' ? 2 : offline.severity === 'warn' ? 1 : 0;
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`❌ trace-eval 执行异常: ${err?.message || err}`);
    process.exitCode = 2;
  });
}
