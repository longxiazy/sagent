import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { CopyButton } from '../CopyButton.jsx';
import { getModelLabel, PLAN_STAGE_LABELS, PLAN_STAGE_ICON } from './plan-stage.js';

// 单个模型卡片负责展示某一步里某个模型的"决策快照"：
// 当前状态、理由、动作、tokens，以及在竞速模式下是否被采纳。
export function ModelPlanCard({ event, isWinner, modelList, result, forceExpanded, onManualToggle }) {
  const label = getModelLabel(event.model, modelList);
  const stage = event.stage;
  const [showReasoning, setShowReasoning] = useState(false);
  const [showFullResult, setShowFullResult] = useState(false);
  const [expanded, setExpanded] = useState(isWinner || stage === 'failed');
  const effectiveExpanded = forceExpanded != null ? forceExpanded : expanded;
  const effectiveShowReasoning = forceExpanded === true ? true : showReasoning;
  const effectiveShowFullResult = forceExpanded === true ? true : showFullResult;

  if (stage === 'start') return null;

  // 拼接整个决策节点的可复制文本
  const copyText = [
    event.rationale,
    event.reasoning,
    event.action ? JSON.stringify(event.action, null, 2) : '',
    event.error,
    result,
  ].filter(Boolean).join('\n\n');

  return (
    <div className={`model-card ${stage} ${isWinner ? 'winner' : ''} ${effectiveExpanded ? 'expanded' : ''}`} onClick={() => { if (forceExpanded != null) onManualToggle?.(); setExpanded(v => !v); }}>
      <div className="model-card-head">
        <span className="model-card-icon">{PLAN_STAGE_ICON[stage] || '·'}</span>
        <span className="model-card-label">{label}</span>
        <span className={`model-card-status ${stage}`}>{PLAN_STAGE_LABELS[stage] || stage}</span>
        {copyText && <CopyButton text={copyText} />}
        <span className="model-card-expand-icon">{effectiveExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}</span>
      </div>
      {stage === 'pending' && (
        <div className="model-card-body">
          <p style={{ color: 'var(--c-text-tertiary)', fontSize: 12 }}>
            {event.delay ? `${Math.round(event.delay / 1000)}s 后启动` : '排队中'}
          </p>
        </div>
      )}
      {stage === 'thinking' && (
        <div className="model-card-body">
          <div className="model-card-thinking">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
          </div>
        </div>
      )}
      {(stage === 'winner' || stage === 'success') && event.rationale && (
        <div className="model-card-body">
          <p>{event.rationale}</p>
          {event.reasoning && (
            <div className="model-card-reasoning">
              <button className="model-card-reasoning-toggle" onClick={() => setShowReasoning(v => !v)}>
                思考过程 {effectiveShowReasoning ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              </button>
              {effectiveShowReasoning && (
                <pre className="model-card-reasoning-text">{event.reasoning}</pre>
              )}
            </div>
          )}
          <div className="model-card-action-row">
            <span className="model-card-action">{event.action?.tool}.{event.action?.type}</span>
            {event.usage && (
              <span className="model-card-tokens">{event.usage.prompt_tokens + event.usage.completion_tokens} tokens</span>
            )}
          </div>
          <pre className="model-card-json">{JSON.stringify(event.action, null, 2)}</pre>
          {isWinner && result && (
            <div className="model-card-result">
              <span className="model-card-result-label">执行结果</span>
              <p>{effectiveShowFullResult || result.length <= 50 ? result : result.slice(0, 50) + '…'}</p>
              {result.length > 50 && (
                <button className="model-card-result-toggle" onClick={() => setShowFullResult(v => !v)}>
                  {effectiveShowFullResult ? '收起' : '展开全部'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {stage === 'failed' && (event.error || event.rationale) && (
        <div className="model-card-body">
          {event.rationale && <p>{event.rationale}</p>}
          {event.error && <p className="model-card-error">{event.error}</p>}
        </div>
      )}
      {stage === 'discarded' && event.rationale && (
        <div className="model-card-body">
          <p className="model-card-discarded">{event.rationale.slice(0, 80)}…</p>
        </div>
      )}
      {stage === 'abandoned' && (
        <div className="model-card-body">
          <p className="model-card-discarded">未完成，已被其他模型抢先</p>
        </div>
      )}
      {stage === 'cancelled' && event.rationale && (
        <div className="model-card-body">
          <p>{event.rationale}</p>
          {event.reasoning && (
            <div className="model-card-reasoning">
              <button className="model-card-reasoning-toggle" onClick={() => setShowReasoning(v => !v)}>
                思考过程 {effectiveShowReasoning ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              </button>
              {effectiveShowReasoning && (
                <pre className="model-card-reasoning-text">{event.reasoning}</pre>
              )}
            </div>
          )}
          <div className="model-card-action-row">
            <span className="model-card-action">{event.action?.tool}.{event.action?.type}</span>
            {event.usage && (
              <span className="model-card-tokens">{event.usage.prompt_tokens + event.usage.completion_tokens} tokens</span>
            )}
          </div>
          <pre className="model-card-json">{JSON.stringify(event.action, null, 2)}</pre>
        </div>
      )}
      {stage === 'cancelled' && !event.rationale && (
        <div className="model-card-body">
          <p className="model-card-discarded">任务已取消</p>
        </div>
      )}
      {stage === 'rate_limited' && (
        <div className="model-card-body">
          <p className="model-card-error">
            {event.cooldown_ms ? `已限流，暂停 ${Math.round(event.cooldown_ms / 1000)}s` : '模型限流冷却中'}
          </p>
          {event.error && <p className="model-card-error">{event.error}</p>}
        </div>
      )}
    </div>
  );
}
