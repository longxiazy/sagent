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

// 单次 singleModelPlan 内部可能因解析失败重问、工具协议回退等原因发起多次请求，
// 事件里的 requests 就是这一串。做 diff 的基准取最后一次，即真正产出决策的那次。
function lastRequestOf(event) {
  return Array.isArray(event?.requests) && event.requests.length > 0
    ? event.requests[event.requests.length - 1]
    : null;
}

// 「上一轮请求」按模型各自的时间线回溯：每个模型只与自己的上一次请求做 diff，
// 不同模型之间互不参照。索引阶段一次算清，避免渲染期边遍历边写入共享状态——
// 那样组件读到的会是遍历结束后的终态，而非它在时间线上所处位置的状态。
//
// 产出三份索引，对应三种取值场景：
//   previousRequestByIndex      —— 事件下标 → 基准。多模型时间线上逐条渲染的卡片用。
//   previousRequestByEvent      —— 事件对象 → 基准。单模型步骤渲染在 step 事件上，
//                                  手上只有同 step 的 model_plan 事件而没有它的下标。
//   previousRequestsByAnchorIndex —— start 事件下标 → 该时刻各模型基准的快照。
//
// 注意基准是按模型全局回溯的，不按 attempt 分段：从 checkpoint 重试时，新 attempt
// 首步的基准会是上一个 attempt 的末步。这是当前有意保留的行为（便于对照重试前后
// prompt 的变化），若要改成 attempt 内隔离，在此处按 attempt 切换时清空 seen 即可。
function buildPreviousRequestIndex(entries) {
  const previousRequestByIndex = new Map();
  const previousRequestByEvent = new Map();
  const previousRequestsByAnchorIndex = new Map();
  // model → 该模型最近一次请求；随遍历推进，始终代表"当前位置之前"的状态。
  const seen = new Map();

  for (const { event, index } of entries) {
    if (event?.type !== 'model_plan') continue;

    // 多模型分组整体挂在 start 事件上渲染，而 start 排在同 step 各模型事件之前。
    // 若把 seen 本身传给子组件，等子组件真正读取时遍历早已结束，拿到的是整条
    // trace 的终态——每个模型会与自己的"最后一次"而非"上一步"对比。故在此冻结副本。
    if (event.stage === 'start') {
      previousRequestsByAnchorIndex.set(index, new Map(seen));
      continue;
    }
    if (!event.model) continue;

    // 先取后写：当前事件的基准是它自己之前的那次，不含自身。
    const previous = seen.get(event.model) ?? null;
    previousRequestByIndex.set(index, previous);
    previousRequestByEvent.set(event, previous);
    // 只有真正发出过请求的事件才更新基准（失败事件带 requests 时同样计入，
    // 请求确实发出去了），没有请求的事件跳过，使基准能跨越这些步骤继续指向上一次有效请求。
    const request = lastRequestOf(event);
    if (request != null) seen.set(event.model, request);
  }

  return { previousRequestByIndex, previousRequestByEvent, previousRequestsByAnchorIndex };
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

  const {
    previousRequestByIndex,
    previousRequestByEvent,
    previousRequestsByAnchorIndex,
  } = buildPreviousRequestIndex(entries);

  return {
    entries,
    eventsByStep,
    firstEventIndexByAttempt,
    observeAnchorIndexByStep,
    planAnchorIndexByStep,
    previousRequestByIndex,
    previousRequestByEvent,
    previousRequestsByAnchorIndex,
    singleModelSteps,
    multiModelSteps,
    terminalAttempts,
    latestAttempt,
  };
}
