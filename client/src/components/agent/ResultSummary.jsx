import { useState } from 'react';
import { CornerDownRight } from 'lucide-react';
import { resultScreenshot, splitFailureHighlights } from './result-status.js';

// 执行结果概要：截图走缩略图（点开放大），纯文本以 ↳ 锚点引出、超长截断可展开。
// 单模型 StepCard 与多模型决策卡组的节点底部共用，保证「执行结果」展示口径一致。
//
// 失败标红不在这里做——由父节点用 isFailureResult(result) 给整个节点加 .result-failed
// class（圆点 + ↳ + 文字一起变红），与单模型一致。

const CLAMP_THRESHOLD = 80; // 超过该长度才显示「展开/收起」

export function ResultSummary({ result, resultStatus, openLightbox, forceExpanded, onManualToggle, t }) {
  const [open, setOpen] = useState(false);
  const eff = forceExpanded != null ? forceExpanded : open;
  if (!result) return null;

  const shot = resultScreenshot(result);
  if (shot) {
    return (
      <div className="tool-result-details">
        <div className="tool-result-label">{t('agentPanel.requestResult')}</div>
        <img className="screenshot-thumb clickable" src={shot} alt="screenshot" onClick={() => openLightbox(shot)} />
      </div>
    );
  }

  // 切换本地展开态；受面板「全部展开/折叠」接管时先解除接管再翻转。
  const toggle = () => { if (forceExpanded != null) onManualToggle?.(); setOpen(v => !v); };

  return (
    <div className="step-card-result">
      <div className="tool-result-label">{t('agentPanel.requestResult')}</div>
      <div className="step-card-result-body">
        <CornerDownRight size={12} className="step-card-result-icon" />
        <p className={eff ? '' : 'clamp-2'}>
          {splitFailureHighlights(result, resultStatus).map((seg, i) => (
            seg.hit ? <span key={i} className="result-keyword">{seg.text}</span> : seg.text
          ))}
        </p>
        {result.length > CLAMP_THRESHOLD && (
          <button className="step-card-toggle" onClick={toggle}>
            {eff ? t('agentPanel.showLess') : t('agentPanel.showMore')}
          </button>
        )}
      </div>
    </div>
  );
}
