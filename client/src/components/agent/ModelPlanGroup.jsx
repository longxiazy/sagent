import { ModelPlanCard } from './ModelPlanCard.jsx';
import { ObserveSummary } from './ObserveSummary.jsx';
import { useT } from '../../i18n/I18nProvider.jsx';

// 多模型一步会产生多条 model_plan 事件。这个组件负责把零散事件重新聚合成
// 一个"按 step 分组"的展示块，让用户能看到同一步里不同模型如何竞争/投票。
// events 是父组件预分组好的、仅属于本 step 的事件切片（避免每个 group 再各自
// 遍历整条 trace —— 否则 S 步 × N 事件 = O(N²)）。agentFinished 由父组件统一判定。
export function ModelPlanGroup({ events, step, models, modelList, agentFinished, cardsExpanded, onManualToggle, onRollback, rollbackLoading, openLightbox }) {
  const t = useT();
  let strategyMode = 'race';
  let consensusEvent = null;
  const modelEvents = {};
  let stepResult = null;
  let observation = null;

  for (const e of events) {
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
    } else if (e.type === 'step' && e.stage === 'observe') {
      observation = e.observation;
    }
  }

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
    <div className="model-plan-group" data-tool={(winnerModel && getEvent(winnerModel)?.action?.tool) || undefined}>
      <div className="agent-trace-content">
        <div className="model-plan-head">
          <span className="agent-trace-badge plan">
            {strategyMode === 'vote' ? t('modelPlan.vote') : t('modelPlan.decision')}
          </span>
        </div>
        <ObserveSummary observation={observation} openLightbox={openLightbox} t={t} />
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
              onRollback={onRollback}
              step={step}
              rollbackLoading={rollbackLoading}
            />
          ))}
        </div>
        {collapsedModels.length > 0 && (
          <details className="model-plan-collapsed">
            <summary className="collapsed-summary">{t('modelPlan.collapsedModels', { n: collapsedModels.length })}</summary>
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
    </div>
  );
}
