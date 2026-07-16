import { memo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { getModelLabel } from './plan-stage.js';
import { summarizeAction } from './action-summary.js';
import { isFailureResult, resultScreenshot } from './result-status.js';
import { ObserveSummary } from './ObserveSummary.jsx';
import { ResultSummary } from './ResultSummary.jsx';
import { ActionDetails } from './ActionDetails.jsx';
import { TerminalProcess } from './TerminalProcess.jsx';
import { McpProcess } from './McpProcess.jsx';
import { PromptRequestDetails } from './PromptRequestDetails.jsx';

// StepCard：把单模型一步的 observe + action + result 合并成一张卡。
// 原先单模型一步会渲染 4 块（observe / 折叠的 model_plan 废卡 / action / result），
// 这里压成 1 块——头部一行交代 Step + 动作摘要 + 模型 + token + 回滚，
// 截图走缩略图、动作 JSON 默认折叠、长文本截断，最大限度省纵向空间。
//
// events 是父组件按 step 预分组好的事件切片（含 observe/action/result/model_plan）。
// memo 化：trace 是 append-only，旧步骤的切片引用稳定，新事件到达时不会整片重渲。
// forceExpanded / onManualToggle 与 ModelPlanCard 同义，让面板头部「全部展开/折叠」生效。

export const StepCard = memo(function StepCard({ events, step, previousRequest, active, modelList, onRollback, rollbackLoading, openLightbox, forceExpanded, onManualToggle, t }) {
  const [jsonOpen, setJsonOpen] = useState(false);

  // 展开态受面板「全部展开/折叠」接管（forceExpanded 非 null 时），否则用本地态。
  const effJson = forceExpanded != null ? forceExpanded : jsonOpen;

  // 从本步事件切片里拆出各阶段。action 信息优先取 step/action 事件，
  // 缺失时（如授权被拒只有 result）回退到 model_plan 决策事件。
  let observation = null, actionEvent = null, resultEvent = null, result = null, modelEvent = null;
  const terminalEvents = [];
  const mcpEvents = [];
  for (const e of events) {
    if (e.type === 'step' && e.stage === 'observe') observation = e.observation;
    else if (e.type === 'step' && e.stage === 'action') actionEvent = e;
    else if (e.type === 'step' && e.stage === 'result') { resultEvent = e; result = e.result; }
    else if (e.type === 'model_plan' && (e.stage === 'success' || e.stage === 'winner')) modelEvent = e;
    else if (e.type === 'terminal_output') terminalEvents.push(e);
    else if (e.type === 'mcp_output') mcpEvents.push(e);
  }

  const action = actionEvent?.action || modelEvent?.action || null;
  const rationale = actionEvent?.rationale || modelEvent?.rationale || '';
  const reasoning = modelEvent?.reasoning || '';
  const usage = actionEvent?.usage || modelEvent?.usage || null;
  const tokens = usage ? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) : 0;
  const summary = summarizeAction(action, rationale);
  const response = modelEvent?.response ?? (modelEvent ? { rationale: modelEvent.rationale, action: modelEvent.action } : null);
  const modelLabel = modelEvent ? getModelLabel(modelEvent.model, modelList) : null;

  // 文本结果命中失败模式时整卡标红（截图结果不参与判定）
  const resultStatus = resultEvent?.resultStatus || resultEvent?.status;
  const failed = !resultScreenshot(result) && isFailureResult(result, resultStatus);

  // 切换本地展开态；若当前受 forceExpanded 接管，先通知父组件解除接管再翻转本地态。
  const toggle = setter => () => { if (forceExpanded != null) onManualToggle?.(); setter(v => !v); };

  return (
    <div
      className={`agent-trace-item step-card${active ? ' running' : ''}${failed ? ' result-failed' : ''}`}
      data-type="step"
      data-stage="merged"
      data-tool={action?.tool || undefined}
    >
      <div className="agent-trace-content">
        <PromptRequestDetails requests={modelEvent?.requests} previousRequest={previousRequest} response={response} reasoning={reasoning} t={t} />
        <div className="step-card-head">
          <span className="step-card-step">{step}</span>
          <span className="step-card-summary" title={summary}>{summary || t('agentPanel.badgeAction')}</span>
          {(modelLabel || tokens > 0) && (
            <span className="step-card-meta">
              {modelLabel}{modelLabel && tokens > 0 ? ' · ' : ''}{tokens > 0 ? `${tokens} tok` : ''}
            </span>
          )}
          <button className="trace-rollback-btn" onClick={e => { e.stopPropagation(); onRollback(step); }} disabled={rollbackLoading} title={t('agentPanel.rerunFromStep', { step })}>
            <RotateCcw size={10} />
          </button>
        </div>

        {/* 观察上下文放在标题与工具执行之间。 */}
        <ObserveSummary observation={observation} openLightbox={openLightbox} t={t} />

        {(action || terminalEvents.length > 0 || mcpEvents.length > 0 || result) && (
          <div className="tool-execution-block">
            {action && (
              <ActionDetails action={action} jsonOpen={effJson} onToggleJson={toggle(setJsonOpen)} t={t} />
            )}
            <TerminalProcess events={terminalEvents} running={active && !result} t={t} />
            <McpProcess events={mcpEvents} running={active && !result} t={t} />
            <ResultSummary result={result} resultStatus={resultStatus} openLightbox={openLightbox} forceExpanded={forceExpanded} onManualToggle={onManualToggle} t={t} />
          </div>
        )}
      </div>
    </div>
  );
});
