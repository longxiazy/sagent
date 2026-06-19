import { memo, useState } from 'react';
import { RotateCcw, CornerDownRight, ChevronRight, ChevronDown } from 'lucide-react';
import { getModelLabel } from './plan-stage.js';
import { summarizeAction } from './action-summary.js';
import { ToolIcon } from './tool-icon.jsx';

// StepCard：把单模型一步的 observe + action + result 合并成一张卡。
// 原先单模型一步会渲染 4 块（observe / 折叠的 model_plan 废卡 / action / result），
// 这里压成 1 块——头部一行交代 Step + 动作摘要 + 模型 + token + 回滚，
// 截图走缩略图、动作 JSON 默认折叠、长文本截断，最大限度省纵向空间。
//
// events 是父组件按 step 预分组好的事件切片（含 observe/action/result/model_plan）。
// memo 化：trace 是 append-only，旧步骤的切片引用稳定，新事件到达时不会整片重渲。
// forceExpanded / onManualToggle 与 ModelPlanCard 同义，让面板头部「全部展开/折叠」生效。

const RESULT_SCREENSHOT_RE = /(?:\/[^\s\]]*)?\/(data\/screenshots|desktop-agent-observations)\/([^\s\]]+\.png)/;
const CLAMP_THRESHOLD = 80; // 超过该长度才显示「展开/收起」

export const StepCard = memo(function StepCard({ events, step, active, modelList, onRollback, rollbackLoading, openLightbox, forceExpanded, onManualToggle, t }) {
  const [jsonOpen, setJsonOpen] = useState(false);
  const [rationaleOpen, setRationaleOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);

  // 三处展开态统一受面板「全部展开/折叠」接管（forceExpanded 非 null 时），否则用本地态。
  const effJson = forceExpanded != null ? forceExpanded : jsonOpen;
  const effRationale = forceExpanded != null ? forceExpanded : rationaleOpen;
  const effResult = forceExpanded != null ? forceExpanded : resultOpen;

  // 从本步事件切片里拆出各阶段。action 信息优先取 step/action 事件，
  // 缺失时（如授权被拒只有 result）回退到 model_plan 决策事件。
  let observation = null, actionEvent = null, result = null, modelEvent = null;
  for (const e of events) {
    if (e.type === 'step' && e.stage === 'observe') observation = e.observation;
    else if (e.type === 'step' && e.stage === 'action') actionEvent = e;
    else if (e.type === 'step' && e.stage === 'result') result = e.result;
    else if (e.type === 'model_plan' && (e.stage === 'success' || e.stage === 'winner')) modelEvent = e;
  }

  const action = actionEvent?.action || modelEvent?.action || null;
  const rationale = actionEvent?.rationale || modelEvent?.rationale || '';
  const usage = actionEvent?.usage || modelEvent?.usage || null;
  const tokens = usage ? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) : 0;
  const summary = summarizeAction(action);
  const modelLabel = modelEvent ? getModelLabel(modelEvent.model, modelList) : null;

  const desktop = observation?.desktop;
  const browser = observation?.browser;
  const observeShot = desktop?.screenshotPath
    ? '/screenshots/' + desktop.screenshotPath.split('desktop-agent-observations').pop()?.replace(/^\//, '')
    : null;

  const resultShotMatch = result ? result.match(RESULT_SCREENSHOT_RE) : null;
  const resultShot = resultShotMatch ? '/screenshots/' + resultShotMatch[2] : null;

  // 切换本地展开态；若当前受 forceExpanded 接管，先通知父组件解除接管再翻转本地态。
  const toggle = setter => () => { if (forceExpanded != null) onManualToggle?.(); setter(v => !v); };

  const windows = desktop?.windows || [];
  const elements = browser?.elements || [];
  const hasObserveDetail = windows.length > 0 || elements.length > 0;

  return (
    <div className={`agent-trace-item step-card${active ? ' running' : ''}`} data-type="step" data-stage="merged">
      <div className="agent-trace-content">
        <div className="step-card-head">
          <span className="step-card-step">{step}</span>
          {action && <ToolIcon tool={action.tool} size={13} className="step-card-tool-icon" />}
          <span className="step-card-summary">{summary || t('agentPanel.badgeAction')}</span>
          {(modelLabel || tokens > 0) && (
            <span className="step-card-meta">
              {modelLabel}{modelLabel && tokens > 0 ? ' · ' : ''}{tokens > 0 ? `${tokens} tok` : ''}
            </span>
          )}
          <button className="trace-rollback-btn" onClick={e => { e.stopPropagation(); onRollback(step); }} disabled={rollbackLoading} title={t('agentPanel.rerunFromStep', { step })}>
            <RotateCcw size={10} />
          </button>
        </div>

        {/* observe 概要：桌面应用/窗口或浏览器标题 + URL + 截图缩略图 */}
        {desktop?.frontmostApp && (
          <p className="step-card-observe">
            {desktop.frontmostApp}{desktop.frontmostWindowTitle ? ` · ${desktop.frontmostWindowTitle}` : ''}
          </p>
        )}
        {browser?.title && <p className="step-card-observe">{browser.title}</p>}
        {browser?.url && <p className="agent-trace-url clamp-1">{browser.url}</p>}
        {observeShot && (
          <img className="screenshot-thumb clickable" src={observeShot} alt="screenshot" onClick={() => openLightbox(observeShot)} />
        )}
        {hasObserveDetail && (
          <details className="step-card-details">
            <summary>{t('agentPanel.moreDetails', { n: windows.length + elements.length })}</summary>
            <div className="agent-element-list">
              {windows.slice(0, 6).map((w, i) => (
                <span key={`${w.app}-${w.title}-${i}`} className="agent-element-chip">{w.app} {w.title || 'Untitled'}</span>
              ))}
              {elements.slice(0, 6).map(el => (
                <span key={el.id} className="agent-element-chip">#{el.id} {el.tag} {el.text || el.href || ''}</span>
              ))}
            </div>
          </details>
        )}

        {/* 决策理由：截断，超长可展开 */}
        {rationale && (
          <>
            <p className={effRationale ? '' : 'clamp-2'}>{rationale}</p>
            {rationale.length > CLAMP_THRESHOLD && (
              <button className="step-card-toggle" onClick={toggle(setRationaleOpen)}>
                {effRationale ? t('agentPanel.showLess') : t('agentPanel.showMore')}
              </button>
            )}
          </>
        )}

        {/* 动作 JSON：默认折叠成一颗 chip，点开看完整 JSON */}
        {action && (
          <div className="step-card-json">
            <button className="step-card-json-toggle" onClick={toggle(setJsonOpen)}>
              {effJson ? <ChevronDown size={11} /> : <ChevronRight size={11} />} JSON
            </button>
            {effJson && <pre className="agent-json">{JSON.stringify(action, null, 2)}</pre>}
          </div>
        )}

        {/* 执行结果：截图走缩略图（点开放大），纯文本以 ↳ 锚点引出、截断可展开 */}
        {resultShot && (
          <img className="screenshot-thumb clickable" src={resultShot} alt="screenshot" onClick={() => openLightbox(resultShot)} />
        )}
        {result && !resultShot && (
          <div className="step-card-result">
            <CornerDownRight size={12} className="step-card-result-icon" />
            <div className="step-card-result-body">
              <p className={effResult ? '' : 'clamp-2'}>{result}</p>
              {result.length > CLAMP_THRESHOLD && (
                <button className="step-card-toggle" onClick={toggle(setResultOpen)}>
                  {effResult ? t('agentPanel.showLess') : t('agentPanel.showMore')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
