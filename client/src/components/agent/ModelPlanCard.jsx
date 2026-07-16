import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { getModelLabel, PLAN_STAGE_LABELS, PLAN_STAGE_ICON } from './plan-stage.js';
import { summarizeAction } from './action-summary.js';
import { useT } from '../../i18n/I18nProvider.jsx';
import { ActionDetails } from './ActionDetails.jsx';
import { PromptRequestDetails } from './PromptRequestDetails.jsx';
import { ResultSummary } from './ResultSummary.jsx';
import { TerminalProcess } from './TerminalProcess.jsx';
import { McpProcess } from './McpProcess.jsx';

// 单个模型在某一步的「决策行」。扁平结构（无整卡展开/折叠、无复制按钮、无左色条），
// 与单模型 StepCard 行同构：winner 行直接带 step 号(前) + 回滚(尾)，理由直接显示，
// 动作 JSON 用始终可见的同款 chip 点开。thinking / failed 等过渡态仍以「模型名 + 状态」呈现。

export function ModelPlanCard({ event, previousRequest, isWinner, modelList, step, onRollback, rollbackLoading, forceExpanded, onManualToggle, result = null, resultStatus = null, terminalEvents = [], mcpEvents = [], openLightbox }) {
  const t = useT();
  const label = getModelLabel(event.model, modelList);
  const stage = event.stage;
  const [showJson, setShowJson] = useState(false);
  // 各处展开态受面板「全部展开/折叠」接管（forceExpanded 非 null 时），否则用本地态。
  const effJson = forceExpanded != null ? forceExpanded : showJson;

  if (stage === 'start') return null;

  // 有动作的稳定态（winner/success/cancelled）让动作当主角，与单模型 StepCard 行同构。
  const showActionPrimary = !!event.action && (stage === 'winner' || stage === 'success' || stage === 'cancelled');
  const actionSummary = summarizeAction(event.action, event.rationale);
  const response = event.response ?? { rationale: event.rationale, action: event.action };
  const tokens = event.usage ? (event.usage.prompt_tokens || 0) + (event.usage.completion_tokens || 0) : 0;
  // 翻转本地展开态；受面板「全部展开/折叠」接管时先解除接管再翻转。
  const toggle = setter => e => { e.stopPropagation(); if (forceExpanded != null) onManualToggle?.(); setter(v => !v); };

  // ── 有动作的稳定态：扁平行（= 单模型行：[step号] 工具图标 动作摘要 模型·token [回滚]） ──
  if (showActionPrimary) {
    return (
      <div className={`model-card ${stage}${isWinner ? ' winner' : ''}`} data-tool={event.action.tool || undefined}>
        <PromptRequestDetails requests={event.requests} previousRequest={previousRequest} response={response} reasoning={event.reasoning} t={t} />
        <div className="model-card-head">
          {isWinner && <span className="step-card-step">{step}</span>}
          <span className="model-card-summary" title={actionSummary}>{actionSummary}</span>
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

        <div className="tool-execution-block">
          <ActionDetails action={event.action} jsonOpen={effJson} onToggleJson={toggle(setShowJson)} t={t} />
          <TerminalProcess events={terminalEvents} running={isWinner && !result} t={t} />
          <McpProcess events={mcpEvents} running={isWinner && !result} t={t} />
          <ResultSummary result={result} resultStatus={resultStatus} openLightbox={openLightbox} forceExpanded={forceExpanded} onManualToggle={onManualToggle} t={t} />
        </div>
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
