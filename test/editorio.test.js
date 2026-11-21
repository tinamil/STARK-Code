// editorio against a minimal fake of the VS Code API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createEditorIo } = require('../src/editorio');
const { tempWorkspace } = require('./helpers');

function fakeVscode(docs) {
  const edits = [];
  class Range { constructor(s, e) { this.start = s; this.end = e; } }
  class WorkspaceEdit { constructor() { this.ops = []; } replace(uri, range, text) { this.ops.push({ uri, range, text }); } }
  return {
    edits, Range, WorkspaceEdit,
    workspace: {
      textDocuments: docs,
      async applyEdit(we) {
        for (const op of we.ops) {
          const d = docs.find((x) => x.uri === op.uri);
          d.text = d.text.slice(0, op.range.start) + op.text + d.text.slice(op.range.end);
          d.isDirty = true; edits.push(op);
        }
        return true;
      },
    },
  };
}
function fakeDoc(p, text, dirty = false) {
  const d = { uri: { scheme: 'file', fsPath: p }, text, isDirty: dirty, isClosed: false, saved: 0,
    getText() { return this.text; }, positionAt(o) { return o; },
    async save() { fs.writeFileSync(p, this.text); this.isDirty = false; this.saved++; return true; } };
  d.uri = { scheme: 'file', fsPath: p };
  return d;
}

test('open file: reads the editor buffer (unsaved changes included)', async () => {
  const dir = tempWorkspace({ 'a.js': 'disk version\n' }); const p = path.join(dir, 'a.js');
  const io = createEditorIo(fakeVscode([fakeDoc(p, 'editor version\n', true)]));
  const f = await io.readText(p);
  assert.strictEqual(f.text, 'editor version\n');
  assert.ok(f.dirty);
});
test('open file: edits only the changed span through the editor, then saves', async () => {
  const dir = tempWorkspace({ 'a.js': 'one\ntwo\nthree\n' }); const p = path.join(dir, 'a.js');
  const doc = fakeDoc(p, 'one\ntwo\nthree\n');
  const vs = fakeVscode([doc]);
  const r = await createEditorIo(vs).writeText(p, 'one\nTWO\nthree\n', 'utf8');
  assert.deepStrictEqual(vs.edits.map((e) => [e.range.start, e.range.end, e.text]), [[4, 7, 'TWO']]);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'one\nTWO\nthree\n');
  assert.deepStrictEqual(r, { viaEditor: true, savedUserChanges: false });
});
test('open file with unsaved changes: reported so the agent can say so', async () => {
  const dir = tempWorkspace({ 'a.js': 'x\n' }); const p = path.join(dir, 'a.js');
  const r = await createEditorIo(fakeVscode([fakeDoc(p, 'x user\n', true)])).writeText(p, 'x user agent\n', 'utf8');
  assert.ok(r.savedUserChanges);
});
test('does not split a surrogate pair at the edit boundary', async () => {
  const dir = tempWorkspace({ 'a.txt': '' }); const p = path.join(dir, 'a.txt');
  const doc = fakeDoc(p, 'a😀b');
  const vs = fakeVscode([doc]);
  await createEditorIo(vs).writeText(p, 'a😃b', 'utf8');
  assert.strictEqual(doc.text, 'a😃b');
  assert.strictEqual(vs.edits[0].range.start, 1);
});
test('file not open: written to disk in its encoding', async () => {
  const dir = tempWorkspace(); const p = path.join(dir, 'w.txt');
  await createEditorIo(fakeVscode([])).writeText(p, 'é', 'utf16le');
  assert.ok(fs.readFileSync(p).equals(Buffer.from([0xFF, 0xFE, 0xE9, 0x00])));
});
test('Windows paths match open documents case-insensitively', async () => {
  const io = createEditorIo(fakeVscode([fakeDoc('C:\\Proj\\A.js', 'buffer')]), 'win32');
  assert.strictEqual((await io.readText('c:\\proj\\a.js')).text, 'buffer');
});
