import { useEffect, useRef, useState } from 'react';
import { Timer } from 'lucide-react';

function formatElapsed(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${s < 10 ? '0' : ''}${s}s` : `${s}s`;
}

// 运行时计时显示。独立成组件后，每秒的 setElapsed 只重渲这一行，
// 不再带着整条 trace 一起重渲（trace 渲染是 O(n) 甚至更高，按秒重跑很浪费）。
// paused：等待用户回答时暂停计时（不计入耗时）；finalMs：运行结束后的精确耗时。
export function ElapsedTimer({ running, startedAt, paused, finalMs }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(null);
  const pauseRef = useRef(null);

  useEffect(() => {
    if (!running) {
      startRef.current = null;
      pauseRef.current = null;
      return;
    }
    startRef.current = startedAt || Date.now();
    pauseRef.current = null;
    const timer = setInterval(() => {
      if (startRef.current) {
        const pausedMs = pauseRef.current ? Date.now() - pauseRef.current : 0;
        setElapsed(Math.round((Date.now() - startRef.current - pausedMs) / 1000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  // 进入/退出等待用户回答时暂停/恢复计时。
  useEffect(() => {
    if (paused && !pauseRef.current) {
      pauseRef.current = Date.now();
    } else if (!paused && pauseRef.current) {
      startRef.current += Date.now() - pauseRef.current;
      pauseRef.current = null;
    }
  }, [paused]);

  const display = running
    ? formatElapsed(elapsed)
    : finalMs
      ? formatElapsed(Math.round(finalMs / 1000))
      : elapsed > 0 ? formatElapsed(elapsed) : '-';

  return (
    <span className={`agent-metric ${running ? 'agent-metric-timer' : ''}`}>
      {running ? <>{display} <Timer size={12} /></> : display}
    </span>
  );
}
