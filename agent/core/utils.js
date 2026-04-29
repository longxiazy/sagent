/**
 * Utils — 全局共享的小工具函数
 *
 * 被几乎所有 agent/core/ 模块引用：
 *   - safeJson: 安全序列化，防止循环引用导致崩溃。用于日志输出
 *   - cleanText: 压缩空白 + 截断。用于截断 LLM 输出、rationale、记忆摘要等
 */

export function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export function cleanText(value, maxLength = 240) {
  if (typeof value !== 'string') {
    return '';
  }

  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

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

export function padEndW(str, targetWidth) {
  const padding = Math.max(0, targetWidth - displayWidth(str));
  return str + ' '.repeat(padding);
}

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
