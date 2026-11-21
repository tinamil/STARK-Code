// File I/O that goes through VS Code's editor for files that are open, so the agent sees unsaved
// changes, its edits land in the editor's undo history (Ctrl+Z), and nothing is overwritten
// behind the editor's back. Files that aren't open use plain file I/O (src/textfile.js).
const textfile = require('./textfile');

const isHigh = (c) => c >= 0xD800 && c <= 0xDBFF;
const isLow = (c) => c >= 0xDC00 && c <= 0xDFFF;

function createEditorIo(vscode, platform = process.platform) {
  const key = (p) => (platform === 'win32' ? p.toLowerCase() : p);
  const findOpenDoc = (p) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && !d.isClosed && key(d.uri.fsPath) === key(p));

  return {
    async readText(p) {
      const doc = findOpenDoc(p);
      if (!doc) return textfile.readText(p);
      let encoding = 'utf8';
      try { const disk = await textfile.readText(p); if (!disk.binary) encoding = disk.encoding; } catch { /* unsaved new file */ }
      return { text: doc.getText(), encoding, open: true, dirty: doc.isDirty };
    },

    async writeText(p, text, encoding) {
      const doc = findOpenDoc(p);
      if (!doc) { await textfile.writeText(p, text, encoding); return {}; }
      const wasDirty = doc.isDirty;
      const old = doc.getText();
      if (old !== text) {
        // Replace only the changed span, so the undo step and the user's cursor stay local.
        let s = 0;
        while (s < old.length && s < text.length && old.charCodeAt(s) === text.charCodeAt(s)) s++;
        if (s > 0 && isHigh(old.charCodeAt(s - 1))) s--;
        let e = 0;
        while (e < old.length - s && e < text.length - s && old.charCodeAt(old.length - 1 - e) === text.charCodeAt(text.length - 1 - e)) e++;
        if (e > 0 && isLow(old.charCodeAt(old.length - e))) e--;
        const range = new vscode.Range(doc.positionAt(s), doc.positionAt(old.length - e));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, range, text.slice(s, text.length - e));
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code rejected the edit.');
      }
      // Save so builds and tests see the change. VS Code keeps the file's own encoding.
      if (!(await doc.save())) throw new Error('VS Code could not save the file.');
      return { viaEditor: true, savedUserChanges: wasDirty };
    },
  };
}

module.exports = { createEditorIo };
