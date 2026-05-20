import { RotateCcw } from 'lucide-react';

// 推荐任务/问题列表 + "换一组" 按钮。
// 单击 → 把内容填入输入框；双击 → 直接发送。
export function SuggestionsList({
  mode,
  suggestions,
  sessionLocked,
  onShuffle,
  onPick,
  onSubmit,
}) {
  return (
    <>
      <div className="suggestions-head">
        <span className="suggestions-label">{mode === 'agent' ? '试试这些任务' : '试试这些问题'}</span>
        <button
          className="suggestions-refresh"
          onClick={onShuffle}
          disabled={sessionLocked}
          title="换一组"
        >
          <RotateCcw size={12} /> 换一组
        </button>
      </div>

      <div className="suggestions">
        {suggestions.map(s => (
          <button
            key={s.title}
            className="suggestion-card"
            onClick={() => onPick(s.text)}
            onDoubleClick={() => onSubmit(s.text)}
          >
            <span className="suggestion-title">{s.title}</span>
            <span className="suggestion-text">{s.text}</span>
          </button>
        ))}
      </div>
    </>
  );
}
