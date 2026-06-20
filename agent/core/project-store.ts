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

function projectsFilePath(memoryRoot: string) {
  return path.join(memoryRoot, PROJECTS_FILE);
}

/** 某项目的数据目录: {MEMORY_DIR}/projects/<projectId> */
export function projectDataDir(memoryRoot: string, projectId: string) {
  return path.join(memoryRoot, 'projects', projectId);
}

function generateProjectId() {
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function emptyRegistry() {
  return { version: 1, activeProjectId: null as string | null, projects: [] as any[] };
}

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

async function writeRegistry(memoryRoot: string, registry: any) {
  const filePath = projectsFilePath(memoryRoot);
  const tmp = filePath + '.tmp';
  await fs.mkdir(memoryRoot, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(registry, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

function normalizeProjectInput({ name, rootPath }: { name?: string; rootPath?: string }) {
  const trimmedName = String(name || '').trim();
  const trimmedRoot = String(rootPath || '').trim();
  if (!trimmedName) throw new Error('项目名称不能为空');
  if (!trimmedRoot) throw new Error('项目根路径不能为空');
  if (!path.isAbsolute(trimmedRoot)) throw new Error('项目根路径必须是绝对路径');
  return { name: trimmedName, rootPath: path.normalize(trimmedRoot) };
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

    list() {
      return { activeProjectId: registry.activeProjectId, projects: registry.projects };
    },

    get(projectId: string): Project | null {
      return registry.projects.find((p: Project) => p.projectId === projectId) || null;
    },

    getActive(): Project | null {
      if (!registry.activeProjectId) return null;
      return store.get(registry.activeProjectId);
    },

    /** 传 id 用 id;否则用 active;都没有返回 null(调用方回退到全局) */
    resolve(projectId?: string | null): Project | null {
      if (projectId) return store.get(projectId);
      return store.getActive();
    },

    dataDir(projectId: string) {
      return projectDataDir(memoryRoot, projectId);
    },

    async create({ name, rootPath }: { name?: string; rootPath?: string }) {
      const normalized = normalizeProjectInput({ name, rootPath });
      const now = new Date().toISOString();
      const project: Project = { projectId: generateProjectId(), ...normalized, createdAt: now, updatedAt: now };
      registry.projects.push(project);
      // 第一个项目自动设为 active,避免建完还要再点一次激活
      if (!registry.activeProjectId) registry.activeProjectId = project.projectId;
      await writeRegistry(memoryRoot, registry);
      await fs.mkdir(projectDataDir(memoryRoot, project.projectId), { recursive: true }).catch(() => {});
      return project;
    },

    async update(projectId: string, patch: { name?: string; rootPath?: string }) {
      const project = store.get(projectId);
      if (!project) throw new Error('项目不存在');
      if (patch.name !== undefined || patch.rootPath !== undefined) {
        const normalized = normalizeProjectInput({
          name: patch.name ?? project.name,
          rootPath: patch.rootPath ?? project.rootPath,
        });
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
      if (projectId !== null && !store.get(projectId)) throw new Error('项目不存在');
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
 * - 未指定 projectId(null/空)或项目已删除: 回退全局 MEMORY_DIR 与 process.cwd()
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
  return { projectId: null, projectRoot: process.cwd(), dataDir: globalMemoryDir };
}
