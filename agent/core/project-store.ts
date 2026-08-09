/**
 * Project Store — 一等的「项目」概念 / First-class Project model
 *
 * 让 Agent 平台支持多项目隔离:每个项目有独立的根路径(文件工具沙箱)、
 * 独立的记忆 / trace / checkpoint / uploads 落盘目录。
 *
 * 存储 / Storage:
 *   注册表: {MEMORY_DIR}/projects.json
 *     { version, activeProjectId, projects: [{ projectId, name, rootPath, createdAt, updatedAt }] }
 *   每个项目数据目录: {MEMORY_DIR}/projects/<projectId>/
 *     下挂 agent-memory.json / traces/ / checkpoints/ / uploads/ 等
 *
 * 向后兼容 / Backward compatibility:
 *   「没有 project」仍然是合法状态。注册表为空时 activeProjectId=null,
 *   此时 resolveRunPaths() 回退到全局 MEMORY_DIR 和 process.cwd(),
 *   行为与引入项目概念之前完全一致。不强制创建默认项目、不迁移旧数据。
 *
 * 调用场景 / Callers:
 *   - server.ts 启动时: createProjectStore(MEMORY_DIR) + init()
 *   - routes/agent-projects.ts: CRUD + 激活
 *   - routes/agent-run-start.ts 等: resolveRunPaths() 解析本次 run 的落盘目录
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const PROJECTS_FILE = 'projects.json';

/**
 * 「无项目」run 数据的固定存储桶 id。让全局态的 traces/session-checkpoints/
 * uploads/agent-memory.json 等落在 {MEMORY_DIR}/projects/default,与真实项目
 * {MEMORY_DIR}/projects/<id> 同级,而非直接堆在 MEMORY_DIR 根。
 *
 * 注意:default 只是存储桶,不是一个项目——projects.json 注册表不含 default 条目,
 * activeProjectId=null 语义不变。generateProjectId 只产 proj_* 前缀,永不与之冲突。
 */
export const GLOBAL_SCOPE_ID = 'default';

function projectsFilePath(memoryRoot: string) {
  return path.join(memoryRoot, PROJECTS_FILE);
}

/** 某项目的数据目录: {MEMORY_DIR}/projects/<projectId> */
export function projectDataDir(memoryRoot: string, projectId: string) {
  return path.join(memoryRoot, 'projects', projectId);
}

