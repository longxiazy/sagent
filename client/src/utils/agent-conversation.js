// 发给 Agent 的 conversationHistory：只包含「本轮任务之前」的对话，
// 供模型理解当前 task 里的指代。本轮任务本身通过 task 字段单独下发，不重复放进来。

const MAX_CONVERSATION_MESSAGES = 10;

/**
 * 从会话消息里切出本轮任务之前的部分。
 *
 * 首跑时 messages 还没追加本轮 user 消息，整条列表都属于"之前"，取尾部即可。
 * 从 checkpoint 重跑时则不然：messages 已经包含本轮 user 任务、"运行中"占位助手消息，
 * 以及上一次失败后追加的重试提示，直接取尾部会把这些噪声当成历史对话喂回模型。
 * 所以重跑时回退到本轮 user 消息之前，使重跑与首跑的 prompt 输入保持一致——
 * 否则模型会在重跑后突然失去 task 里指代词（"这几个""上面提到的"）的所指。
 *
 * @param {Array<{role?: string, content?: string, pending?: string}>} messages 当前会话消息
 * @param {{ isRetry?: boolean, task?: string }} options isRetry 为从 checkpoint 重跑；task 为本轮任务原文
 */
export function buildRunConversationHistory(messages, { isRetry = false, task = '' } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let prior = list;

  if (isRetry) {
    const taskText = typeof task === 'string' ? task.trim() : '';
    const taskIndex = taskText
      ? list.findLastIndex(message => message?.role === 'user' && String(message?.content ?? '').trim() === taskText)
      : -1;
    prior = taskIndex >= 0
      // 命中本轮任务：它及其之后的都是本轮产物，一律丢弃。
      ? list.slice(0, taskIndex)
      // 兜底（刷新后 lastAgentTaskRef 丢失、task 退化成占位文案时匹配不上）：
      // 至少剔除 pending 占位消息，它们是 UI 运行态而非真实对话。
      : list.filter(message => !message?.pending);
  }

  return prior
    .slice(-MAX_CONVERSATION_MESSAGES)
    .map(message => ({ role: message?.role, content: message?.content }));
}
