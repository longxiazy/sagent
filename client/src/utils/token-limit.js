export function formatTokenLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) {
    const m = n % 1_000_000 === 0
      ? n / 1_000_000
      : n % 1_048_576 === 0
        ? n / 1_048_576
        : n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n % 1_000 === 0
      ? n / 1_000
      : n % 1_024 === 0
        ? n / 1_024
        : n / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(0)}K`;
  }
  return String(n);
}
