function positiveAttempt(value) {
  const attempt = Number(value);
  return Number.isInteger(attempt) && attempt > 0 ? attempt : null;
}

export function attemptStepKey(attempt, step) {
  return `${attempt}:${step}`;
}

export function annotateTraceAttempts(trace) {
  let inferredAttempt = 1;
  let runMetaCount = 0;

  return (Array.isArray(trace) ? trace : []).map((event, index) => {
    const explicitAttempt = positiveAttempt(event?.attempt);

    if (event?.type === 'run_meta') {
      runMetaCount += 1;
      inferredAttempt = explicitAttempt || runMetaCount;
    } else if (explicitAttempt) {
      inferredAttempt = explicitAttempt;
      runMetaCount = Math.max(runMetaCount, explicitAttempt);
    }

    return {
      event,
      index,
      attempt: explicitAttempt || Math.max(1, inferredAttempt),
    };
  });
}

export function buildAttemptTraceIndex(trace) {
  const entries = annotateTraceAttempts(trace);
  const eventsByStep = new Map();
  const firstEventIndexByAttempt = new Map();
  const observeAnchorIndexByStep = new Map();
  const planAnchorIndexByStep = new Map();
  const singleModelSteps = new Set();
  const multiModelSteps = new Set();
  const terminalAttempts = new Set();
  let latestAttempt = 1;

  for (const entry of entries) {
    const { event, index, attempt } = entry;
    latestAttempt = Math.max(latestAttempt, attempt);
    if (!firstEventIndexByAttempt.has(attempt)) firstEventIndexByAttempt.set(attempt, index);
    if (event?.type === 'done' || event?.type === 'error') terminalAttempts.add(attempt);
    if (event?.step == null) continue;

    const key = attemptStepKey(attempt, event.step);
    let events = eventsByStep.get(key);
    if (!events) {
      events = [];
      eventsByStep.set(key, events);
    }
    events.push(event);

    if (event.type === 'step' && event.stage === 'observe' && !observeAnchorIndexByStep.has(key)) {
      observeAnchorIndexByStep.set(key, index);
    }
    if (event.type === 'model_plan' && event.stage === 'start') {
      if (!planAnchorIndexByStep.has(key)) planAnchorIndexByStep.set(key, index);
      if (event.models?.length > 1) multiModelSteps.add(key);
      if (event.models?.length === 1) singleModelSteps.add(key);
    }
  }

  return {
    entries,
    eventsByStep,
    firstEventIndexByAttempt,
    observeAnchorIndexByStep,
    planAnchorIndexByStep,
    singleModelSteps,
    multiModelSteps,
    terminalAttempts,
    latestAttempt,
  };
}
