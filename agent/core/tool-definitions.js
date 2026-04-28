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

export function createModelTools() {
  return [
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
      name: 'google_search',
      description: '用系统默认浏览器打开 Google 搜索指定关键词。自动打开浏览器，等待后返回提示。之后需要用 capture_screen 截图查看搜索结果，再根据截图中的信息继续操作。',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
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
      description: '快速抓取网页内容（不开浏览器，<1s）。适合静态页面、新闻、文档。JS 动态页面、需登录页面不适用，此时请切换 browser.navigate。extractLinks=true 时提取页面中的链接列表（用于搜索结果页）。',
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
      description: '并发抓取多个网页内容。同时请求多个 URL，比逐个 http_fetch 快得多。适合需要同时获取多个页面信息的场景。所有 URL 并行执行。',
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
  {
    name: 'git',
    description: '查询 Git 工作区状态、分支、日志、变更等。帮助 Agent 了解当前代码状态，避免在未提交的分支上做危险操作。',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['status', 'branch', 'log', 'diff', 'stash', 'remote'], description: 'Git 命令类型' },
        path: { type: 'string', description: '仓库路径，默认 .' },
        extra: { type: 'string', description: '额外参数，如 log 的数量' },
      },
      required: ['type'],
    },
  },
  ];
}

export function toolToClaudeTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  };
}
