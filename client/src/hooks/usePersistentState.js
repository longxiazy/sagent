import { useCallback, useState } from 'react';

const parseString = value => value;
const serializeString = value => String(value);

const resolveInitialValue = initialValue =>
  typeof initialValue === 'function' ? initialValue() : initialValue;

export const jsonStorage = {
  parse: JSON.parse,
  serialize: JSON.stringify,
};

export const booleanStorage = {
  parse: value => value !== 'false',
  serialize: String,
};

export function usePersistentState(
  key,
  initialValue,
  {
    parse = parseString,
    serialize = serializeString,
  } = {}
) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored == null) {
        return resolveInitialValue(initialValue);
      }
      return parse(stored);
    } catch {
      return resolveInitialValue(initialValue);
    }
  });

  const setPersistentValue = useCallback(updater => {
    setValue(previousValue => {
      const nextValue = typeof updater === 'function' ? updater(previousValue) : updater;
      try {
        localStorage.setItem(key, serialize(nextValue));
      } catch {
        // Storage can be unavailable in private mode; keep in-memory state usable.
      }
      return nextValue;
    });
  }, [key, serialize]);

  return [value, setPersistentValue];
}

const PROJECT_GLOBAL_SCOPE = '__global__';
const EMPTY_SCOPE_MAP = {};

// 按项目分桶的持久化状态:整份 { [projectId]: value } 存在单个 localStorage key 里,
// 当前值在渲染时按 projectId 派生。activeProjectId 变化时(activateProject 原地更新、
// App 不重挂载)派生值自动跟着切——这正好绕开 usePersistentState「只在挂载时读一次」的限制。
// initialValue 建议传模块级常量,scope 缺省时返回它,保证引用稳定。
export function useProjectScopedState(baseKey, projectId, initialValue) {
  const [map, setMap] = usePersistentState(baseKey, EMPTY_SCOPE_MAP, jsonStorage);
  const scope = projectId == null ? PROJECT_GLOBAL_SCOPE : projectId;
  const value = scope in map ? map[scope] : resolveInitialValue(initialValue);
  const setScopedValue = useCallback(updater => {
    setMap(previousMap => {
      const current = scope in previousMap ? previousMap[scope] : resolveInitialValue(initialValue);
      const nextValue = typeof updater === 'function' ? updater(current) : updater;
      return { ...previousMap, [scope]: nextValue };
    });
  }, [scope, setMap, initialValue]);
  return [value, setScopedValue];
}
