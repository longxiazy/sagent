/**
 * Permission Profiles — 基于 Profile 的权限分级系统
 *
 * 灵感来源: OpenAI Codex PermissionProfile 权限模型
 * - trusted: 完全信任，仅 confirm 文件写入和终端确认
 * - development: 开发模式，允许大部分操作
 * - restricted: 受限模式，所有写操作需确认
 * - sandboxed: 沙箱模式，仅读操作 + 白名单命令
 */

export const PERMISSION_PROFILES = {
  trusted: {
    label: '完全信任',
    description: '仅在写入文件或执行终端命令时请求确认',
    fs: ['read_file', 'list_dir', 'search_files', 'write_file'],
    terminal: ['run_safe', 'run_confirmed', 'run_review'],
    terminal_whitelist: [], // 无限制
    browser: ['all'],
    macos: ['all'],
    spawn: true,
  },
  development: {
    label: '开发模式',
    description: '允许大部分操作，危险命令需确认',
    fs: ['read_file', 'list_dir', 'search_files', 'write_file'],
    terminal: ['run_safe', 'run_confirmed', 'run_review'],
    terminal_whitelist: ['node', 'python', 'git', 'npm', 'pnpm', 'cargo', 'make'],
    browser: ['all'],
    macos: ['all'],
    spawn: true,
  },
  restricted: {
    label: '受限模式',
    description: '所有写操作均需确认，终端仅读命令',
    fs: ['read_file', 'list_dir', 'search_files'],
    terminal: ['run_safe'],
    terminal_whitelist: ['ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'find', 'git'],
    browser: ['all'],
    macos: ['all'],
    spawn: false,
  },
  sandboxed: {
    label: '沙箱模式',
    description: '仅读操作，白名单命令，无 spawn',
    fs: ['read_file', 'list_dir'],
    terminal: ['run_safe'],
    terminal_whitelist: ['ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'find'],
    browser: ['navigate', 'get_page_content', 'screenshot'],
    macos: ['list_windows', 'capture_screen'],
    spawn: false,
  },
};

export function getProfile(name) {
  return PERMISSION_PROFILES[name] || PERMISSION_PROFILES.trusted;
}