import { streamChatCompletion } from '../api/streams.js';
import { touchSession } from './useChatSessions.js';
import { useT } from '../i18n/I18nProvider.jsx';

// 普通对话的核心流程：
// 1. 先写入 user message + 一个空 assistant 占位
// 2. 流式把 token 追加到最后一条 assistant 消息
// 3. 中断/失败时把状态折叠成用户可见的文本结果
export function useChatTransport({
  activeSession,
  messages,
  chatModel,
  updateSession,
  setStreaming,
  setInput,
  abortRef,
  textareaRef,
}) {
  const t = useT();
  const stopGeneration = () => abortRef.current?.abort();

  const sendChatMessage = async text => {
    const sessionId = activeSession.id;
    const now = Date.now();
    const userMsg = { role: 'user', content: text, ts: now };
    const history = [...messages, userMsg];
    const apiMessages = history;

    updateSession(sessionId, session =>
      touchSession(session, {
        messages: [...history, { role: 'assistant', content: '', ts: now }],
      })
    );
    setInput('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChatCompletion({
        messages: apiMessages,
        model: chatModel,
        signal: controller.signal,
        onContent(content) {
          updateSession(sessionId, session => {
            const nextMessages = [...session.messages];
            const lastMessage = nextMessages[nextMessages.length - 1] || { role: 'assistant', content: '' };
            nextMessages[nextMessages.length - 1] = {
              role: 'assistant',
              content: (lastMessage.content || '') + content,
            };

            return touchSession(session, { messages: nextMessages });
          });
        },
      });
    } catch (err) {
      if (err.name === 'AbortError' || (err.name === 'TypeError' && /load failed|network|fetch/i.test(err.message))) {
        updateSession(sessionId, session => {
          const nextMessages = [...session.messages];
          const lastMessage = nextMessages[nextMessages.length - 1];
          nextMessages[nextMessages.length - 1] = {
            ...lastMessage,
            content: `${lastMessage?.content || ''}${lastMessage?.content ? '\n\n' : ''}${t('chat.stopped')}`,
          };

          return touchSession(session, { messages: nextMessages });
        });
      } else {
        const detail = err.stack ? `\n\`\`\`\n${err.stack.split('\n').slice(0, 3).join('\n')}\n\`\`\`` : '';
        updateSession(sessionId, session => {
          const nextMessages = [...session.messages];
          nextMessages[nextMessages.length - 1] = {
            role: 'assistant',
            content: t('chat.requestFailed', { error: err.message, detail }),
          };

          return touchSession(session, { messages: nextMessages });
        });
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  return { sendChatMessage, stopGeneration };
}
