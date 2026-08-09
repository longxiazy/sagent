/**
 * trace-to-otlp — 把录制的 trace JSONL 转成 OpenTelemetry OTLP/JSON。
 *
 * 用法：
 *   bun scripts/trace-to-otlp.ts <runId|路径.jsonl> [...]     # 转换并写文件
 *   bun scripts/trace-to-otlp.ts --all                        # 转换全部已录制 run
 *   bun scripts/trace-to-otlp.ts <runId> --endpoint <url>     # 直接 POST 到 collector
 *
 * 参数：
 *   --data-dir <path>     运行时数据目录（默认 ./data）
 *   --project <id>        指定项目 scope（默认全局桶 projects/default）
 *   --all                 转换该 scope 下全部 run
 *   --out <path>          输出文件（单个 run 时有效；默认写 <data-dir>/otlp-exports/）
 *   --endpoint <url>      OTLP/HTTP 接收端，如 http://localhost:4318/v1/traces
 *   --header k=v          附加 HTTP 头，可重复（给需要认证的 collector）
 *   --service <name>      service.name（默认 sagent）
 *   --content             把任务/决策/工具入参与结果写进 span（默认不写，见下）
 *   --max-content <n>     单个内容字段的字符上限（默认 4096）
 *   --pretty              输出缩进 JSON，便于人读
 *
 * 关于 --content：
 *   OTel GenAI 约定要求内容默认不采集、但提供 opt-in 开关，理由是这些内容既敏感
 *   又体积大。不加此参数时 span 只含结构化元数据（工具名、状态、token 数、时长）；
 *   加上之后才写入 gen_ai.input.messages / output.messages / tool.call.arguments /
 *   tool.call.result。内容已在写 trace 时脱敏过凭据，但任务正文、页面内容等业务
 *   数据会随 span 进入 collector——推送到共享后端前请确认这是你想要的。
 *
 * 每个 run 单独发送/单独成文件：run 是 sagent 里天然的批次边界，一次失败不影响其它 run。
 * 同一 chat session 的多个 run 会共享 trace_id，Jaeger 收到后自动归并成一棵 trace。
 *
 * 关于历史数据：本脚本**不读** trace 里存的 span_id，而是从事件内容重新派生。
 * 所以早期那些 span_id 为 "step_1_observe" 的旧格式文件也能正确转换，无需迁移。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { listTraceRuns, readTraceEvents } from '../helpers/trace-store.ts';
import { parseTraceLines } from '../agent/core/trace-replay.ts';
import { createSpanAssembler, type AssembledSpan } from '../helpers/telemetry/span-assembler.ts';
import { DEFAULT_MAX_CONTENT_CHARS } from '../helpers/telemetry/content.ts';
import { buildOtlpTracePayload, postOtlpTraces } from '../helpers/telemetry/otlp-json.ts';
import { projectDataDir, GLOBAL_SCOPE_ID } from '../agent/core/project-store.ts';

interface Options {
  targets: string[];
  dataDir: string;
  projectId: string;
  all: boolean;
  out: string | null;
  endpoint: string | null;
  headers: Record<string, string>;
  service: string;
  pretty: boolean;
  captureContent: boolean;
  maxContentChars: number;
}

const USAGE = `
用法: bun scripts/trace-to-otlp.ts <runId|路径.jsonl> [...] [选项]

选项:
  --all                 转换该 scope 下全部已录制 run
  --data-dir <path>     运行时数据目录(默认 ./data)
  --project <id>        项目 scope(默认全局桶 projects/default)
  --out <path>          输出文件(单个 run 时有效)
  --endpoint <url>      OTLP/HTTP 接收端,如 http://localhost:4318/v1/traces
  --header k=v          附加 HTTP 头,可重复
  --service <name>      service.name(默认 sagent)
  --content             把任务/决策/工具入参与结果写进 span(默认不写)
  --max-content <n>     单个内容字段的字符上限(默认 4096)
  --pretty              缩进输出
  -h, --help            显示帮助

未指定 --endpoint 时写入 <data-dir>/otlp-exports/<runId>.otlp.json。

内容捕获: 按 OTel GenAI 约定,内容默认不进 span——只有结构化元数据(工具名、
状态、token 数、时长)。加 --content 才写入任务正文、模型理由、工具入参和结果。
凭据已在落 trace 时脱敏,但业务数据会随 span 进入 collector,推给共享后端前请确认。

想看瀑布图, 先起一个本地 Jaeger:
  docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
  bun scripts/trace-to-otlp.ts --all --endpoint http://localhost:4318/v1/traces
然后打开 http://localhost:16686 按 service 搜索。
`.trim();

function parseArgs(argv: string[]): Options {
  const options: Options = {
    targets: [],
    dataDir: resolve(process.cwd(), 'data'),
    projectId: GLOBAL_SCOPE_ID,
    all: false,
    out: null,
    endpoint: null,
    headers: {},
    service: 'sagent',
    pretty: false,
    captureContent: false,
    maxContentChars: DEFAULT_MAX_CONTENT_CHARS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      case '--all':
        options.all = true;
        break;
      case '--pretty':
        options.pretty = true;
        break;
      case '--content':
        options.captureContent = true;
        break;
      case '--max-content': {
        const value = Number(argv[++i]);
        if (Number.isFinite(value) && value > 0) options.maxContentChars = Math.floor(value);
        break;
      }
      case '--data-dir':
        options.dataDir = resolve(argv[++i] || '');
        break;
      case '--project':
        options.projectId = argv[++i] || GLOBAL_SCOPE_ID;
        break;
      case '--out':
        options.out = argv[++i] || null;
        break;
      case '--endpoint':
        options.endpoint = argv[++i] || null;
        break;
      case '--service':
        options.service = argv[++i] || 'sagent';
        break;
      case '--header': {
        const raw = argv[++i] || '';
        const eq = raw.indexOf('=');
        if (eq > 0) options.headers[raw.slice(0, eq).trim()] = raw.slice(eq + 1).trim();
        break;
      }
      default:
        if (arg.startsWith('-')) {
          console.error(`未知参数: ${arg}\n\n${USAGE}`);
          process.exit(2);
        }
        options.targets.push(arg);
    }
  }
  return options;
}

/** 从事件流里找出 sessionId —— 决定 trace_id 归属。 */
function sessionIdFromEvents(events: any[]): string | null {
  for (const event of events) {
    if (event?.type === 'run_meta' && typeof event.sessionId === 'string' && event.sessionId.trim()) {
      return event.sessionId.trim();
    }
  }
  return null;
}

