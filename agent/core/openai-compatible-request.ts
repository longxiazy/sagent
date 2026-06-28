import { retryAsync } from '../../helpers/retry.ts';
import { log } from '../../helpers/logger.ts';

const DEFAULT_THINKING_CHAT_TEMPLATE_KWARGS = {
  thinking: true,
  reasoning_effort: 'high',
};

export function defaultChatTemplateKwargsForModel(model: string) {
  return /deepseek/i.test(model)
    ? { ...DEFAULT_THINKING_CHAT_TEMPLATE_KWARGS }
    : null;
}

function normalizeChatTemplateKwargs(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function buildChatCompletionRequest(
  opts: {
    model: string;
    messages: any[];
    temperature: number;
    top_p: number;
    max_tokens: number;
    chat_template_kwargs?: any;
  },
  { defaultThinking = false } = {}
) {
  const explicitChatTemplateKwargs = normalizeChatTemplateKwargs(opts.chat_template_kwargs);
  const defaultChatTemplateKwargs = explicitChatTemplateKwargs
    ? null
    : defaultThinking
      ? defaultChatTemplateKwargsForModel(opts.model)
      : null;
  const chatTemplateKwargs = explicitChatTemplateKwargs || defaultChatTemplateKwargs;

  return {
    request: {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature,
      top_p: opts.top_p,
      max_tokens: opts.max_tokens,
      ...(chatTemplateKwargs ? { chat_template_kwargs: chatTemplateKwargs } : {}),
    },
    defaultedChatTemplateKwargs: Boolean(defaultChatTemplateKwargs),
  };
}

export function isUnsupportedChatTemplateKwargsError(err: any) {
  const message = String(err?.message || err?.error?.message || '').toLowerCase();
  const status = err?.status || err?.statusCode || 0;
  return status === 400 && (
    message.includes('chat_template_kwargs') ||
    message.includes('unknown parameter') ||
    message.includes('unrecognized request argument') ||
    message.includes('extra_forbidden')
  );
}

export function withoutChatTemplateKwargs(request: any) {
  const { chat_template_kwargs: _chatTemplateKwargs, ...rest } = request;
  return rest;
}

export async function createChatCompletionWithTemplateFallback({
  client,
  request,
  reqOpts,
  retryContext,
  retryOptions,
  defaultedChatTemplateKwargs = false,
}: {
  client: any;
  request: any;
  reqOpts?: any;
  retryContext?: any;
  retryOptions?: any;
  defaultedChatTemplateKwargs?: boolean;
}) {
  const create = (payload: any, context = retryContext) => {
    if (context) {
      return retryAsync(() => client.chat.completions.create(payload, reqOpts), undefined, context, retryOptions);
    }
    return client.chat.completions.create(payload, reqOpts);
  };

  try {
    return await create(request);
  } catch (err) {
    if (!defaultedChatTemplateKwargs || !request?.chat_template_kwargs || !isUnsupportedChatTemplateKwargsError(err)) {
      throw err;
    }

    log.warn('chat_template_kwargs 不受支持，改为关闭 thinking 参数重试:', err.message);
    const fallbackRequest = withoutChatTemplateKwargs(request);
    const fallbackContext = retryContext
      ? { ...retryContext, chat_template_kwargs: 'disabled' }
      : retryContext;
    return create(fallbackRequest, fallbackContext);
  }
}
