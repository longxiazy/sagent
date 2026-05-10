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
