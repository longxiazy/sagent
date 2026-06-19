import { useState } from 'react';
import { RotateCcw, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';
import { getModelLabel, PLAN_STAGE_LABELS, PLAN_STAGE_ICON } from './plan-stage.js';
import { summarizeAction } from './action-summary.js';
import { ToolIcon } from './tool-icon.jsx';
import { useT } from '../../i18n/I18nProvider.jsx';

// 单个模型在某一步的「决策行」。扁平结构（无整卡展开/折叠、无复制按钮、无左色条），
// 与单模型 StepCard 行同构：winner 行直接带 step 号(前) + 回滚(尾)，理由直接显示，
// 动作 JSON 用始终可见的同款 chip 点开。thinking / failed 等过渡态仍以「模型名 + 状态」呈现。

const CLAMP_THRESHOLD = 80; // 理由超过该长度才显示「展开/收起」

export function ModelPlanCard({ event, isWinner, modelList, step, onRollback, rollbackLoading, forceExpanded, onManualToggle }) {
  const t = useT();
  const label = getModelLabel(event.model, modelList);
  const stage = event.stage;
  const [showJson, setShowJson] = useState(false);
  const [showRationale, setShowRationale] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  // 各处展开态受面板「全部展开/折叠」接管（forceExpanded 非 null 时），否则用本地态。
  const effJson = forceExpanded != null ? forceExpanded : showJson;
  const effRationale = forceExpanded != null ? forceExpanded : showRationale;
  const effReasoning = forceExpanded === true ? true : showReasoning;

  if (stage === 'start') return null;

  // 有动作的稳定态（winner/success/cancelled）让动作当主角，与单模型 StepCard 行同构。
  const showActionPrimary = !!event.action && (stage === 'winner' || stage === 'success' || stage === 'cancelled');
  const tokens = event.usage ? (event.usage.prompt_tokens || 0) + (event.usage.completion_tokens || 0) : 0;
  // 翻转本地展开态；受面板「全部展开/折叠」接管时先解除接管再翻转。
  const toggle = setter => e => { e.stopPropagation(); if (forceExpanded != null) onManualToggle?.(); setter(v => !v); };

  // ── 有动作的稳定态：扁平行（= 单模型行：[step号] 工具图标 动作摘要 模型·token [回滚]） ──
  if (showActionPrimary) {
    return (
      <div className={`model-card ${stage}${isWinner ? ' winner' : ''}`} data-tool={event.action.tool || undefined}>
        <div className="model-card-head">
          {isWinner && <span className="step-card-step">{step}</span>}
          <ToolIcon tool={event.action.tool} size={13} className="model-card-tool-icon" />
          <span className="model-card-summary">{summarizeAction(event.action)}</span>
          <span className="model-card-meta">
            {isWinner && <span className="model-card-winner-star">★</span>}
            {label}{tokens > 0 ? ` · ${tokens} tok` : ''}
          </span>
          {isWinner && onRollback && (
            <button className="trace-rollback-btn" onClick={e => { e.stopPropagation(); onRollback(step); }} disabled={rollbackLoading} title={t('agentPanel.rerunFromStep', { step })}>
              <RotateCcw size={10} />
            </button>
          )}
        </div>

        {/* 决策理由：直接显示，截断可展开（与单模型一致） */}
        {event.rationale && (
          <>
            <p className={`model-card-rationale ${effRationale ? '' : 'clamp-2'}`}>{event.rationale}</p>
            {event.rationale.length > CLAMP_THRESHOLD && (
              <button className="step-card-toggle" onClick={toggle(setShowRationale)}>
                {effRationale ? t('agentPanel.showLess') : t('agentPanel.showMore')}
              </button>
            )}
          </>
        )}

        {/* 动作 JSON：始终可见的同款 chip，点开看完整 JSON（与单模型一致） */}
        <div className="step-card-json">
          <button className="step-card-json-toggle" onClick={toggle(setShowJson)}>
            {effJson ? <ChevronDown size={11} /> : <ChevronRight size={11} />} JSON
          </button>
          {effJson && <pre className="agent-json">{JSON.stringify(event.action, null, 2)}</pre>}
        </div>

        {/* 深度思考（reasoning_content）：次要，小开关折叠 */}
        {event.reasoning && (
          <div className="model-card-reasoning">
            <button className="model-card-reasoning-toggle" onClick={toggle(setShowReasoning)}>
              {t('modelCard.reasoning')} {effReasoning ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            </button>
            {effReasoning && <pre className="model-card-reasoning-text">{event.reasoning}</pre>}
          </div>
        )}
      </div>
    );
  }

  // ── 过渡/异常态：模型名 + 状态 + 简要信息（无动作可对比，本就与稳定态不同） ──
  return (
    <div className={`model-card ${stage}${isWinner ? ' winner' : ''}`}>
      <div className="model-card-head">
        <span className="model-card-icon">{PLAN_STAGE_ICON[stage] || '·'}</span>
        <span className="model-card-label">{label}</span>
        <span className={`model-card-status ${stage}`}>{PLAN_STAGE_LABELS[stage] ? t(PLAN_STAGE_LABELS[stage]) : stage}</span>
      </div>
      {stage === 'pending' && (
        <p className="model-card-sub">{event.delay ? t('modelCard.startIn', { n: Math.round(event.delay / 1000) }) : t('modelCard.queued')}</p>
      )}
      {stage === 'thinking' && (
        <div className="model-card-thinking"><span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" /></div>
      )}
      {stage === 'failed' && (
        <>
          {event.rationale && <p className="model-card-sub">{event.rationale}</p>}
          {event.error && <p className="model-card-error">{event.error}</p>}
        </>
      )}
      {stage === 'discarded' && event.rationale && <p className="model-card-discarded">{event.rationale.slice(0, 80)}…</p>}
      {stage === 'abandoned' && <p className="model-card-discarded">{t('modelCard.abandoned')}</p>}
      {stage === 'cancelled' && !event.rationale && <p className="model-card-discarded">{t('modelCard.cancelled')}</p>}
      {stage === 'rate_limited' && (
        <>
          <p className="model-card-error">{event.cooldown_ms ? t('modelCard.rateLimitedPause', { n: Math.round(event.cooldown_ms / 1000) }) : t('modelCard.rateLimited')}</p>
          {event.error && <p className="model-card-error">{event.error}</p>}
        </>
      )}
    </div>
  );
}
