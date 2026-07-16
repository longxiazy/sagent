/**
 * Tool Definitions — Agent 可用的所有工具 schema 定义
 *
 * 定义了 DesktopAgent 能调用的全部工具（浏览器、文件系统、终端、HTTP 抓取、核心动作）。
 *
 * 调用场景：
 *   - 各 provider 的 agentPlan() 将工具列表传给对应模型 API
 */

import { isIdeMcpEnabled } from '../tools/ide/mcp-client.ts';
import { isChromeMcpAvailable } from '../tools/chrome/mcp-client.ts';
import { isGenericMcpEnabled } from '../tools/mcp/client.ts';

const READONLY_TOOL_NAMES = new Set([
  'list_dir',
  'read_file',
  'get_file_info',
  'search_files',
  'web_search',
  'image_analyze',
  'codegraph_query',
  'finish',
]);

export function createModelTools({
  mode = 'full',
  includeIdeMcp = true,
  includeChromeMcp = true,
  includeGenericMcp = true,
  includeToolNames,
}: {
  mode?: 'full' | 'readonly';
  includeIdeMcp?: boolean;
  includeChromeMcp?: boolean;
  includeGenericMcp?: boolean;
  includeToolNames?: Iterable<string>;
} = {}) {
  const tools: any[] = [
    {
      name: 'navigate',
      description: '在浏览器中打开指定 URL',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标 URL' },
        },
        required: ['url'],
      },
    },
    {
      name: 'click',
      description: '点击网页元素（通过 elementId）',
      input_schema: {
        type: 'object',
        properties: {
          elementId: { type: 'string', description: '元素的 data-agent-node-id' },
        },
        required: ['elementId'],
      },
    },
    {
      name: 'type',
      description: '在输入框中输入文字',
      input_schema: {
        type: 'object',
        properties: {
          elementId: { type: 'string', description: '输入框的 elementId' },
          text: { type: 'string', description: '要输入的文字' },
          submit: { type: 'boolean', description: '输入后按回车' },
        },
        required: ['elementId', 'text'],
      },
    },
    {
      name: 'wait',
      description: '等待指定秒数',
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
      description: '滚动网页（当页面内容超出视口时使用）',
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
      description: '提取当前浏览器页面的正文文本和基础页面信息。',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'list_dir',
      description: '列出目录内容',
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
      description: '用浏览器打开 URL 并提取页面文本内容。extractLinks=true 时提取页面中的链接列表（用于搜索结果页）。',
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
      name: 'codegraph_query',
      description: '查询项目代码知识图谱：按关键词返回相关模块的路径、职责、导出与依赖，帮你快速定位代码而无需逐个 read_file/list_dir 探索。适合任务开始时先了解项目结构。图谱需用户先在记忆面板「Code Graph」生成，未生成时工具会给出提示。',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查找的模块/功能关键词（如 "记忆 memory"、"项目隔离 project"、"路由 router"）' },
        },
        required: ['query'],
      },
    },
    {
      name: 'run_safe',
      description: '运行只读终端命令（白名单内，不含管道等复杂操作）',
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
      input_schema: {
        type: 'object',
        properties: {
          answer: { type: 'string', description: '任务完成结果（简体中文）' },
        },
        required: ['answer'],
      },
    },
  ];

  if (includeIdeMcp && isIdeMcpEnabled()) {
    tools.splice(tools.length - 1, 0,
      {
        name: 'ide_list_tools',
        description: '列出当前 JetBrains IDE 暴露的 MCP 工具及参数。连接 JetBrains IDE 时，优先先调用它了解可用 IDE 能力。',
        input_schema: {
          type: 'object',
          properties: {
            refresh: { type: 'boolean', description: '是否强制重新拉取 IDE 工具列表' },
          },
        },
      },
      {
        name: 'ide_call_tool',
        description: '调用 JetBrains IDE 的某个 MCP 工具。toolName 必须来自 ide_list_tools，arguments 传该工具要求的参数对象。',
        input_schema: {
          type: 'object',
          properties: {
            toolName: { type: 'string', description: 'IDE MCP 工具名称，例如 get_run_configurations、get_file_problems、rename_refactoring' },
            arguments: {
              type: 'object',
              description: '传给 IDE MCP 工具的参数对象；如果工具支持 projectPath 且未传入，会自动补齐',
              additionalProperties: true,
            },
            refreshTools: { type: 'boolean', description: '调用前是否刷新一次 IDE 工具列表' },
          },
          required: ['toolName'],
        },
      }
    );
  }

  if (includeChromeMcp && isChromeMcpAvailable()) {
    tools.splice(tools.length - 1, 0,
      {
        name: 'chrome_list_tools',
        description: '列出当前 Chrome DevTools MCP 暴露的工具及参数。可查看浏览器操作、截图、网络检查等可用能力。',
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
        description: '列出 sagent 中已启用的通用 MCP server。Chrome 与 JetBrains 使用各自的专用工具，不在此列表中。',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'mcp_list_tools',
        description: '列出指定通用 MCP server 暴露的工具、参数和安全注解。',
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

  let selected = mode === 'readonly' ? tools.filter(tool => READONLY_TOOL_NAMES.has(tool.name)) : tools;
  if (includeToolNames) {
    const allowed = new Set(includeToolNames);
    selected = selected.filter(tool => allowed.has(tool.name));
  }
  return selected;
}

// Gemini FunctionDeclaration：name/description + parametersJsonSchema（标准 JSON Schema，
// 与内部 input_schema 同构，直接复用）。
export function toolToGeminiTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.input_schema,
  };
}