/** 生成唯一项目 id：proj_ 前缀 + 时间戳(36 进制) + 随机后缀 */
function generateProjectId() {
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 空注册表结构（无项目合法状态）。 */
function emptyRegistry() {
  return { version: 1, activeProjectId: null as string | null, projects: [] as any[] };
}

/** 读取注册表；缺失/损坏时回退空注册表。 */
async function readRegistry(memoryRoot: string) {
  try {
    const raw = await fs.readFile(projectsFilePath(memoryRoot), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      activeProjectId: parsed.activeProjectId ?? null,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    };
  } catch {
    return emptyRegistry();
  }
}

/** 原子写入注册表（先写 .tmp 再 rename）。 */
async function writeRegistry(memoryRoot: string, registry: any) {
  const filePath = projectsFilePath(memoryRoot);
  const tmp = filePath + '.tmp';
  await fs.mkdir(memoryRoot, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(registry, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

/** 校验项目名/根路径非空且根路径为绝对路径，返回归一化结果。 */
function normalizeProjectInput({ name, rootPath }: { name?: string; rootPath?: string }) {
  const trimmedName = String(name || '').trim();
  const trimmedRoot = String(rootPath || '').trim();
  if (!trimmedName) throw new Error('项目名称不能为空');
  if (!trimmedRoot) throw new Error('项目根路径不能为空');
  if (!path.isAbsolute(trimmedRoot)) throw new Error('项目根路径必须是绝对路径');
  return { name: trimmedName, rootPath: path.normalize(trimmedRoot) };
}

export class ProjectPathError extends Error {
  status = 400;
  code = 'PROJECT_ROOT_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'ProjectPathError';
  }
}

/** 校验项目根存在、可访问且确实为目录，并返回消除 symlink/.. 后的 canonical 路径。 */
export async function validateProjectRoot(rootPath: string): Promise<string> {
  const normalized = path.normalize(rootPath);
  let stats;
  try {
    stats = await fs.stat(normalized);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new ProjectPathError(`项目根目录不存在或已移动: ${normalized}`);
    }
    throw new ProjectPathError(`项目根目录无法访问: ${normalized} (${err?.message || err})`);
  }
  if (!stats.isDirectory()) {
    throw new ProjectPathError(`项目根路径不是目录: ${normalized}`);
  }
  try {
    return await fs.realpath(normalized);
  } catch (err: any) {
    throw new ProjectPathError(`项目根目录无法解析: ${normalized} (${err?.message || err})`);
  }
}

export interface Project {
  projectId: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export function createProjectStore(memoryRoot: string) {
  let registry = emptyRegistry();

  const store = {
    /** 启动时读取注册表;修正悬空的 activeProjectId */
    async init() {
      registry = await readRegistry(memoryRoot);
      if (registry.activeProjectId && !registry.projects.some((p: Project) => p.projectId === registry.activeProjectId)) {
        registry.activeProjectId = registry.projects[0]?.projectId ?? null;
      }
      return registry;
    },

    /** 全部项目与当前激活 id（routes/agent-projects.ts 展示用）。 */
    list() {
      return { activeProjectId: registry.activeProjectId, projects: registry.projects };
    },

    /** 按 id 查项目，不存在返回 null。 */
    get(projectId: string): Project | null {
      return registry.projects.find((p: Project) => p.projectId === projectId) || null;
    },

    /** 当前激活项目，无则 null。 */
    getActive(): Project | null {
      if (!registry.activeProjectId) return null;
      return store.get(registry.activeProjectId);
    },

    /** 传 id 用 id;否则用 active;都没有返回 null(调用方回退到全局) */
    resolve(projectId?: string | null): Project | null {
      if (projectId) return store.get(projectId);
      return store.getActive();
    },

    /** 项目数据目录（含 default 全局桶）。 */
    dataDir(projectId: string) {
      return projectDataDir(memoryRoot, projectId);
    },

    /** 新建项目：校验根路径、首个自动激活、初始化数据目录。 */
    async create({ name, rootPath }: { name?: string; rootPath?: string }) {
      const normalized = normalizeProjectInput({ name, rootPath });
      normalized.rootPath = await validateProjectRoot(normalized.rootPath);
      const now = new Date().toISOString();
      const project: Project = { projectId: generateProjectId(), ...normalized, createdAt: now, updatedAt: now };
      registry.projects.push(project);
      // 第一个项目自动设为 active,避免建完还要再点一次激活
      if (!registry.activeProjectId) registry.activeProjectId = project.projectId;
      await writeRegistry(memoryRoot, registry);
      await fs.mkdir(projectDataDir(memoryRoot, project.projectId), { recursive: true }).catch(() => {});
      return project;
    },

    /** 改项目名/根路径（重新校验根目录），落盘后返回更新后的项目。 */
    async update(projectId: string, patch: { name?: string; rootPath?: string }) {
      const project = store.get(projectId);
      if (!project) throw new Error('项目不存在');
      if (patch.name !== undefined || patch.rootPath !== undefined) {
        const normalized = normalizeProjectInput({
          name: patch.name ?? project.name,
          rootPath: patch.rootPath ?? project.rootPath,
        });
        normalized.rootPath = await validateProjectRoot(normalized.rootPath);
        project.name = normalized.name;
        project.rootPath = normalized.rootPath;
      }
      project.updatedAt = new Date().toISOString();
      await writeRegistry(memoryRoot, registry);
      return project;
    },

    /** 删除项目(只从注册表移除,保留磁盘数据目录以防误删) */
    async remove(projectId: string) {
      const idx = registry.projects.findIndex((p: Project) => p.projectId === projectId);
      if (idx === -1) throw new Error('项目不存在');
      registry.projects.splice(idx, 1);
      if (registry.activeProjectId === projectId) {
        registry.activeProjectId = registry.projects[0]?.projectId ?? null;
      }
      await writeRegistry(memoryRoot, registry);
      return { ok: true, activeProjectId: registry.activeProjectId };
    },

    /** 设置当前项目;传 null 回到「无项目」全局态 */
    async setActive(projectId: string | null) {
      const project = projectId === null ? null : store.get(projectId);
      if (projectId !== null && !project) throw new Error('项目不存在');
      if (project) await validateProjectRoot(project.rootPath);
      registry.activeProjectId = projectId;
      await writeRegistry(memoryRoot, registry);
      return registry.activeProjectId;
    },
  };

  return store;
}

export type ProjectStore = ReturnType<typeof createProjectStore>;

/**
 * 解析一次 run / 读取的落盘目录与项目根。
 * - 传入有效 projectId 且项目存在: 用 {MEMORY_DIR}/projects/<id> 与 project.rootPath
 * - 未指定 projectId(null/空)或项目已删除: 回退全局桶 {MEMORY_DIR}/projects/default 与 process.cwd()
 *
 * 注意: 这里**不**用 getActive() 兜底——「未指定」语义上等于全局，而非「当前激活项目」。
 * 否则旧的 null 会话读取 trace/memory 时会被错误地路由到激活项目目录(404/读错)。
 * 哪个项目由调用方显式传入(前端按会话的 projectId 传)。
 */
export function resolveRunPaths(
  projectStore: ProjectStore,
  projectId: string | null | undefined,
  globalMemoryDir: string,
): { projectId: string | null; projectRoot: string; dataDir: string } {
  const project = projectId ? projectStore.get(projectId) : null;
  if (project) {
    return {
      projectId: project.projectId,
      projectRoot: project.rootPath,
      dataDir: projectDataDir(globalMemoryDir, project.projectId),
    };
  }
  return { projectId: null, projectRoot: process.cwd(), dataDir: projectDataDir(globalMemoryDir, GLOBAL_SCOPE_ID) };
}

/**
 * 执行 Agent 前使用的严格路径解析：显式项目不存在或根目录失效时直接报错，
 * 避免静默回退到全局 cwd，或让 child_process 报误导性的 posix_spawn ENOENT。
 */
export async function resolveRunPathsForExecution(
  projectStore: ProjectStore,
  projectId: string | null | undefined,
  globalMemoryDir: string,
): Promise<{ projectId: string | null; projectRoot: string; dataDir: string }> {
  if (!projectId) {
    return { projectId: null, projectRoot: process.cwd(), dataDir: projectDataDir(globalMemoryDir, GLOBAL_SCOPE_ID) };
  }
  const project = projectStore.get(projectId);
  if (!project) {
    throw new ProjectPathError(`项目不存在或已删除: ${projectId}`);
  }
  const projectRoot = await validateProjectRoot(project.rootPath);
  return {
    projectId: project.projectId,
    projectRoot,
    dataDir: projectDataDir(globalMemoryDir, project.projectId),
  };
}
