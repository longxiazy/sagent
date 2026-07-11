#!/usr/bin/env node
import 'dotenv/config';

/**
 * Smoke 测试脚本 — 每次功能开发完后跑一组预设问题,用 quality 字段做断言
 *
 * 用法:
 *   1. 先在另一个终端启动服务:  npm run dev  (或 bun server.ts)
 *   2. 跑 smoke:               npm run smoke
 *
 * 选项见 --help。
 *
 * 退出码:
 *   0 = 所有用例 pass
 *   1 = 有 warn(状态在期望范围内但非 done,或 reason 未命中)
 *   2 = 有 fail(状态不在期望、缺工具、HTTP 错、超时等)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const USAGE = `
用法: node scripts/smoke-test.mjs [选项]

选项:
  --file <path>          问题集 JSON 路径(默认 scripts/smoke-queries.json)
  --base <url>           Sagent 服务地址(默认 http://127.0.0.1:\${PORT:-3001})
  --timeout <ms>         单条 query 默认超时(默认 300000,即 5 分钟)
  --model <id>           覆盖默认模型
  --only <id1,id2>       只跑指定 id(逗号分隔)
  --category <cat,...>   只跑指定分类(typical-search/quality-classification/tool-coverage)
  --report-dir <path>    报告输出目录(默认 data/smoke-reports)
  --no-report            不写 JSON 报告
  -h, --help             显示帮助

退出码: 0=全部 pass / 1=有 warn / 2=有 fail 或环境异常

环境变量:
  SMOKE_BASE_URL, SMOKE_TIMEOUT_MS, SMOKE_MODEL
  SMOKE_API_TOKEN      Smoke 专用 API Token；未设置时回退到 SAGENT_API_TOKEN
`.trim();

function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = {
    file: path.join(__dirname, 'smoke-queries.json'),
    base: process.env.SMOKE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3001}`,
    timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS || 300_000),
    model: process.env.SMOKE_MODEL || undefined,
    apiToken: process.env.SMOKE_API_TOKEN || process.env.SAGENT_API_TOKEN || '',
    only: null,
    category: null,
    reportDir: path.join(ROOT, 'data', 'smoke-reports'),
    writeReport: true,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file') cfg.file = args[++i];
    else if (a === '--base') cfg.base = args[++i];
    else if (a === '--timeout') cfg.timeoutMs = Number(args[++i]);
    else if (a === '--model') cfg.model = args[++i];
    else if (a === '--only') cfg.only = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--category') cfg.category = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--report-dir') cfg.reportDir = args[++i];
    else if (a === '--no-report') cfg.writeReport = false;
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else { console.error(`未知参数: ${a}`); console.error(USAGE); process.exit(2); }
  }
  return cfg;
}

function authHeaders(apiToken, headers = {}) {
  return apiToken
    ? { ...headers, Authorization: `Bearer ${apiToken}` }
    : headers;
}

async function checkServiceReady(base, apiToken) {
  const r = await fetch(`${base}/api/agent/active`, {
    headers: authHeaders(apiToken),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

async function getActiveRun(base, apiToken) {
  try {
    const r = await fetch(`${base}/api/agent/active`, {
      headers: authHeaders(apiToken),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.active ? j : null;
  } catch {
    return null;
  }
}

async function cancelRun(base, runId, apiToken) {
  if (!runId) return;
  try {
    await fetch(`${base}/api/agent/cancel`, {
      method: 'POST',
      headers: authHeaders(apiToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ runId }),
    });
  } catch {
    // ignore
  }
}

async function waitForIdle(base, apiToken, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = await getActiveRun(base, apiToken);
    if (!active) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * 保证服务端没有残留 run。如果有(例如上一条客户端超时了),先 cancel + 等 idle。
 * 返回:'idle' 已空闲 / 'cancelled' 取消了残留 / 'busy' 取消失败仍未空闲
 */
async function ensureIdle(base, apiToken, { hint } = {}) {
  const active = await getActiveRun(base, apiToken);
  if (!active) return 'idle';
  console.log(`[smoke] ${hint || '清理'}残留 run: ${active.runId}(任务: ${(active.task || '').slice(0, 40)}…),发送 cancel…`);
  await cancelRun(base, active.runId, apiToken);
  const ok = await waitForIdle(base, apiToken, 20000);
  return ok ? 'cancelled' : 'busy';
}

