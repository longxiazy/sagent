/**
 * run_safe 安全策略。
 *
 * run_safe 只允许执行一个无 shell 的只读进程。这里同时负责命令行分词和参数校验；
 * 未通过的命令会在 policy 层升级为 run_confirmed，由用户审批后才进入 zsh。
 */

export interface ParsedSafeCommand {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

const SIMPLE_READ_ONLY_COMMANDS = new Set([
  'pwd',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'which',
  'grep',
  'cut',
  'tr',
  'tree',
  'du',
  'df',
  'jq',
  'id',
  'whoami',
  'hostname',
  'uname',
  'ps',
  'pgrep',
  'pidof',
  'lsof',
  'netstat',
  'ss',
  'vm_stat',
  'system_profiler',
]);

export const SAFE_COMMANDS = new Set([
  ...SIMPLE_READ_ONLY_COMMANDS,
  'date',
  'diff',
  'rg',
  'git',
]);

const SHELL_META = new Set(['|', ';', '&', '>', '<', '`']);
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'grep',
]);

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;
  let tokenStarted = false;

  const push = () => {
    if (tokenStarted) tokens.push(current);
    current = '';
    tokenStarted = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaping = true;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = null;
      else {
        current += char;
        tokenStarted = true;
      }
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      else if (char === '$' || char === '`') throw new Error('run_safe 不允许 shell 展开');
      else {
        current += char;
        tokenStarted = true;
      }
      continue;
    }
    if (char === "'") {
      quote = 'single';
      tokenStarted = true;
      continue;
    }
    if (char === '"') {
      quote = 'double';
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (SHELL_META.has(char) || char === '$') {
      throw new Error(`run_safe 不允许 shell 操作符: ${char}`);
    }
    current += char;
    tokenStarted = true;
  }

  if (escaping || quote) throw new Error('run_safe 命令引号或转义不完整');
  push();
  return tokens;
}

function hasOption(args: string[], ...options: string[]) {
  return args.some(arg => options.some(option => arg === option || arg.startsWith(`${option}=`)));
}

function validateDate(args: string[]) {
  // macOS date 的数字位置参数（包括 HHMM 这种短格式）会修改系统时间。
  // -j 明确禁止设置时间；没有 -j 时只允许纯查询/格式化参数。
  if (args.includes('-j')) {
    return !args.some(arg => arg === '--set' || arg.startsWith('--set='));
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('+') || arg === '-u' || arg === '-R' || arg === '-I' || arg.startsWith('-I')) {
      continue;
    }
    if (arg === '-r' || arg === '-v') {
      index += 1;
      if (index >= args.length) return false;
      continue;
    }
    return false;
  }
  return true;
}

function validateDiff(args: string[]) {
  return !hasOption(args, '--output', '-o');
}

function validateRipgrep(args: string[]) {
  return !hasOption(args, '--pre', '--pre-glob', '--hostname-bin');
}

function validateGit(args: string[]) {
  if (args.length === 0) return false;
  // 禁止 git -c / --config-env 在只读命令中注入外部 diff、pager 或过滤器。
  if (args[0].startsWith('-') || hasOption(args, '-c', '--config-env', '--exec-path')) return false;
  const subcommand = args[0];
  if (!GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return false;
  // -O / -O<pager> 是 --open-files-in-pager 的短选项，git 会用 /bin/sh 执行该 pager，
  // 构成任意命令执行；hasOption 无法匹配 -O<pager> 粘连形式，需单独拒绝任何 -O 开头参数。
  if (args.some(arg => arg === '-O' || arg.startsWith('-O'))) return false;
  if (hasOption(
    args,
    '--output',
    '-o',
    '--ext-diff',
    '--textconv',
    '--exec',
    '--paginate',
    '--open-files-in-pager',
    '--git-dir',
    '--work-tree',
  )) return false;
  return true;
}

function validateSimpleCommand(file: string, args: string[]) {
  // tree -o/--output 写文件，其余简单命令只保留只读参数面。
  if (file === 'tree' && args.some(arg => arg === '--output' || arg.startsWith('--output=') || arg.startsWith('-o'))) return false;
  // macOS/BSD hostname 的位置参数会直接修改系统 hostname。
  if (file === 'hostname' && !args.every(arg => ['-f', '-s', '-d'].includes(arg))) return false;
  return true;
}

function validateArgs(file: string, args: string[]) {
  if (args.some(arg => arg.includes('\0') || arg.includes('\n') || arg.includes('\r'))) return false;
  if (SIMPLE_READ_ONLY_COMMANDS.has(file)) return validateSimpleCommand(file, args);
  if (file === 'date') return validateDate(args);
  if (file === 'diff') return validateDiff(args);
  if (file === 'rg') return validateRipgrep(args);
  if (file === 'git') return validateGit(args);
  return false;
}

export function parseSafeCommand(command: string): ParsedSafeCommand {
  const tokens = tokenize(String(command || '').trim());
  if (tokens.length === 0) throw new Error('run_safe 命令为空');
  const [file, ...args] = tokens;
  if (file.includes('/') || !SAFE_COMMANDS.has(file)) {
    throw new Error(`run_safe 不允许执行该命令: ${file}`);
  }
  if (!validateArgs(file, args)) {
    throw new Error(`run_safe 不允许该命令参数: ${command}`);
  }
  if (file !== 'git') return { file, args };

  const [subcommand, ...subcommandArgs] = args;
  const hardenedArgs = [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.pager=cat',
    '-c', `pager.${subcommand}=false`,
    subcommand,
  ];
  if (['diff', 'log', 'show'].includes(subcommand)) {
    hardenedArgs.push('--no-ext-diff', '--no-textconv');
  }
  hardenedArgs.push(...subcommandArgs);

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'GIT_CONFIG_PARAMETERS' || key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) {
      delete env[key];
    }
  }
  delete env.GIT_CONFIG_COUNT;

  return {
    file,
    args: hardenedArgs,
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_EXTERNAL_DIFF: '',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
    },
  };
}

export function getFirstToken(command: string) {
  try {
    return tokenize(String(command || '').trim())[0] || '';
  } catch {
    return '';
  }
}

export function canRunSafe(command: string) {
  try {
    parseSafeCommand(command);
    return true;
  } catch {
    return false;
  }
}
