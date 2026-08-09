/**
 * OpenAI 兼容请求构造与回退处理
 *
 * 用途：构造 chat.completions 请求体，处理两类不兼容回退：
 *   - chat_template_kwargs（deepseek 思考参数）不受支持 → 去掉重试
 *   - system role 不受支持 → 合并进首条 user 消息重试
 * 供 openai-compat 供应商与 planner 的正常/重试路径共用，保证两处回退行为一致。
 */

import { retryAsync } from '../../helpers/retry.ts';
import { log } from '../../helpers/logger.ts';

const DEFAULT_THINKING_CHAT_TEMPLATE_KWARGS = {
  thinking: true,
  reasoning_effort: 'high',
};

/** deepseek 系列默认追加 thinking chat_template_kwargs，其它模型不加。 */
export function defaultChatTemplateKwargsForModel(model: string) {
  return /deepseek/i.test(model)
    ? { ...DEFAULT_THINKING_CHAT_TEMPLATE_KWARGS }
    : null;
}

/** content 字段归一为纯文本（string 或 {text} 片段数组）。 */
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

/** 识别「不支持 system role」类错误（400/422/500 + 特征文案）。
 *  当前使用：planner.ts 与 openai-compat.ts 的回退分支。 */
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

/** 把 system 消息合并进首条 user 消息（保留原文前缀），无 user 时补一条。 */
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

/**
 * 构造 chat.completions 请求体：合并 thinking 模板参数、tools/tool_choice，
 * 并按 supportedMessageRoles 决定是否折叠 system role。
 * 当前使用：planner.ts 与 openai-compat.ts 的请求构造。
 */
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
/** 识别「不支持 tools」类错误，供 planner 回退 JSON-in-prompt。 */
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

/** 识别「chat_template_kwargs 不受支持」类错误（400 + 特征文案）。 */
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

/** 去掉请求体里的 chat_template_kwargs 字段后返回新请求。 */
export function withoutChatTemplateKwargs(request: any) {
  const { chat_template_kwargs: _chatTemplateKwargs, ...rest } = request;
  return rest;
}

/**
 * 带两级回退的 chat.completions 调用：先摘掉 thinking 模板参数，再折叠 system role，
 * 两者各只回退一次，都失败则抛原错误（经 retryAsync 带重试）。
 * 当前使用：planner.ts 与 openai-compat.ts 的模型调用路径。
 */
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
