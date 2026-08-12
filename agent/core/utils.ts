/**
 * Utils — 全局共享的小工具函数
 *
 * 被几乎所有 agent/core/ 模块引用：
 *   - safeJson: 安全序列化，防止循环引用导致崩溃。用于日志输出
 *   - cleanText: 压缩空白 + 截断。用于截断 LLM 输出、rationale、记忆摘要等
 *   - formatRawOutputForError: 把模型原文包成围栏代码块，用于解析失败的错误信息
 */

/** 安全序列化；循环引用等异常时返回占位符，避免日志崩溃。 */
export function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/** planner 解析失败错误里「原始输出」段的定位标记（planner.ts 写入、trace-replay.ts 解析）。 */
export const RAW_OUTPUT_MARKER = '原始输出=';

/**
 * 把模型原文包进围栏代码块，供解析失败的错误信息展示。
 *
 * 刻意不做 JSON.stringify：stringify 会给原文里每个 " 都加一层反斜杠，
 * 于是「模型已转义」(\\\") 和「模型未转义」(\") 在错误信息里只差一个反斜杠，
 * 肉眼几乎无法区分，排查时极易把模型的格式错误误判成解析器的 bug。
 * 原文自带 ``` 时自动加长围栏，避免代码块被提前闭合。
 */
export function formatRawOutputForError(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const tickRuns: string[] = text.match(/`+/g) ?? [];
  const longestTicks = tickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestTicks + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** 压缩连续空白并截断到 maxLength（超长加 …）。 */
export function cleanText(value, maxLength = 240) {
  if (typeof value !== 'string') {
    return '';
  }

  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/** 显示宽度：CJK/全角/韩文按 2 列计，其余按 1 列（对齐日志框用，与 truncateW 的宽字符口径不同）。 */
export function displayWidth(str) {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    w += (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified
         (code >= 0x3000 && code <= 0x303F) ||   // CJK Symbols
         (code >= 0xFF00 && code <= 0xFFEF) ||   // Fullwidth Forms
         (code >= 0xFE30 && code <= 0xFE4F) ||   // CJK Compat
         (code >= 0xF900 && code <= 0xFAFF) ||   // CJK Compat Ideographs
         (code >= 0x2E80 && code <= 0x2EFF) ||   // CJK Radicals
         (code >= 0x2F00 && code <= 0x2FDF) ||   // Kangxi Radicals
         (code >= 0x3400 && code <= 0x4DBF) ||   // CJK Extension A
         (code >= 0xAC00 && code <= 0xD7AF)      // Hangul Syllables
      ? 2 : 1;
  }
  return w;
}

/** 按显示宽度补齐空格到 targetWidth。 */
export function padEndW(str, targetWidth) {
  const padding = Math.max(0, targetWidth - displayWidth(str));
  return str + ' '.repeat(padding);
}

/** 按显示宽度截断到 maxWidth（超长末尾换 …）。 */
export function truncateW(str, maxWidth) {
  if (displayWidth(str) <= maxWidth) return str;
  let w = 0;
  let i = 0;
  for (const ch of str) {
    const cw = ch.codePointAt(0) > 0x7F ? 2 : 1;
    if (w + cw > maxWidth - 1) return str.slice(0, i) + '…';
    w += cw;
    i += ch.length;
  }
  return str;
}
