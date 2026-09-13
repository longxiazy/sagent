import { useCallback, useEffect, useRef, useState } from 'react';
import { listScreenshots } from '../api/screenshots.js';

function appendPage(current, page) {
  const groups = new Map(current.groups.map(group => [group.runId, group]));
  for (const group of page.groups) {
    const previous = groups.get(group.runId);
    const files = new Map((previous?.files || []).map(file => [file.name, file]));
    for (const file of group.files) files.set(file.name, file);
    groups.set(group.runId, { ...group, files: [...files.values()] });
  }
  return { ...page, groups: [...groups.values()] };
}

export function useScreenshots(onInitialLoad) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestRef = useRef(null);
  const nextOffsetRef = useRef(0);
  const initializedRef = useRef(false);

  const loadPage = useCallback(async ({ reset = false, load = listScreenshots } = {}) => {
    // Observer 与按钮可能同时触发；同一时间只允许一个分页请求。
    if (!reset && (requestRef.current || nextOffsetRef.current === null)) return null;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(false);
    if (reset) {
      nextOffsetRef.current = 0;
      setData(null);
    }
    try {
      const page = await load({ offset: nextOffsetRef.current, signal: controller.signal });
      if (controller.signal.aborted) return null;
      nextOffsetRef.current = page.nextOffset ?? null;
      setData(current => reset || !current ? page : appendPage(current, page));
      // 后续分页不能覆盖用户正在编辑的保留策略。
      if (!initializedRef.current) {
        onInitialLoad(page);
        initializedRef.current = true;
      }
      return page;
    } catch {
      if (!controller.signal.aborted) setError(true);
      return null;
    } finally {
      if (!controller.signal.aborted) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [onInitialLoad]);

  const refresh = useCallback((load = listScreenshots) => loadPage({ reset: true, load }), [loadPage]);
  const loadMore = useCallback(() => loadPage(), [loadPage]);

  useEffect(() => {
    loadPage({ reset: true });
    return () => requestRef.current?.abort();
  }, [loadPage]);

  return { data, loading, error, refresh, loadMore };
}
