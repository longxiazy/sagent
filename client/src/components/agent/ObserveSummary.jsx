// 观察(observe)概要：把一步「行动前看环境」的观测渲染成紧凑概要——
// 前台应用/窗口、浏览器标题/URL、截图缩略图，以及窗口/元素清单（折叠详情）。
//
// 单模型 StepCard 顶部与多模型决策卡组顶部共用，确保「一步=一个节点」时两者
// 的观察展示口径完全一致（同样的字段、同样的缩略图与折叠详情）。

export function ObserveSummary({ observation, openLightbox, t }) {
  const desktop = observation?.desktop;
  const browser = observation?.browser;
  const observeShot = desktop?.screenshotPath
    ? '/screenshots/' + desktop.screenshotPath.split('desktop-agent-observations').pop()?.replace(/^\//, '')
    : null;
  const windows = desktop?.windows || [];
  const elements = browser?.elements || [];
  const hasObserveDetail = windows.length > 0 || elements.length > 0;

  // 没有任何可展示的观测就不渲染（避免空节点）。
  if (!desktop?.frontmostApp && !browser?.title && !browser?.url && !observeShot && !hasObserveDetail) {
    return null;
  }

  return (
    <>
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
    </>
  );
}
