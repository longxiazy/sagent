/**
 * Skills System — 可扩展的 Agent 技能插件
 *
 * 灵感来源: Claude Code Skills 生态系统 (anthropics/skills 项目激增 1.2k stars)
 * "技能即插件" — Agent 可以动态加载新技能，无需修改核心代码
 *
 * 使用方式:
 * 1. 在 agent/tools/skills/ 目录下创建 skill 文件
 * 2. 注册到 SKILLS_REGISTRY
 * 3. Agent 可以通过 skill:<name> 调用
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../../helpers/logger.js';

export const SKILLS_REGISTRY = {
  // 内置技能
  github: {
    name: 'GitHub',
    description: 'GitHub 操作：创建 issue/PR、查看状态、管理仓库',
    tools: ['gh', 'api'],
    version: '1.0.0',
  },
  file_analyzer: {
    name: '文件分析器',
    description: '分析代码文件结构、统计行数、检测语言',
    tools: ['analyze_structure', 'count_lines', 'detect_language'],
    version: '1.0.0',
  },
  web_search: {
    name: '网页搜索',
    description: '搜索引擎查询，支持 Google/DuckDuckGo',
    tools: ['search', 'google_search'],
    version: '1.0.0',
  },
  image_processor: {
    name: '图片处理',
    description: '图片压缩、格式转换、缩略图生成',
    tools: ['compress_image', 'resize_image', 'convert_format'],
    version: '1.0.0',
  },
};

export async function listSkills() {
  return Object.entries(SKILLS_REGISTRY).map(([id, s]) => ({
    id,
    name: s.name,
    description: s.description,
    tools: s.tools,
    version: s.version,
  }));
}

export async function getSkill(skillId) {
  return SKILLS_REGISTRY[skillId] || null;
}

export async function loadSkillTools(skillId) {
  const skill = SKILLS_REGISTRY[skillId];
  if (!skill) return null;

  log.info(`[Skills] Loading skill: ${skillId}`);
  return skill;
}

export async function discoverSkills(dir = './agent/tools/skills') {
  try {
    const files = await readdir(dir);
    const skillDirs = files.filter(f => !f.startsWith('.') && !f.startsWith('_'));
    log.info(`[Skills] Discovered ${skillDirs.length} skill directories`);
    return skillDirs;
  } catch {
    return [];
  }
}