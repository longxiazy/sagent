import { mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', 'data', 'logs');
const LOG_FILE = join(LOG_DIR, `app-${new Date().toISOString().slice(0, 10)}.log`);

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

const NO_COLOR = process.env.NO_COLOR;

const C = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m',  // green
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m', // red
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

function fmt(level, args) {
  const ts = new Date().toISOString().slice(11, 19);
  if (NO_COLOR) return [`[${ts} ${level.toUpperCase()}]`, ...args];
  return [`${C[level]}${C.bold}[${ts} ${level.toUpperCase()}]${C.reset}`, ...args];
}

function writeToFile(level, args) {
  const ts = new Date().toISOString();
  const line = args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  try { appendFileSync(LOG_FILE, `[${ts} ${level.toUpperCase()}] ${line}\n`); } catch {}
}

export const log = {
  debug: (...args) => currentLevel <= LEVELS.debug && (console.log(...fmt('debug', args)), writeToFile('debug', args)),
  info: (...args) => currentLevel <= LEVELS.info && (console.log(...fmt('info', args)), writeToFile('info', args)),
  warn: (...args) => currentLevel <= LEVELS.warn && (console.warn(...fmt('warn', args)), writeToFile('warn', args)),
  error: (...args) => currentLevel <= LEVELS.error && (console.error(...fmt('error', args)), writeToFile('error', args)),
};
