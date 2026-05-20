import { ChevronDown, ChevronUp } from 'lucide-react';

// 模型选择控件：
// - chat 模式：标准下拉
// - agent 模式：多选 tag + 优先级排序 + race/vote 策略切换
//
// 只在 sessionStarted=false 时渲染。组件自己判断这个条件，让 App
// 那边可以无条件 <ModelSelector .../> 写成一行。
export function ModelSelector({
  sessionStarted,
  mode,
  availableModels,
  chatModel,
  setChatModel,
  selectedAgentModels,
  setSelectedAgentModels,
  agentStrategy,
  setAgentStrategy,
  sessionLocked,
}) {
  if (sessionStarted) return null;

  if (mode !== 'agent') {
    return (
      <select className="model-select" value={chatModel} onChange={e => setChatModel(e.target.value)} title="切换模型">
        {availableModels.map(item => (
          <option key={item.id} value={item.id}>{item.label}</option>
        ))}
      </select>
    );
  }

  const toggleAgentModel = id => {
    setSelectedAgentModels(prev => (prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]));
  };

  const moveAgentModel = (id, dir) => {
    setSelectedAgentModels(prev => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const next = [...prev];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  };

  return (
    <div className="model-tags-wrap">
      <div className="model-tags">
        {availableModels.map(item => {
          const isSelected = selectedAgentModels.includes(item.id);
          const orderIdx = selectedAgentModels.indexOf(item.id);
          return (
            <span key={item.id} className={`model-tag-wrapper ${isSelected ? 'selected' : ''}`}>
              <button
                className={`model-tag ${isSelected ? 'selected' : ''}`}
                onClick={() => toggleAgentModel(item.id)}
                disabled={sessionLocked}
                title={isSelected ? '取消选择' : '选择并发执行'}
              >
                {item.label}
              </button>
              {isSelected && selectedAgentModels.length > 1 && (
                <span className="model-tag-order">
                  <button className="order-arrow" onClick={() => moveAgentModel(item.id, -1)} disabled={orderIdx <= 0 || sessionLocked} title="提高优先级"><ChevronUp size={10} /></button>
                  <span className="order-number">{orderIdx + 1}</span>
                  <button className="order-arrow" onClick={() => moveAgentModel(item.id, 1)} disabled={orderIdx >= selectedAgentModels.length - 1 || sessionLocked} title="降低优先级"><ChevronDown size={10} /></button>
                </span>
              )}
            </span>
          );
        })}
      </div>
      {selectedAgentModels.length > 1 && (
        <div className="strategy-toggle">
          <button
            className={`strategy-btn ${agentStrategy === 'race' ? 'active' : ''}`}
            onClick={() => setAgentStrategy('race')}
            disabled={sessionLocked}
            title="按优先级分批启动，先到先得"
          >竞速</button>
          <button
            className={`strategy-btn ${agentStrategy === 'vote' ? 'active' : ''}`}
            onClick={() => setAgentStrategy('vote')}
            disabled={sessionLocked}
            title="等待所有模型完成，投票选最优"
          >汇总</button>
        </div>
      )}
    </div>
  );
}
