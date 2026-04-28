/**
 * Git Workflow Tool — Git 工作流感知
 *
 * 灵感来源: GitHub Copilot CLI 深度绑定 Git 生态（会话命名恢复、Git 工作流集成）
 * Agent 需要知道当前 Git 状态、分支、变更，才能做出合理的修改决策
 *
 * 使用场景:
 * { tool: 'git', type: 'status' | 'branch' | 'log' | 'diff' | 'stash' }
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../../helpers/logger.js';

const execAsync = promisify(exec);

async function execGit(cmd, cwd = '.') {
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 10000 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { ok: false, stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || '', code: err.code };
  }
}

export async function executeGitAction(action) {
  const { type, path = '.', extra = '' } = action;

  if (type === 'status') {
    const r = await execGit('git status --short', path);
    if (!r.ok && r.code !== 0) return `Git status 失败: ${r.stderr || r.stdout}`;
    if (!r.stdout) return '工作区干净，无变更';
    return `[Git Status]\n${r.stdout}`;
  }

  if (type === 'branch') {
    const r = await execGit('git branch -v', path);
    if (!r.ok) return `Git branch 失败: ${r.stderr}`;
    const current = await execGit('git branch --show-current', path);
    const currentBranch = current.stdout.trim();
    const lines = r.stdout.split('\n').map(l => {
      if (l.trim().startsWith('*')) return l;
      return '  ' + l;
    }).join('\n');
    return `[Git Branch: ${currentBranch}]\n${lines}`;
  }

  if (type === 'log') {
    const n = parseInt(extra) || 10;
    const r = await execGit(`git log --oneline -${n}`, path);
    if (!r.ok) return `Git log 失败: ${r.stderr}`;
    return `[Git Log (last ${n})]\n${r.stdout || '(no commits)'}`;
  }

  if (type === 'diff') {
    const r = await execGit('git diff --stat', path);
    if (!r.ok) return `Git diff 失败: ${r.stderr}`;
    return `[Git Diff]\n${r.stdout || '无变更'}`;
  }

  if (type === 'stash') {
    const r = await execGit('git stash list', path);
    if (!r.ok) return `Git stash 失败: ${r.stderr}`;
    return `[Git Stash]\n${r.stdout || '(empty)'}`;
  }

  if (type === 'remote') {
    const r = await execGit('git remote -v', path);
    if (!r.ok) return `Git remote 失败: ${r.stderr}`;
    return `[Git Remote]\n${r.stdout || '(no remote)'}`;
  }

  throw new Error(`不支持的 git 类型: ${type}`);
}