async function runQuery(base, query, timeoutMs, model, apiToken, onRunIdResolved) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const body = { task: query.task, memory: false };
  if (model) body.model = model;

  const events = [];
  let runId = null;
  let doneEvent = null;
  let errorEvent = null;
  const startedAt = Date.now();

  try {
    const res = await fetch(`${base}/api/agent`, {
      method: 'POST',
      headers: authHeaders(apiToken, { 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, runId, events, reason: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = frame.split('\n').filter(l => l.startsWith('data: '));
        if (dataLines.length === 0) continue;
        const raw = dataLines.map(l => l.slice(6)).join('\n');
        let payload;
        try { payload = JSON.parse(raw); } catch { continue; }
        events.push(payload);
        if (payload.runId && !runId) {
          runId = payload.runId;
          if (typeof onRunIdResolved === 'function') onRunIdResolved(runId);
        }
        if (payload.type === 'done') doneEvent = payload;
        if (payload.type === 'error') errorEvent = payload;
      }
    }
    return { ok: true, runId, events, doneEvent, errorEvent, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    const reason = ac.signal.aborted ? `timeout after ${timeoutMs}ms` : err.message;
    return { ok: false, runId, events, reason, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function collectToolsUsed(events) {
  const used = new Set();
  for (const e of events) {
    const tool = e?.action?.tool;
    if (tool) used.add(tool);
  }
  return used;
}

function evaluateQuery(query, result) {
  const verdict = { pass: true, severity: 'pass', reasons: [] };

  if (!result.ok) {
    return { pass: false, severity: 'fail', reasons: [result.reason || '请求失败'] };
  }
  if (result.errorEvent) {
    return { pass: false, severity: 'fail', reasons: [`error 事件: ${result.errorEvent.error}`] };
  }
  if (!result.doneEvent) {
    return { pass: false, severity: 'fail', reasons: ['未收到 done 事件'] };
  }

  const quality = result.doneEvent.quality || result.doneEvent.meta?.quality || {};
  const actualStatus = quality.status || result.doneEvent.meta?.status || 'done';

  if (Array.isArray(query.expectStatus) && query.expectStatus.length > 0) {
    if (!query.expectStatus.includes(actualStatus)) {
      verdict.pass = false;
      verdict.severity = 'fail';
      verdict.reasons.push(`status=${actualStatus} 不在期望 [${query.expectStatus.join(', ')}]`);
    } else if (actualStatus !== 'done') {
      verdict.severity = verdict.severity === 'pass' ? 'warn' : verdict.severity;
      verdict.reasons.push(`status=${actualStatus}(在期望范围内)`);
    }
  }

  if (Array.isArray(query.expectTools) && query.expectTools.length > 0) {
    const toolsUsed = collectToolsUsed(result.events);
    const missing = query.expectTools.filter(t => !toolsUsed.has(t));
    if (missing.length > 0) {
      verdict.pass = false;
      verdict.severity = 'fail';
      verdict.reasons.push(`未使用工具: ${missing.join(', ')}(实际: ${[...toolsUsed].join(', ') || 'none'})`);
    }
  }

  if (Array.isArray(query.expectAnyReason) && query.expectAnyReason.length > 0) {
    const reasons = quality.reasons || [];
    const matched = query.expectAnyReason.some(needle => reasons.some(r => r.includes(needle)));
    if (!matched) {
      verdict.severity = verdict.severity === 'pass' ? 'warn' : verdict.severity;
      verdict.reasons.push(`未触发期望 reason 之一 [${query.expectAnyReason.join(' | ')}];实际: ${reasons.join(' / ') || '无'}`);
    }
  }

  return verdict;
}

function formatTable(rows, columns) {
  if (rows.length === 0) return '(空)';
  const widths = columns.map(col => {
    const header = String(col.header);
    return Math.max(header.length, ...rows.map(r => String(r[col.key] ?? '').length));
  });
  const renderRow = vals => vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  const header = renderRow(columns.map(c => c.header));
  const sep = widths.map(w => '─'.repeat(w)).join('  ');
  const body = rows.map(r => renderRow(columns.map(c => r[c.key]))).join('\n');
  return [header, sep, body].join('\n');
}

function severityIcon(sev) {
  if (sev === 'pass') return '✅';
  if (sev === 'warn') return '⚠️ ';
  return '❌';
}

async function main() {
  const cfg = parseArgs();
  const queriesFile = JSON.parse(await fs.readFile(cfg.file, 'utf8'));
  let queries = Array.isArray(queriesFile.queries) ? queriesFile.queries : [];
  if (cfg.only) queries = queries.filter(q => cfg.only.includes(q.id));
  if (cfg.category) queries = queries.filter(q => cfg.category.includes(q.category));
  if (queries.length === 0) {
    console.error('[smoke] 没有匹配的 query');
    process.exit(2);
  }

  try {
    await checkServiceReady(cfg.base, cfg.apiToken);
  } catch (err) {
    console.error(`[smoke] 服务未就绪(${cfg.base}): ${err.message}`);
    console.error('[smoke] 先在另一个终端跑 `npm run dev` 启动服务,再跑 smoke');
    process.exit(2);
  }

  const startupState = await ensureIdle(cfg.base, cfg.apiToken, { hint: '启动前' });
  if (startupState === 'busy') {
    console.error('[smoke] 服务端存在无法取消的 active run,放弃');
    process.exit(2);
  }

  console.log(`[smoke] base=${cfg.base} auth=${cfg.apiToken ? 'configured' : 'disabled'} timeout=${Math.round(cfg.timeoutMs / 1000)}s queries=${queries.length}${cfg.model ? ' model=' + cfg.model : ''}`);

  if (cfg.writeReport) await fs.mkdir(cfg.reportDir, { recursive: true });

  const currentRun = { base: cfg.base, runId: null };
  const onSignal = async sig => {
    console.log(`\n[smoke] 收到 ${sig},取消当前任务并退出…`);
    if (currentRun.runId) await cancelRun(currentRun.base, currentRun.runId, cfg.apiToken);
    process.exit(130);
  };
  process.on('SIGINT', () => { onSignal('SIGINT'); });
  process.on('SIGTERM', () => { onSignal('SIGTERM'); });

  const results = [];
  for (const [i, query] of queries.entries()) {
    const label = `[smoke ${i + 1}/${queries.length}] ${query.id}`;
    process.stdout.write(`${label} ${query.task.slice(0, 50)}${query.task.length > 50 ? '…' : ''}\n`);
    currentRun.runId = null;
    const startedAt = Date.now();
    const result = await runQuery(
      cfg.base,
      query,
      query.timeoutMs || cfg.timeoutMs,
      cfg.model,
      cfg.apiToken,
      runId => { currentRun.runId = runId; }
    );
    const verdict = evaluateQuery(query, result);
    const elapsed = ((result.elapsedMs || Date.now() - startedAt) / 1000).toFixed(1) + 's';
    const stepCount = result.doneEvent?.meta?.step_count ?? '-';
    const modelsUsed = result.doneEvent?.meta?.models_used?.join(',') || '-';
    const status = result.doneEvent?.quality?.status || result.doneEvent?.meta?.status || (result.errorEvent ? 'error' : (result.ok ? 'unknown' : 'no-response'));

    console.log(`  ${severityIcon(verdict.severity)} ${verdict.severity.padEnd(4)}  status=${status}  ${elapsed}  step=${stepCount}  model=${modelsUsed}  runId=${result.runId || '-'}`);
    for (const r of verdict.reasons) console.log(`        · ${r}`);
    if (verdict.severity !== 'pass' && result.runId) {
      console.log(`        · trace: data/traces/${result.runId}.jsonl`);
    }

    // 客户端超时/异常退出但服务端 run 还在跑 → 必须主动 cancel,否则下一条会被 409 拦截
    const cleanupState = await ensureIdle(cfg.base, cfg.apiToken, { hint: '下一条前' });
    if (cleanupState === 'busy') {
      console.log('        · 警告:服务端仍 busy,等下一条可能 409');
    }
    currentRun.runId = null;

    results.push({
      id: query.id,
      category: query.category,
      task: query.task,
      runId: result.runId,
      severity: verdict.severity,
      pass: verdict.pass,
      reasons: verdict.reasons,
      status,
      stepCount: result.doneEvent?.meta?.step_count ?? null,
      modelsUsed: result.doneEvent?.meta?.models_used || [],
      elapsedMs: result.elapsedMs ?? null,
      tracePath: result.runId ? `data/traces/${result.runId}.jsonl` : null,
      quality: result.doneEvent?.quality || null,
      answer: typeof result.doneEvent?.answer === 'string' ? result.doneEvent.answer.slice(0, 500) : null,
      error: result.errorEvent?.error || (result.ok ? null : result.reason),
    });
  }

  console.log('\n[smoke] 结果汇总:');
  console.log(formatTable(
    results.map(r => ({
      id: r.id,
      category: r.category,
      status: r.status,
      severity: `${severityIcon(r.severity)} ${r.severity}`,
      step: r.stepCount ?? '-',
      elapsed: r.elapsedMs ? `${(r.elapsedMs / 1000).toFixed(1)}s` : '-',
    })),
    [
      { key: 'id', header: 'id' },
      { key: 'category', header: 'category' },
      { key: 'status', header: 'status' },
      { key: 'severity', header: 'severity' },
      { key: 'step', header: 'steps' },
      { key: 'elapsed', header: 'elapsed' },
    ]
  ));

  const summary = {
    timestamp: new Date().toISOString(),
    base: cfg.base,
    model: cfg.model || null,
    total: results.length,
    passed: results.filter(r => r.severity === 'pass').length,
    warned: results.filter(r => r.severity === 'warn').length,
    failed: results.filter(r => r.severity === 'fail').length,
    results,
  };

  if (cfg.writeReport) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(cfg.reportDir, `smoke-${ts}.json`);
    await fs.writeFile(reportPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`\n[smoke] 报告已写入: ${path.relative(ROOT, reportPath)}`);
  }
  console.log(`[smoke] pass=${summary.passed} warn=${summary.warned} fail=${summary.failed}`);

  if (summary.failed > 0) process.exit(2);
  if (summary.warned > 0) process.exit(1);
  process.exit(0);
}

main().catch(err => {
  console.error('[smoke] fatal:', err.stack || err.message || err);
  process.exit(2);
});
