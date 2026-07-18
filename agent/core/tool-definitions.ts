/**
 * Tool Definitions — Agent 可用的所有工具 schema 定义
 *
 * 定义了 DesktopAgent 能调用的全部工具（只读浏览器、文件系统、终端、HTTP 抓取、核心动作）。
 *
 * 调用场景：
 *   - 各 provider 的 agentPlan() 将工具列表传给对应模型 API
 */

import { isChromeMcpAvailable } from '../tools/chrome/mcp-client.ts';
import { isGenericMcpEnabled } from '../tools/mcp/client.ts';

export type ModelToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  example: {
    rationale: string;
    input: Record<string, unknown>;
  };
};

export function createModelTools({
  includeChromeMcp = true,
  includeGenericMcp = true,
  includeToolNames,
}: {
  includeChromeMcp?: boolean;
  includeGenericMcp?: boolean;
  includeToolNames?: Iterable<string>;
} = {}) {
  // browser 工具集只负责读取页面；所有会改变网页状态的操作由可选 Chrome MCP 动态注入。
  const tools: ModelToolDefinition[] = [
    {
      name: 'navigate',
      description: '在只读内置浏览器中打开指定 URL；不得用于点击、输入、登录或提交操作',
      example: { rationale: '打开网页', input: { url: 'https://example.com' } },
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标 URL' },
        },
        required: ['url'],
      },
    },
    {
      name: 'wait',
      description: '等待指定秒数',
      example: { rationale: '等待网页加载', input: { seconds: 2 } },
      input_schema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: '等待秒数' },
        },
        required: ['seconds'],
      },
    },
    {
      name: 'scroll',
      description: '在只读内置浏览器中滚动网页（当页面内容超出视口时使用）',
      example: { rationale: '向下滚动页面', input: { direction: 'down', amount: 3 } },
      input_schema: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向' },
          amount: { type: 'number', description: '滚动步数（1-10，每步约300px）' },
        },
        required: ['direction'],
      },
    },
    {
      name: 'get_page_content',
      description: '从只读内置浏览器提取当前页面的正文文本和基础页面信息。',
      example: { rationale: '获取浏览器当前页面文本内容', input: {} },
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'list_dir',
      description: '列出目录内容',
      example: { rationale: '读取目录', input: { path: '.' } },
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径' },
        },
        required: ['path'],
      },
    },
    {
      name: 'read_file',
      description: '读取文件内容',
      example: { rationale: '读取文件', input: { path: 'README.md' } },
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
      },
    },
    {
      name: 'get_file_info',
      description: '读取文件或目录的元数据（类型、大小、修改时间），不读取文件内容。适合先判断大文件大小或确认路径是否存在。',
      example: { rationale: '查看文件大小和修改时间', input: { path: 'README.md' } },
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件或目录路径' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: '写入或追加文件',
      example: { rationale: '写文件', input: { path: 'notes.txt', content: '内容', append: false } },
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '文件内容' },
          append: { type: 'boolean', description: '追加模式而非覆盖' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'http_fetch',
      description: '用只读内置浏览器打开 URL 并提取页面文本内容。extractLinks=true 时提取页面中的链接列表。不得用于点击、输入、登录或提交操作。',
      example: { rationale: '抓取网页内容', input: { url: 'https://example.com', extractLinks: false } },
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标 URL' },
          extractLinks: { type: 'boolean', description: '是否提取页面链接列表（搜索结果页用）' },
        },
        required: ['url'],
      },
    },
    {
      name: 'web_search',
      description: '用 DuckDuckGo 搜索网络（无需 API key），返回标题/URL/摘要列表。它只用于发现候选来源；需要事实核验时必须筛选相关权威 URL，再用 http_fetch 抓取正文并从正文提取结论，不得仅凭搜索摘要回答。比直接打开 Google/Bing 更稳，不会触发反爬。',
      example: { rationale: '网络搜索关键词', input: { query: '2026 北京最低工资标准', maxResults: 5 } },
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（自然语言）' },
          maxResults: { type: 'number', description: '返回结果数（1-10，默认 5）' },
        },
        required: ['query'],
      },
    },
    {
      name: 'image_analyze',
      description: '让多模态模型分析一张图片并回答问题。用于解读浏览器/桌面截图、查看报错图、识别图表或界面布局。任务含附件时，image 应使用 @attachment/N（按图片出现顺序从 1 开始），由 runtime 绑定真实路径，不要复制或改写 @uploads 路径；其它图片可使用项目内相对路径、data URL 或 http(s) URL。question 用简体中文描述需要从图里得到的信息。识别具体来源/游戏/人物/品牌时要区分可见事实与低置信猜测；证据不足就明确说无法仅凭图片确认，不要编造 UI、文字、角色名、怪物、道具或数值。',
      example: { rationale: '分析任务中的第一张附件图片', input: { image: '@attachment/1', question: '图片里有什么内容？请详细描述。' } },
      input_schema: {
        type: 'object',
        properties: {
          image: { type: 'string', description: '图片来源：任务附件必须使用 @attachment/N；非附件图片可使用项目内相对路径、data URL 或 http(s) URL' },
          question: { type: 'string', description: '希望模型回答的问题（简体中文，越具体越好）' },
        },
        required: ['image', 'question'],
      },
    },
    {
      name: 'search_files',
      description: '在文件中搜索文本内容（类似 grep），支持 glob 过滤',
      example: { rationale: '搜索文件内容', input: { query: '关键词', path: '.', include: '*.js' } },
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词或正则表达式' },
          path: { type: 'string', description: '搜索根目录路径' },
          include: { type: 'string', description: '文件 glob 过滤（如 "*.js", "*.py"）' },
        },
        required: ['query'],
      },
    },
    {
      name: 'run_safe',
      description: '运行只读终端命令（白名单内，不含管道等复杂操作）',
      example: { rationale: '运行只读命令', input: { command: 'pwd' } },
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '终端命令' },
        },
        required: ['command'],
      },
    },
    {
      name: 'run_confirmed',
      description: '运行需用户确认的终端命令（直接执行，无白名单限制）',
      example: { rationale: '运行需确认命令', input: { command: 'git status' } },
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '终端命令' },
        },
        required: ['command'],
      },
    },
    {
      name: 'run_review',
      description: '运行需要用户审批的终端命令（如 cd/pushd/popd 等状态切换命令）',
      example: { rationale: '切换目录', input: { command: 'cd /path/to/dir' } },
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '终端命令' },
        },
        required: ['command'],
      },
    },
    {
      name: 'ask_user',
      description: '向用户提出开放式问题并等待回答。当需要用户输入或确认偏好时使用。',
      example: { rationale: '向用户提问', input: { question: '你希望使用什么命名规范？' } },
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题（简体中文）' },
        },
        required: ['question'],
      },
    },
    {
      name: 'notify_user',
      description: '向用户推送信息性消息（洞察、警告、发现）。不暂停任务执行。适用于报告中间进展或重要发现。',
      example: { rationale: '发现重要问题需告知用户', input: { message: '发现 3 个硬编码 API 密钥', level: 'warning' } },
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '通知内容（简体中文）' },
          level: { type: 'string', enum: ['info', 'warning', 'discovery'], description: '通知级别' },
        },
        required: ['message'],
      },
    },
    {
      name: 'finish',
      description: '完成任务并返回最终结果',
      example: { rationale: '完成任务', input: { answer: '最终结果' } },
      input_schema: {
        type: 'object',
        properties: {
          answer: { type: 'string', description: '任务完成结果（简体中文）' },
        },
        required: ['answer'],
      },
    },
  ];

  if (includeChromeMcp && isChromeMcpAvailable()) {
    tools.splice(tools.length - 1, 0,
      {
        name: 'chrome_list_tools',
        description: '列出当前 Chrome DevTools MCP 暴露的工具及参数。可查看浏览器操作、截图、网络检查等可用能力。',
        example: { rationale: '刷新 Chrome 工具列表', input: { refresh: true } },
        input_schema: {
          type: 'object',
          properties: {
            refresh: { type: 'boolean', description: '是否强制重新拉取 Chrome 工具列表' },
          },
        },
      },
      {
        name: 'chrome_call_tool',
        description: '调用 Chrome DevTools MCP 的某个工具。toolName 必须来自 chrome_list_tools，arguments 传该工具要求的参数对象。',
        example: { rationale: '调用 Chrome 工具截图', input: { toolName: 'take_screenshot', arguments: {} } },
        input_schema: {
          type: 'object',
          properties: {
            toolName: { type: 'string', description: 'Chrome MCP 工具名称，例如 take_snapshot、click、fill、navigate_page' },
            arguments: {
              type: 'object',
              description: '传给 Chrome MCP 工具的参数对象',
              additionalProperties: true,
            },
            refreshTools: { type: 'boolean', description: '调用前是否刷新一次 Chrome 工具列表' },
          },
          required: ['toolName'],
        },
      }
    );
  }

  if (includeGenericMcp && isGenericMcpEnabled()) {
    tools.splice(tools.length - 1, 0,
      {
        name: 'mcp_list_servers',
        description: '列出 sagent 中已启用的通用 MCP server。Chrome 使用专用工具，不在此列表中。',
        example: { rationale: '查看通用 MCP server', input: {} },
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'mcp_list_tools',
        description: '列出指定通用 MCP server 暴露的工具、参数和安全注解。',
        example: { rationale: '查看 Codex MCP 工具', input: { serverName: 'codex' } },
        input_schema: {
          type: 'object',
          properties: {
            serverName: { type: 'string', description: 'MCP server 名称，来自 mcp_list_servers' },
            refresh: { type: 'boolean', description: '是否强制刷新工具列表' },
          },
          required: ['serverName'],
        },
      },
      {
        name: 'mcp_call_tool',
        description: '调用指定通用 MCP server 的某个工具。调用前先用 mcp_list_tools 获取准确的工具名与参数。',
        example: { rationale: '调用 Codex 编码工具', input: { serverName: 'codex', toolName: 'codex', arguments: { prompt: '检查并修复测试失败' } } },
        input_schema: {
          type: 'object',
          properties: {
            serverName: { type: 'string', description: 'MCP server 名称' },
            toolName: { type: 'string', description: '该 server 暴露的工具名称' },
            arguments: { type: 'object', description: '传给 MCP 工具的参数对象', additionalProperties: true },
            refreshTools: { type: 'boolean', description: '调用前是否刷新工具列表' },
          },
          required: ['serverName', 'toolName'],
        },
      }
    );
  }

  let selected = tools;
  if (includeToolNames) {
    const allowed = new Set(includeToolNames);
    selected = selected.filter(tool => allowed.has(tool.name));
  }
  return selected;
}

// Gemini FunctionDeclaration：name/description + parametersJsonSchema（标准 JSON Schema，
// 与内部 input_schema 同构，直接复用）。
export function toolToGeminiTool(tool: ModelToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.input_schema,
  };
}
