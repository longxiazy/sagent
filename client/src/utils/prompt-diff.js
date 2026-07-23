/**
 * prompt-diff — 计算「本轮请求 vs 同模型上一轮请求」的 word 级差异，并折叠相同部分。
 *
 * 纯函数：先做行级对齐（剥离公共前后缀 + 中间 LCS），把连续相同行归为可折叠的 equal 块；
 * 变化的行块内部再做 word 级 LCS，产出 same/add/del 三类内联片段。
 *
 * 返回 { hasPrevious, blocks }：
 *   - { type: 'equal', text }         整段未改动文本（组件按行数决定是否折叠）
 *   - { type: 'change', segments }    变化块；segments = [{ op: 'same'|'add'|'del', value }]
 */

// 空白也作为独立 token 保留，保证 word 级对齐后仍能还原原始排版。
function tokenizeWords(text) {
  return text.match(/\s+|\S+/g) || [];
}

// 通用 LCS 差分：返回 [{ type: 'equal'|'del'|'add', value }]。
// 规模过大时退化为「先全删后全增」，避免 O(n*m) 阻塞渲染线程。
function diffSequences(a, b, { maxProduct = 4_000_000 } = {}) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map(value => ({ type: 'add', value }));
  if (m === 0) return a.map(value => ({ type: 'del', value }));
  if (n * m > maxProduct) {
    return [
      ...a.map(value => ({ type: 'del', value })),
      ...b.map(value => ({ type: 'add', value })),
    ];
  }

  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', value: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', value: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', value: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', value: a[i++] });
  while (j < m) ops.push({ type: 'add', value: b[j++] });
  return ops;
}

// 变化块内相邻同类型 word op 合并，减少 DOM 节点。
function mergeWordSegments(ops) {
  const OP_TO_SEGMENT = { equal: 'same', add: 'add', del: 'del' };
  const segments = [];
  for (const op of ops) {
    const seg = OP_TO_SEGMENT[op.type];
    const last = segments[segments.length - 1];
    if (last && last.op === seg) last.value += op.value;
    else segments.push({ op: seg, value: op.value });
  }
  return segments;
}

export function buildPromptDiff(previousText, currentText, { maxProduct = 4_000_000 } = {}) {
  const current = currentText == null ? '' : String(currentText);
  if (previousText == null || previousText === '') {
    return { hasPrevious: false, blocks: current ? [{ type: 'equal', text: current }] : [] };
  }

  const previous = String(previousText);
  const prevLines = previous.split('\n');
  const currLines = current.split('\n');

  // 公共前缀 / 后缀行：绝大多数 prompt（系统提示、工具签名）逐轮不变，先 O(n) 剥离。
  let head = 0;
  while (head < prevLines.length && head < currLines.length && prevLines[head] === currLines[head]) head++;
  let tailPrev = prevLines.length;
  let tailCurr = currLines.length;
  while (tailPrev > head && tailCurr > head && prevLines[tailPrev - 1] === currLines[tailCurr - 1]) {
    tailPrev--;
    tailCurr--;
  }

  const blocks = [];
  const pushEqual = (lines) => {
    if (lines.length) blocks.push({ type: 'equal', text: lines.join('\n') });
  };

  pushEqual(currLines.slice(0, head));

  const midPrev = prevLines.slice(head, tailPrev);
  const midCurr = currLines.slice(head, tailCurr);
  if (midPrev.length || midCurr.length) {
    const lineOps = diffSequences(midPrev, midCurr, { maxProduct });
    let k = 0;
    while (k < lineOps.length) {
      if (lineOps[k].type === 'equal') {
        const equalLines = [];
        while (k < lineOps.length && lineOps[k].type === 'equal') equalLines.push(lineOps[k++].value);
        pushEqual(equalLines);
      } else {
        const dels = [];
        const adds = [];
        while (k < lineOps.length && lineOps[k].type !== 'equal') {
          if (lineOps[k].type === 'del') dels.push(lineOps[k].value);
          else adds.push(lineOps[k].value);
          k++;
        }
        const wordOps = diffSequences(tokenizeWords(dels.join('\n')), tokenizeWords(adds.join('\n')), { maxProduct });
        blocks.push({ type: 'change', segments: mergeWordSegments(wordOps) });
      }
    }
  }

  pushEqual(currLines.slice(tailCurr));
  return { hasPrevious: true, blocks };
}
