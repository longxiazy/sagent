// run_safe 终端命令策略：只读 / 低破坏命令的白名单，以及允许在命令前剥离的环境变量前缀。
// 修改前请确认条目对应的命令在 macOS 上没有副作用、不会加载额外二进制或脚本。

export const SAFE_COMMANDS = new Set([
  // 文件查看 / 搜索（只读）
  'pwd',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'date',
  'echo',
  'rg',
  'find',
  'which',
  'git',
  'grep',
  'diff',
  'sort',
  'uniq',
  'awk',
  'sed',
  'cut',
  'tr',
  'xargs',
  'tee',
  'tree',
  'du',
  'df',
  'jq',
  // 文件操作（低破坏性）
  'mkdir',
  'touch',
  'cp',
  'mv',
  'ln',
  'tar',
  'gzip',
  'gunzip',
  'zip',
  'unzip',
  // 系统信息（只读）
  'env',
  'printenv',
  'id',
  'whoami',
  'hostname',
  'uname',
  'ps',
  'pgrep',
  'pidof',
  // 网络 / 系统观测（只读）
  'lsof',
  'netstat',
  'ss',
  'memory_pressure',
  'vm_stat',
  'system_profiler',
  'plutil',
]);

// 允许在命令前出现并被剥离的环境变量前缀。
// 这些变量都不会影响 shell 二进制查找或加载（不像 PATH / DYLD_* / LD_* / IFS / BASH_ENV / ENV / ZDOTDIR）。
export const SAFE_ENV_PREFIXES = new Set([
  'GIT_CONFIG_GLOBAL',   // 指定 .gitconfig 路径，常见 =/dev/null
  'GIT_CONFIG_NOSYSTEM', // =1 时让 git 忽略 /etc/gitconfig
  'HOME',                // 用户主目录，影响 ~ 展开
  'LANG',                // 默认 locale
  'LC_ALL',              // 强制覆盖所有 locale 类别
  'LC_CTYPE',            // 字符分类 locale
  'TZ',                  // 时区
]);

// 取命令首词，跳过 SAFE_ENV_PREFIXES 列出的环境变量前缀（如 GIT_CONFIG_GLOBAL=...）。
export function getFirstToken(command) {
  const tokens = String(command || '').trim().split(/\s+/);
  for (const token of tokens) {
    const m = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m && SAFE_ENV_PREFIXES.has(m[1])) {
      continue;
    }
    return token;
  }
  return '';
}

// 命令是否可以走 run_safe 路径（首词在白名单且没有危险 shell 操作符）。
// classify 阶段用它判断是否需要把 run_safe 升级到 run_confirmed 走审批。
export function canRunSafe(command) {
  const cmd = String(command || '');
  const firstToken = getFirstToken(cmd);
  if (!SAFE_COMMANDS.has(firstToken)) {
    return false;
  }
  // 与 run.ts 内的危险操作符黑名单保持一致
  if (
    /[|;]/.test(cmd) ||
    /`/.test(cmd) ||
    /\$\(/.test(cmd) ||
    /\$\{/.test(cmd) ||
    /[^&]&[^&]/.test(cmd) ||
    /\s&(\s|$)/.test(cmd) ||
    /&&|\|\|/.test(cmd) ||
    /[<>]\(/.test(cmd) ||
    /<<\s*\w/.test(cmd)
  ) {
    return false;
  }
  return true;
}
