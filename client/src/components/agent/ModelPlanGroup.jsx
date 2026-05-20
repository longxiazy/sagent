import { RotateCcw } from 'lucide-react';
import { ModelPlanCard } from './ModelPlanCard.jsx';

// 多模型一步会产生多条 model_plan 事件。这个组件负责把零散事件重新聚合成
// 一个"按 step 分组"的展示块，让用户能看到同一步里不同模型如何竞争/投票。
export function ModelPlanGroup({ trace, step, models, modelList, running, cardsExpanded, onManualToggle, onRollback, rollbackLoading }) {
  let strategyMode = 'race';
  let consensusEvent = null;
  const modelEvents = {};
  let stepResult = null;

  // Collect ALL model_plan events + step result for this step from the entire trace
  for (const e of trace) {
    if (e.step !== step) continue;
    if (e.type === 'model_plan') {
      if (e.stage === 'start') {
        strategyMode = e.strategy || 'race';
        continue;
      }
      if (e.stage === 'consensus') {
        consensusEvent = e;
        continue;
      }
      modelEvents[e.model] = e;
    } else if (e.type === 'step' && e.stage === 'result') {
      stepResult = e.result;
    }
  }

  // Agent is truly finished when trace has a terminal event (done/error) for this run
  const agentFinished = !running && trace.some(e => e.type === 'done' || e.type === 'error');

  const winnerModel = consensusEvent?.model || Object.values(modelEvents).find(e => e.stage === 'winner')?.model;

  const getEvent = m => {
    const ev = modelEvents[m];
    if (!ev) return { model: m, stage: agentFinished ? 'cancelled' : (strategyMode === 'race' ? 'pending' : 'thinking') };
    if (agentFinished && ev.stage === 'thinking') return { ...ev, stage: 'cancelled' };
    return ev;
  };

  const visibleModels = models.filter(m => { const s = getEvent(m).stage; return s !== 'cancelled' && s !== 'failed' && s !== 'rate_limited'; });
  const collapsedModels = models.filter(m => { const s = getEvent(m).stage; return s === 'cancelled' || s === 'failed' || s === 'rate_limited'; });

  return (
    <div className="model-plan-group">
      <span className="agent-trace-badge plan">
        {strategyMode === 'vote' ? '投票' : '决策'}
      </span>
      <button className="trace-rollback-btn" onClick={(e) => { e.stopPropagation(); onRollback?.(step); }} disabled={rollbackLoading} title={`从 Step ${step} 重新执行`}>
        <RotateCcw size={10} />
      </button>
      <div className="model-plan-cards">
        {visibleModels.map(m => (
          <ModelPlanCard
            key={m}
            event={getEvent(m)}
            isWinner={winnerModel === m}
            modelList={modelList}
            strategy={strategyMode}
            result={winnerModel === m ? stepResult : null}
            forceExpanded={cardsExpanded}
            onManualToggle={onManualToggle}
          />
        ))}
      </div>
      {collapsedModels.length > 0 && (
        <details className="model-plan-collapsed">
          <summary className="collapsed-summary">{collapsedModels.length} 个模型已取消/失败</summary>
          <div className="model-plan-cards">
            {collapsedModels.map(m => (
              <ModelPlanCard
                key={m}
                event={getEvent(m)}
                isWinner={false}
                modelList={modelList}
                strategy={strategyMode}
                result={null}
                forceExpanded={cardsExpanded}
                onManualToggle={onManualToggle}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