function projectIdFromEvents(events: any[]): string | null {
  for (const event of events) {
    if (event?.type === 'run_meta' && typeof event.projectId === 'string' && event.projectId) {
      return event.projectId;
    }
  }
  return null;
}

/** attempt 取事件里出现过的最大值，保证重试 run 的 span 落在最后一次尝试上。 */
function maxAttempt(events: any[]): number {
  return events.reduce((max, event) => {
    const attempt = Number(event?.attempt);
    return Number.isInteger(attempt) && attempt > 0 ? Math.max(max, attempt) : max;
  }, 1);
}

/**
 * 单个 run 的事件流 → span 列表。
 *
 * 与在线路径共用 createSpanAssembler，因此产出的 span 与运行时写进 JSONL 的
 * trace_id/span_id 完全一致。
 */
function assembleRun(runId: string, events: any[], options: Options): AssembledSpan[] {
  const assembler = createSpanAssembler({
    sessionId: sessionIdFromEvents(events),
    runId,
    attempt: maxAttempt(events),
    projectId: projectIdFromEvents(events),
    captureContent: options.captureContent,
    maxContentChars: options.maxContentChars,
  });
  // 事件先按 seq 排序：SSE 重连回放可能让文件内顺序与逻辑顺序不一致。
  const ordered = [...events].sort((a, b) => {
    const left = Number.isFinite(a?.seq) ? Number(a.seq) : Number.POSITIVE_INFINITY;
    const right = Number.isFinite(b?.seq) ? Number(b.seq) : Number.POSITIVE_INFINITY;
    return left - right;
  });
  for (const event of ordered) assembler.consume(event);
  return assembler.flush();
}

async function loadTarget(target: string, dataDir: string, projectId: string) {
  // 直接给路径时按文件读；否则当作 runId 到 scope 的 traces/ 目录里找。
  if (target.endsWith('.jsonl')) {
    const raw = await readFile(resolve(target), 'utf8');
    return { runId: basename(target, '.jsonl'), events: parseTraceLines(raw) };
  }
  const scopeDir = projectDataDir(dataDir, projectId);
  return { runId: target, events: await readTraceEvents(scopeDir, target) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scopeDir = projectDataDir(options.dataDir, options.projectId);

  let targets = options.targets;
  if (options.all) {
    targets = [...targets, ...(await listTraceRuns(scopeDir))];
  }
  if (targets.length === 0) {
    console.error(`未指定要转换的 run。\n\n${USAGE}`);
    process.exit(2);
  }

  // 内容捕获 + 远端推送 = 业务数据出本机。给一行明确提示，别让人事后才发现。
  if (options.captureContent) {
    const where = options.endpoint ? `发送到 ${options.endpoint}` : '写入导出文件';
    console.error(`⚠ 已开启 --content：任务正文、模型理由、工具入参与结果将随 span ${where}。`);
  }

  let failures = 0;
  for (const target of [...new Set(targets)]) {
    let runId: string;
    let events: any[];
    try {
      ({ runId, events } = await loadTarget(target, options.dataDir, options.projectId));
    } catch (err: any) {
      console.error(`✗ ${target}: 读取失败 — ${err?.message || err}`);
      failures += 1;
      continue;
    }

    if (events.length === 0) {
      console.error(`✗ ${target}: 没有可用事件（run 不存在，或属于其它 --project）`);
      failures += 1;
      continue;
    }

    const spans = assembleRun(runId, events, options);
    const payload = buildOtlpTracePayload(spans, { serviceName: options.service });
    const traceId = spans[0]?.traceId || '(空)';

    if (options.endpoint) {
      try {
        await postOtlpTraces(options.endpoint, payload, options.headers);
        console.log(`✓ ${runId}: 已发送 ${spans.length} 个 span → ${options.endpoint}  trace_id=${traceId}`);
      } catch (err: any) {
        console.error(`✗ ${runId}: ${err?.message || err}`);
        failures += 1;
      }
      continue;
    }

    const outPath = options.out && targets.length === 1
      ? resolve(options.out)
      : join(options.dataDir, 'otlp-exports', `${runId}.otlp.json`);
    await mkdir(join(outPath, '..'), { recursive: true });
    await writeFile(outPath, JSON.stringify(payload, null, options.pretty ? 2 : 0), 'utf8');
    console.log(`✓ ${runId}: ${spans.length} 个 span → ${outPath}  trace_id=${traceId}`);
  }

  process.exit(failures > 0 ? 2 : 0);
}

main().catch(err => {
  console.error(`[trace-to-otlp] 执行失败: ${err?.message || err}`);
  process.exit(2);
});
