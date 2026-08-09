/**
 * OTLP/JSON 序列化 —— 把 AssembledSpan 转成任意 OTLP 接收端认得的载荷。
 *
 * 手写而非用 SDK：OTLP/JSON 只是一个普通 JSON 结构，本项目为此引入
 * @opentelemetry/* 一整套依赖并不划算。规范里几条容易踩的硬性要求：
 *
 *   - traceId / spanId 用**十六进制字符串**，不是 base64（这是 OTLP/JSON 相对
 *     标准 Protobuf JSON Mapping 的显式偏离）
 *   - 枚举（kind、status.code）必须是**整数**，不能是名字字符串
 *   - 所有 key 用 lowerCamelCase（startTimeUnixNano，不是 start_time_unix_nano）
 *   - 64 位整数编码成**十进制字符串**。纳秒时间戳超过 Number.MAX_SAFE_INTEGER，
 *     所以必须走 BigInt 再转字符串，直接乘 1e6 会丢精度
 *   - POST 时 Content-Type 必须是 application/json
 *
 * 参考：https://github.com/open-telemetry/opentelemetry-proto/blob/main/docs/specification.md
 *       的 "JSON Protobuf Encoding" 一节。
 */

import { ATTR, SCOPE } from './semconv.ts';
import type { AssembledSpan, SpanAttributeValue } from './span-assembler.ts';

/** 毫秒 → 纳秒十进制字符串。用 BigInt 避免超出安全整数范围后丢精度。 */
function toUnixNano(milliseconds: number): string {
  const ms = Number.isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds)) : 0;
  return (BigInt(ms) * 1_000_000n).toString();
}

/** 属性值包装成 OTLP 的 AnyValue。整数走 intValue（十进制字符串），小数走 doubleValue。 */
function toAnyValue(value: SpanAttributeValue) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: String(value) };
}

function toAttributeList(attributes: Record<string, SpanAttributeValue>) {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

function toOtlpSpan(span: AssembledSpan) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: toUnixNano(span.startTimeMs),
    endTimeUnixNano: toUnixNano(span.endTimeMs),
    attributes: toAttributeList(span.attributes),
    ...(span.events.length > 0
      ? {
          events: span.events.map(event => ({
            timeUnixNano: toUnixNano(event.timeMs),
            name: event.name,
            attributes: toAttributeList(event.attributes),
          })),
        }
      : {}),
    status: {
      code: span.status.code,
      ...(span.status.message ? { message: span.status.message } : {}),
    },
  };
}

export interface OtlpPayloadOptions {
  serviceName?: string;
  serviceVersion?: string;
}

/**
 * 打包成一次 OTLP ExportTraceServiceRequest。
 *
 * 所有 span 放进同一个 resourceSpans/scopeSpans —— 它们都来自同一个进程、
 * 同一个 instrumentation scope，无需再分组。
 */
export function buildOtlpTracePayload(
  spans: AssembledSpan[],
  { serviceName = 'sagent', serviceVersion }: OtlpPayloadOptions = {},
) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: toAttributeList({
            [ATTR.SERVICE_NAME]: serviceName,
            ...(serviceVersion ? { [ATTR.SERVICE_VERSION]: serviceVersion } : {}),
          }),
        },
        scopeSpans: [
          {
            scope: { name: SCOPE.name, version: SCOPE.version },
            spans: spans.map(toOtlpSpan),
          },
        ],
      },
    ],
  };
}

/**
 * POST 到 collector 的 /v1/traces。用内置 fetch，无额外依赖。
 * 失败时抛出含状态码与响应体的错误，方便定位是 collector 拒收还是网络不通。
 */
export async function postOtlpTraces(endpoint: string, payload: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OTLP export failed: HTTP ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`);
  }
  return response;
}
