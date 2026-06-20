import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/http.js';

// 项目（Project）状态 hook：拉取后端注册表，提供增删改 + 激活。
// activeProjectId = null 表示「无项目」全局态（向后兼容）。
export function useProjects() {
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectIdState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch('/api/projects');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProjects(Array.isArray(data.projects) ? data.projects : []);
      setActiveProjectIdState(data.activeProjectId ?? null);
      setError(null);
    } catch (err) {
      setError(err.message || String(err));
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const createProject = useCallback(async ({ name, rootPath }) => {
    const res = await apiFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rootPath }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await refresh();
    return data.project;
  }, [refresh]);

  const updateProject = useCallback(async (id, patch) => {
    const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await refresh();
    return data.project;
  }, [refresh]);

  const deleteProject = useCallback(async (id) => {
    const res = await apiFetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await refresh();
    return data;
  }, [refresh]);

  // 激活项目；传 null 回到「无项目」态。先乐观更新本地，再打后端。
  const activateProject = useCallback(async (id) => {
    setActiveProjectIdState(id ?? null);
    const seg = id == null ? 'none' : encodeURIComponent(id);
    const res = await apiFetch(`/api/projects/${seg}/activate`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setActiveProjectIdState(data.activeProjectId ?? null);
    return data.activeProjectId ?? null;
  }, []);

  const activeProject = projects.find(p => p.projectId === activeProjectId) || null;

  return {
    projects,
    activeProjectId,
    activeProject,
    loading,
    error,
    refresh,
    createProject,
    updateProject,
    deleteProject,
    activateProject,
  };
}
