function matchesDangerousCommand(command) {
  // Block truly dangerous commands: rm, reboot, sudo, etc.
  if (/\b(rm|rmdir|reboot|shutdown|launchctl|mkfs|diskutil|dd|sudo|chmod|chown)\b/i.test(command)) return true;
  // Block pipe to destructive commands
  if (/\|\s*(rm|sudo|dd|mkfs|bash|sh|zsh|python|perl|ruby|node)\b/i.test(command)) return true;
  // Block output redirection to system paths
  if (/>\s*\/(etc|usr|boot|system)/i.test(command)) return true;
  // Block command chaining with ; (sneaky injection)
  if (/;/.test(command)) return true;
  // Block process substitution
  if (/[<>]\(/.test(command)) return true;
  return false;
}

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
    return {
      level: 'safe',
      reason: '只读终端命令',
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

  return {
    level: 'blocked',
    reason: `策略未允许该动作: ${tool}.${type}`,
  };
}
