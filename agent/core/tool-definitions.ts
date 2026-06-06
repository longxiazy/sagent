/**
 * Tool Definitions — Agent 可用的所有工具 schema 定义
 *
 * 定义了 DesktopAgent 能调用的全部工具（浏览器、文件系统、终端、macOS 桌面、HTTP 抓取、核心动作）。
 * 同时提供 Claude SDK 格式转换。
 *
 * 调用场景：
 *   - ai-client.js 的 claudeAgentPlan() 将工具列表传给 Claude API
 *   - agent/chat/chat-tools.js 从中过滤出 Chat 模式的安全子集
 */

import { isIdeMcpEnabled } from '../tools/ide/mcp-client.ts';
import { isChromeMcpEnabled } from '../tools/chrome/mcp-client.ts';

export function createModelTools() {
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
      name: 'parallel_fetch',
      description: '用浏览器依次打开多个 URL 并提取内容。适合需要获取多个页面信息的场景。',
      input_schema: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            items: { type: 'string' },
            description: '要抓取的 URL 列表（最多 5 个）',
          },
          extractLinks: { type: 'boolean', description: '是否提取页面链接列表' },
        },
        required: ['urls'],
      },
    },
    {
      name: 'web_search',
      description: '用 DuckDuckGo 搜索网络（无需 API key），返回标题/URL/摘要列表。优先用它定位资料，再用 http_fetch 抓取具体页面。比直接打开 Google/Bing 更稳，不会触发反爬。',
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
      description: '让多模态模型分析一张图片并回答问题。用于解读浏览器/桌面截图、查看报错图、识别图表或界面布局。image 可以是本地文件路径或 http(s) URL，question 用简体中文描述需要从图里得到的信息。',
      input_schema: {
        type: 'object',
        properties: {
          image: { type: 'string', description: '图片来源：本地文件绝对路径（如 /tmp/xxx.png）或 http(s) URL' },
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
      name: 'open_app',
      description: '打开 macOS 应用',
      input_schema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: '应用名称（如 "Google Chrome"）' },
        },
        required: ['app'],
      },
    },
    {
      name: 'activate_app',
      description: '激活（切换到）macOS 应用',
      input_schema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: '应用名称' },
        },
        required: ['app'],
      },
    },
    {
      name: 'list_windows',
      description: '列出所有窗口',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'capture_screen',
      description: '截取屏幕截图',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'type_text',
      description: '在桌面输入文字',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要输入的文字' },
        },
        required: ['text'],
      },
    },
    {
      name: 'press_key',
      description: '按下键盘按键',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '按键名称（如 enter, escape）' },
          modifiers: { type: 'array', items: { type: 'string' }, description: '修饰键（command, shift, control, option）' },
        },
        required: ['key'],
      },
    },
    {
      name: 'click_at',
      description: '点击桌面坐标',
      input_schema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X 坐标' },
          y: { type: 'number', description: 'Y 坐标' },
        },
        required: ['x', 'y'],
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
      name: 'spawn',
      description: '并行分发多个独立子任务给子 Agent 执行。适合同时分析多个文件、爬取多个页面、批量处理等独立任务。最多支持 5 个并行子任务，每个子任务返回独立结果后聚合。',
      input_schema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: { type: 'string' },
            description: '子任务列表，每个元素是一个独立的任务描述（简体中文）',
            minItems: 1,
            maxItems: 5,
          },
        },
        required: ['tasks'],
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

  if (isIdeMcpEnabled()) {
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

  if (isChromeMcpEnabled()) {
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

  return tools;
}

export function toolToClaudeTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  };
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
