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

function contentAsText(content: any) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

export function isUnsupportedSystemRoleError(err: any) {
  const message = String(err?.message || err?.error?.message || '').toLowerCase();
  const status = err?.status || err?.statusCode || 0;
  return [400, 422, 500].includes(status) && (
    message.includes('system role not supported') ||
    message.includes('system message not supported') ||
    message.includes('does not support system') ||
    message.includes('unsupported role: system')
  );
}

export function withoutSystemRole(request: any) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const systemText = messages
    .filter(message => message?.role === 'system')
    .map(message => contentAsText(message.content))
    .filter(Boolean)
    .join('\n\n');
  if (!systemText) return request;

  const remaining = messages.filter(message => message?.role !== 'system');
  const firstUserIndex = remaining.findIndex(message => message?.role === 'user');
  const prefix = `[System instructions]\n${systemText}\n\n[User message]\n`;

  if (firstUserIndex === -1) {
    remaining.unshift({ role: 'user', content: prefix.trimEnd() });
  } else {
    const firstUser = remaining[firstUserIndex];
    if (Array.isArray(firstUser.content)) {
      remaining[firstUserIndex] = {
        ...firstUser,
        content: [{ type: 'text', text: prefix }, ...firstUser.content],
      };
    } else {
      remaining[firstUserIndex] = {
        ...firstUser,
        content: `${prefix}${contentAsText(firstUser.content)}`,
      };
    }
  }

  return { ...request, messages: remaining };
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
    tools?: any[];
    tool_choice?: any;
  },
  { defaultThinking = false, supportedMessageRoles }: { defaultThinking?: boolean; supportedMessageRoles?: string[] } = {}
) {
  const explicitChatTemplateKwargs = normalizeChatTemplateKwargs(opts.chat_template_kwargs);
  const defaultChatTemplateKwargs = explicitChatTemplateKwargs
    ? null
    : defaultThinking
      ? defaultChatTemplateKwargsForModel(opts.model)
      : null;
  const chatTemplateKwargs = explicitChatTemplateKwargs || defaultChatTemplateKwargs;

  const request = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature,
      top_p: opts.top_p,
      max_tokens: opts.max_tokens,
      ...(chatTemplateKwargs ? { chat_template_kwargs: chatTemplateKwargs } : {}),
      ...(Array.isArray(opts.tools) && opts.tools.length > 0
        ? { tools: opts.tools, ...(opts.tool_choice !== undefined ? { tool_choice: opts.tool_choice } : {}) }
        : {}),
    };
  const adaptedRequest = Array.isArray(supportedMessageRoles)
    && supportedMessageRoles.length > 0
    && !supportedMessageRoles.includes('system')
    ? withoutSystemRole(request)
    : request;

  return {
    request: adaptedRequest,
    defaultedChatTemplateKwargs: Boolean(defaultChatTemplateKwargs),
  };
}

// 尽管模型在 catalog 中声明支持 tools，个别端点/版本仍可能拒绝该参数；命中后由 planner 回退 JSON-in-prompt。
export function isUnsupportedToolsError(err: any) {
  const message = String(err?.message || err?.error?.message || '').toLowerCase();
  const status = err?.status || err?.statusCode || 0;
  return [400, 404, 422, 500].includes(status) && (
    message.includes('does not support tools') ||
    message.includes('tools is not supported') ||
    message.includes('tool use is not supported') ||
    message.includes('tool calling is not supported') ||
    message.includes('function calling is not') ||
    message.includes('tool_choice') ||
    ((message.includes('unknown parameter') || message.includes('unrecognized request argument') || message.includes('extra_forbidden')) && message.includes('tool'))
  );
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

  let activeRequest = request;
  let activeContext = retryContext;
  let templateFallbackUsed = false;
  let systemRoleFallbackUsed = false;

  for (;;) {
    try {
      return await create(activeRequest, activeContext);
    } catch (err) {
      if (
        !templateFallbackUsed
        && defaultedChatTemplateKwargs
        && activeRequest?.chat_template_kwargs
        && isUnsupportedChatTemplateKwargsError(err)
      ) {
        templateFallbackUsed = true;
        log.warn('chat_template_kwargs 不受支持，改为关闭 thinking 参数重试:', err.message);
        activeRequest = withoutChatTemplateKwargs(activeRequest);
        activeContext = retryContext
          ? { ...retryContext, chat_template_kwargs: 'disabled' }
          : retryContext;
        continue;
      }

      if (
        !systemRoleFallbackUsed
        && activeRequest?.messages?.some?.((message: any) => message?.role === 'system')
        && isUnsupportedSystemRoleError(err)
      ) {
        systemRoleFallbackUsed = true;
        log.warn('system role 不受支持，合并到首条 user 消息后重试:', err.message);
        activeRequest = withoutSystemRole(activeRequest);
        activeContext = retryContext
          ? { ...retryContext, system_role: 'folded_into_user' }
          : retryContext;
        continue;
      }

      throw err;
    }
  }
}
