import { RotateCcw } from 'lucide-react';

// 推荐任务/问题列表 + "换一组" 按钮。
// 单击 → 把内容填入输入框;双击 → 直接发送。
// agent 模式下,categories 非空时显示分类 Tabs。
export function SuggestionsList({
  mode,
  suggestions,
  categories,
  activeCategoryId,
  onSelectCategory,
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

      {categories && categories.length > 0 && (
        <div className="suggestions-tabs">
          {categories.map(c => (
            <button
              key={c.id}
              className={`suggestions-tab${c.id === activeCategoryId ? ' active' : ''}`}
              onClick={() => onSelectCategory(c.id)}
              disabled={sessionLocked}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

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
