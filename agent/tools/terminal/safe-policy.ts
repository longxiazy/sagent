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
