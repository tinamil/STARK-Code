const test = require('node:test');
const assert = require('node:assert');
const { diffLines } = require('../src/diff');

const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
const ops = (h) => h.lines.map((l) => l[0]).join('');

test('one changed line gives one hunk with 3 lines of context', () => {
  const d = diffLines(base, base.replace('line 15', 'LINE FIFTEEN'));
  assert.deepStrictEqual([d.adds, d.dels, d.hunks.length], [1, 1, 1]);
  assert.strictEqual(ops(d.hunks[0]), '   -+   ');
  assert.strictEqual(d.hunks[0].oldStart, 12);
});
test('distant changes give separate hunks', () => {
  const d = diffLines(base, base.replace('line 2\n', 'line two\n').replace('line 28', 'line 28\ninserted'));
  assert.deepStrictEqual(d.hunks.map((h) => h.newStart), [1, 26]);
});
test('new file: trailing newline is not an extra line', () => {
  const d = diffLines(null, 'a\nb\n');
  assert.deepStrictEqual([d.adds, d.dels], [2, 0]);
});
test('CRLF vs LF with the same content is no change', () => {
  assert.strictEqual(diffLines('x\r\ny\r\n', 'x\ny\n').hunks.length, 0);
});
test('large diffs are truncated and stay fast', () => {
  const big = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n');
  const d = diffLines(big, big.split('\n').map((l, i) => (i % 2 ? l + '!' : l)).join('\n'), { maxLines: 400 });
  assert.ok(d.truncated);
  assert.strictEqual(d.hunks.reduce((s, h) => s + h.lines.length, 0), 400);
  const t0 = Date.now();
  diffLines(Array.from({ length: 5000 }, (_, i) => 'a' + i).join('\n'), Array.from({ length: 5000 }, (_, i) => 'b' + i).join('\n'));
  assert.ok(Date.now() - t0 < 2000);
});
