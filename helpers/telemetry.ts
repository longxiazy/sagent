/**
 * Telemetry — 轻量级 OpenTelemetry 兼容 Span 追踪
 *
 * 零外部依赖，产出 JSON 文件（data/traces/<runId>.jsonl），
 * 可选导出到 OTLP HTTP endpoint（设置 OTEL_EXPORTER_OTLP_ENDPOINT 即可）。
 *
 * Span 层级：
 *   agent.run → agent.step.* → { agent.plan | agent.execute → tool.* }
 *
 * 配置：
 *   OTEL_EXPORTER_OTLP_ENDPOINT — OTLP HTTP 导出地址（如 http://localhost:4318/v1/traces）
 *   OTEL_SERVICE_NAME            — 服务名（默认 sagent）
 *   OTEL_ENABLED                 — 设为 false 或 0 关闭追踪
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACE_DIR = join(__dirname, '..', 'data', 'traces');
const OTEL_ENABLED = process.env.OTEL_ENABLED !== 'false' && process.env.OTEL_ENABLED !== '0';
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '';
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'sagent';

// ── Span ID / Trace ID generation (W3C-compatible 32-char hex) ──

function hex32(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function nsTime(): number {
  return Math.floor(performance.now() * 1_000_000);
}

// ── Span ──

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'INTERNAL' | 'CLIENT';
  startTimeNs: number;
  endTimeNs?: number;
  attributes: Record<string, string | number | boolean>;
  status: { code: number; message?: string };
  events: Array<{ name: string; timestampNs: number; attributes?: Record<string, string | number> }>;
}

let pendingTrace: { traceId: string; spans: Span[] } | null = null;

function ensureDir() {
  if (!existsSync(TRACE_DIR)) {
    try { mkdirSync(TRACE_DIR, { recursive: true }); } catch {}
  }
}

function flushToFile(traceId: string, span: Span) {
  if (!OTEL_ENABLED) return;
  ensureDir();
  try {
    const file = join(TRACE_DIR, `${traceId}.jsonl`);
    appendFileSync(file, JSON.stringify(span) + '\n');
  } catch {}
}

function flushToOtlp(traceId: string, span: Span) {
  if (!OTLP_ENDPOINT) return;

  // Batch and send on span end. Simple "send each span" strategy.
  const body = JSON.stringify({
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: SERVICE_NAME } },
        ],
      },
      scopeSpans: [{
        scope: { name: SERVICE_NAME },
        spans: [{
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId || '',
          name: span.name,
          kind: span.kind === 'CLIENT' ? 3 : 1,
          startTimeUnixNano: String(span.startTimeNs),
          endTimeUnixNano: String(span.endTimeNs || span.startTimeNs),
          attributes: Object.entries(span.attributes).map(([k, v]) => ({
            key: k,
            value: typeof v === 'number'
              ? (Number.isInteger(v) ? { intValue: v } : { doubleValue: v })
              : typeof v === 'boolean'
                ? { boolValue: v }
                : { stringValue: String(v) },
          })),
          status: { code: span.status.code, message: span.status.message || '' },
        }],
      }],
    }],
  });

  fetch(OTLP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).catch(() => {}); // fire-and-forget
}

// ── Public API ──

export interface TelemetrySpan {
  /** Record a key-value attribute on the span */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Add a named event with optional attributes */
  addEvent(name: string, attrs?: Record<string, string | number>): void;
  /** Mark span as errored */
  setError(message: string): void;
  /** End the span and flush */
  end(): void;
}

class SpanImpl implements TelemetrySpan {
  private span: Span;

  constructor(traceId: string, name: string, parentSpanId?: string, kind: 'INTERNAL' | 'CLIENT' = 'INTERNAL') {
    this.span = {
      traceId,
      spanId: hex32(),
      parentSpanId,
      name,
      kind,
      startTimeNs: nsTime(),
      attributes: {},
      status: { code: 0 }, // UNSET
      events: [],
    };
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.span.attributes[key] = value;
  }

  addEvent(name: string, attrs?: Record<string, string | number>): void {
    this.span.events.push({ name, timestampNs: nsTime(), attributes: attrs });
  }

  setError(message: string): void {
    this.span.status = { code: 2, message };
  }

  end(): void {
    this.span.endTimeNs = nsTime();
    flushToFile(this.span.traceId, this.span);
    flushToOtlp(this.span.traceId, this.span);
  }
}

/**
 * Start a new trace + root span.
 * Returns { traceId, root } — root is the top-level span.
 */
export function startTrace(name: string, attrs?: Record<string, string | number | boolean>): { traceId: string; root: TelemetrySpan } {
  const traceId = hex32();
  const root = new SpanImpl(traceId, name);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      root.setAttribute(k, v);
    }
  }
  return { traceId, root };
}

/**
 * Create a child span under an existing trace.
 */
export function startSpan(traceId: string, name: string, parentSpanId: string, attrs?: Record<string, string | number | boolean>, kind: 'INTERNAL' | 'CLIENT' = 'INTERNAL'): TelemetrySpan {
  const s = new SpanImpl(traceId, name, parentSpanId, kind);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      s.setAttribute(k, v);
    }
  }
  return s;
}

/**
 * Get the span ID from a TelemetrySpan
 */
export function spanId(s: TelemetrySpan): string {
  return (s as SpanImpl).spanId;
}

/**
 * Check if telemetry is enabled
 */
export function isTelemetryEnabled(): boolean {
  return OTEL_ENABLED;
}