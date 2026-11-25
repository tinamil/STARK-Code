// Small line-based unified diff for approval cards. No dependencies.

/**
 * Diff two texts (oldText may be null for a new file).
 * Returns { adds, dels, hunks: [{ oldStart, newStart, lines: [[op, text]] }], truncated }
 * where op is ' ', '-' or '+'.
 */
function diffLines(oldText, newText, { context = 3, maxLines = 400 } = {}) {
  const toLines = (t) => {
    if (t == null || t === '') return [];
    const l = t.replace(/\r\n/g, '\n').split('\n');
    if (l[l.length - 1] === '') l.pop();   // a trailing newline is not an extra line
    return l;
  };
  const A = toLines(oldText), B = toLines(newText);

  // Common prefix/suffix keep the LCS table small for typical localized edits.
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const a = A.slice(p, A.length - s), b = B.slice(p, B.length - s);

  let mid;
  if (a.length * b.length > 4e6) {
    // Too large for LCS: show the changed region as a replacement.
    mid = [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  } else {
    const n = a.length, m = b.length, W = m + 1;
    const T = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        T[i * W + j] = a[i] === b[j] ? T[(i + 1) * W + j + 1] + 1 : Math.max(T[(i + 1) * W + j], T[i * W + j + 1]);
      }
    }
    mid = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { mid.push([' ', a[i]]); i++; j++; }
      else if (T[(i + 1) * W + j] >= T[i * W + j + 1]) mid.push(['-', a[i++]]);
      else mid.push(['+', b[j++]]);
    }
    while (i < n) mid.push(['-', a[i++]]);
    while (j < m) mid.push(['+', b[j++]]);
  }
  const ops = [...A.slice(0, p).map((l) => [' ', l]), ...mid, ...A.slice(A.length - s).map((l) => [' ', l])];

  let adds = 0, dels = 0;
  for (const [op] of ops) { if (op === '+') adds++; else if (op === '-') dels++; }

  // Group changes into hunks with surrounding context.
  const hunks = [];
  let oldNo = 1, newNo = 1, cur = null, lastChange = -Infinity, shown = 0, truncated = false;
  const lineNos = ops.map(([op]) => {
    const r = [oldNo, newNo];
    if (op !== '+') oldNo++;
    if (op !== '-') newNo++;
    return r;
  });
  const isChange = ops.map(([op]) => op !== ' ');
  const nextChange = new Array(ops.length + 1).fill(Infinity);
  for (let k = ops.length - 1; k >= 0; k--) nextChange[k] = isChange[k] ? k : nextChange[k + 1];
  for (let k = 0; k < ops.length; k++) {
    if (isChange[k]) lastChange = k;
    const near = isChange[k] || k - lastChange <= context || nextChange[k] - k <= context;
    if (!near) { cur = null; continue; }
    if (shown >= maxLines) { truncated = true; break; }
    if (!cur) { cur = { oldStart: lineNos[k][0], newStart: lineNos[k][1], lines: [] }; hunks.push(cur); }
    cur.lines.push(ops[k]);
    shown++;
  }
  // Very long lines (minified files) are shortened for display.
  const MAX_LINE = 500;
  for (const h of hunks) h.lines = h.lines.map(([op, t]) => (t.length > MAX_LINE ? [op, `${t.slice(0, MAX_LINE)}… [${t.length - MAX_LINE} more characters]`] : [op, t]));
  return { adds, dels, hunks, truncated };
}

module.exports = { diffLines };
