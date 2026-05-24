import { canRunSafe } from '../tools/terminal/safe-policy.ts';

function matchesDangerousCommand(command) {
  // Block truly dangerous commands: rm, reboot, sudo, etc.
  if (/\b(rm|rmdir|reboot|shutdown|launchctl|mkfs|diskutil|dd|sudo|chmod|chown)\b/i.test(command)) return true;
  // Block pipe to destructive commands
  if (/\|\s*(rm|sudo|dd|mkfs|bash|sh|zsh|python|perl|ruby|node)\b/i.test(command)) return true;
  // Block output redirection to system paths
  if (/>\s*\/(etc|usr|boot|system)/i.test(command)) return true;
  // Block process substitution
  if (/[<>]\(/.test(command)) return true;
  return false;
}

const SAFE_IDE_TOOLS = new Set([
  'get_run_configurations',
  'get_file_problems',
  'get_project_dependencies',
  'get_project_modules',
  'find_files_by_glob',
  'find_files_by_name_keyword',
  'get_all_open_file_paths',
  'list_directory_tree',
  'get_file_text_by_path',
  'search_in_files_by_regex',
  'search_in_files_by_text',
  'get_symbol_info',
  'get_repositories',
  'list_database_connections',
  'test_database_connection',
  'list_database_schemas',
  'list_schema_object_kinds',
  'list_schema_objects',
  'list_recent_sql_queries',
  'preview_table_data',
  'open_file_in_editor',
]);

const CONFIRM_IDE_TOOLS = new Set([
  'execute_run_configuration',
  'create_new_file',
  'reformat_file',
  'replace_text_in_file',
  'rename_refactoring',
  'execute_terminal_command',
  'cancel_sql_query',
  'execute_sql_query',
]);

const SAFE_CHROME_TOOLS = new Set([
  // 只读：快照、截图、网络/console 查询、性能采集
  'take_snapshot',
  'take_screenshot',
  'list_pages',
  'get_console_message',
  'list_console_messages',
  'list_network_requests',
  'get_network_request',
  'wait_for',
  'lighthouse_audit',
  'performance_start_trace',
  'performance_stop_trace',
  'performance_analyze_insight',
  'take_memory_snapshot',
  // 浏览器内交互：打开页面、点击、输入、滚动等没有持久副作用的操作；
  // 不放任意 JS 执行 (evaluate_script) 或文件上传 (upload_file)，这些保留审批。
  'navigate_page',
  'new_page',
  'close_page',
  'select_page',
  'click',
  'hover',
  'drag',
  'fill',
  'fill_form',
  'type_text',
  'press_key',
  'handle_dialog',
  'resize_page',
  'emulate',
]);

export function classifyAgentAction(action) {
  const tool = action?.tool || '';
  const type = action?.type || '';

  if (tool === 'core' && type === 'ask_user') {
    return {
      level: 'confirm',
      reason: `Agent 提问: ${action.question || ''}`,
    };
  }

  if (tool === 'core' && type === 'notify_user') {
    return {
      level: 'safe',
      reason: '通知消息直接发送',
    };
  }

  if (tool === 'core' || type === 'finish') {
    return {
      level: 'safe',
      reason: 'finish 不需要额外确认',
    };
  }

  if (tool === 'browser') {
    return {
      level: 'safe',
      reason: '浏览器内动作默认直接执行',
    };
  }

  if (tool === 'fs' && ['list_dir', 'read_file', 'search_files'].includes(type)) {
    return {
      level: 'safe',
      reason: '只读文件系统操作',
    };
  }

  if (tool === 'fetch' && ['http_fetch', 'parallel_fetch'].includes(type)) {
    return {
      level: 'safe',
      reason: '只读网页抓取',
    };
  }

  if (tool === 'fs' && type === 'write_file') {
    return {
      level: 'confirm',
      reason: `即将${action.append ? '追加写入' : '写入'}文件 ${action.path}`,
    };
  }

  if (tool === 'terminal' && type === 'run_safe') {
    if (canRunSafe(action.command || '')) {
      return {
        level: 'safe',
        reason: '只读终端命令',
      };
    }
    // 命令本身在 run_safe 白名单之外（或含危险操作符），不直接报错让 LLM 多跑一轮，
    // 改写为 run_confirmed 走审批流程 —— 危险命令检查仍在下方 run_confirmed 分支生效。
    if (matchesDangerousCommand(action.command || '')) {
      return {
        level: 'blocked',
        reason: `命令被策略阻止: ${action.command}`,
      };
    }
    action.type = 'run_confirmed';
    return {
      level: 'confirm',
      reason: `即将执行终端命令: ${action.command}`,
    };
  }

  if (tool === 'terminal' && type === 'run_confirmed') {
    if (matchesDangerousCommand(action.command || '')) {
      return {
        level: 'blocked',
        reason: `命令被策略阻止: ${action.command}`,
      };
    }

    return {
      level: 'confirm',
      reason: `即将执行终端命令: ${action.command}`,
    };
  }

  if (tool === 'terminal' && type === 'run_review') {
    return {
      level: 'confirm',
      reason: `即将执行需审批的终端命令: ${action.command}`,
    };
  }

  if (tool === 'macos' && ['open_app', 'activate_app', 'list_windows', 'capture_screen'].includes(type)) {
    return {
      level: 'safe',
      reason: '桌面观察/切换动作默认直接执行',
    };
  }

  if (tool === 'macos' && ['type_text', 'press_key', 'click_at'].includes(type)) {
    return {
      level: 'confirm',
      reason: `即将执行桌面输入动作: ${type}`,
    };
  }

  if (tool === 'ide' && type === 'ide_list_tools') {
    return {
      level: 'safe',
      reason: '只读取 IDE MCP 工具元数据',
    };
  }

  if (tool === 'ide' && type === 'ide_call_tool') {
    const toolName = String(action.toolName || '').trim();
    if (SAFE_IDE_TOOLS.has(toolName)) {
      return {
        level: 'safe',
        reason: `只读 IDE 工具: ${toolName}`,
      };
    }
    if (CONFIRM_IDE_TOOLS.has(toolName)) {
      return {
        level: 'confirm',
        reason: `即将执行 IDE 工具: ${toolName}`,
      };
    }
    return {
      level: 'confirm',
      reason: `即将执行未知风险级别的 IDE 工具: ${toolName || '未命名工具'}`,
    };
  }

  if (tool === 'chrome' && type === 'chrome_list_tools') {
    return {
      level: 'safe',
      reason: '只读取 Chrome MCP 工具元数据',
    };
  }

  if (tool === 'chrome' && type === 'chrome_call_tool') {
    const toolName = String(action.toolName || '').trim();
    if (SAFE_CHROME_TOOLS.has(toolName)) {
      return {
        level: 'safe',
        reason: `只读 Chrome 工具: ${toolName}`,
      };
    }
    return {
      level: 'confirm',
      reason: `即将执行 Chrome 工具: ${toolName || '未命名工具'}`,
    };
  }

  return {
    level: 'blocked',
    reason: `策略未允许该动作: ${tool}.${type}`,
  };
}
