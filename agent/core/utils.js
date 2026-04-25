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
