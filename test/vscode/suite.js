// Runs inside VS Code's extension host. Exercises the parts that need the real VS Code API:
// activation, commands, settings, the secret store, the panel host, edits through the editor,
// approvals from the keyboard commands, panel-reload replay and saved chats.
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { mockServer, sseChat, toolCall } = require('../helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

exports.run = async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = path.join(root, 'a.txt');
  const cfg = vscode.workspace.getConfiguration('starkCode');
  const setCfg = (k, v) => vscode.workspace.getConfiguration('starkCode').update(k, v, vscode.ConfigurationTarget.Global);

  const ext = vscode.extensions.getExtension('local.oai-agent');
  assert.ok(ext, 'the extension is installed in the test instance');
  const { provider } = await ext.activate();
  const posts = [];
  const post = provider.post.bind(provider);
  provider.post = (m) => { posts.push(m); post(m); };
  const lastOf = (type) => posts.filter((p) => p.type === type).at(-1);

  // A scripted model: each test sets `script` to the replies it wants, in order.
  let script = [];
  const srv = await mockServer(async (req, body, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[{"id":"test-model","capabilities":{"tools":true}}]}'); }
    if (body && !body.tools) return sseChat(res, [{ content: 'summary' }]);
    const next = script.shift() || { content: 'done' };
    sseChat(res, [next], { finish: next.tool_calls ? 'tool_calls' : 'stop' });
  });

  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  test('activation: commands, settings defaults and the panel view', async () => {
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['oaiAgent.open', 'oaiAgent.setApiKey', 'oaiAgent.newChat', 'oaiAgent.stop', 'oaiAgent.approve', 'oaiAgent.deny']) assert.ok(cmds.includes(c), `command ${c}`);
    assert.strictEqual(cfg.get('baseUrl'), 'https://api.genai.mil/v1');
    assert.strictEqual(cfg.get('contextWindow'), 1000000);
    assert.deepStrictEqual([cfg.get('compactAt'), cfg.get('compactTo')], [50000, 10000]);
    await vscode.commands.executeCommand('oaiAgent.open');
    await until(() => provider.view && provider.view.visible, 'the panel to open');
    assert.match(provider.view.webview.html, /id="pendingBar"/);
    assert.match(provider.view.webview.html, /Content-Security-Policy/);
  });

  test('settings saved under the old oaiAgent prefix are moved to starkCode', async () => {
    assert.strictEqual(vscode.workspace.getConfiguration('starkCode').inspect('commandTimeoutMs').globalValue, 54321);
    assert.strictEqual(vscode.workspace.getConfiguration('oaiAgent').inspect('commandTimeoutMs').globalValue, undefined, 'the old setting is removed');
  });

  test('setup: settings are saved, the key goes to the secret store, the connection test runs', async () => {
    await provider.onMessage({ type: 'saveSetup', baseUrl: srv.base, model: 'test-model', apiKey: 'secret-key-123', contextWindow: 1000000, approvalMode: 'autoEdit', compactAt: 150000, compactTo: 30000 });
    await until(() => vscode.workspace.getConfiguration('starkCode').get('compactTo') === 30000, 'the memory preset');
    assert.deepStrictEqual([vscode.workspace.getConfiguration('starkCode').get('compactAt'), vscode.workspace.getConfiguration('starkCode').get('approvalMode')], [150000, 'autoEdit']);
    await setCfg('compactAt', undefined); await setCfg('compactTo', undefined); await setCfg('approvalMode', undefined);
    await until(() => vscode.workspace.getConfiguration('starkCode').get('model') === 'test-model', 'the model setting');
    assert.strictEqual(vscode.workspace.getConfiguration('starkCode').get('baseUrl'), srv.base);
    assert.strictEqual(await provider.getKey(), 'secret-key-123');
    assert.strictEqual(vscode.workspace.getConfiguration('starkCode').inspect('contextWindow').globalValue, undefined, 'an unchanged context window is not stored');
    script = [toolCall('get_weather', { city: 'Paris' }), { content: 'Sunny' }];
    await provider.onMessage({ type: 'testSetup', baseUrl: srv.base, model: 'test-model' });
    const r = lastOf('testResult');
    assert.ok(r.ok, r.lines.join('\n'));
    assert.strictEqual(srv.requests.filter((q) => q.url.endsWith('/chat/completions')).at(-1).headers.authorization, 'Bearer secret-key-123');
    await until(() => (lastOf('config') || {}).model === 'test-model', 'the model dropdown to update');
  });

  test('edits go through the editor: unsaved text is read, the edit is saved and Ctrl+Z undoes it', async () => {
    await setCfg('approvalMode', 'auto');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'USER '));
    assert.ok(doc.isDirty);
    script = [toolCall('read_file', { path: 'a.txt' }), toolCall('edit_file', { path: 'a.txt', old_string: 'two', new_string: 'TWO', explanation: 'Uppercase.' }), { content: 'Edited.' }];
    await provider.onMessage({ type: 'send', text: 'uppercase two', includeContext: true });
    const msgs = provider.agent.messages;
    assert.match(msgs.find((m) => m.role === 'user').content, /<context>Active file in editor: a\.txt/);
    assert.match(msgs.find((m) => m.role === 'tool').content, /USER one/, 'the agent read the unsaved editor text');
    assert.strictEqual(doc.getText(), 'USER one\nTWO\nthree\n');
    assert.strictEqual(doc.isDirty, false, 'the file was saved');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'USER one\nTWO\nthree\n');
    assert.match(msgs.filter((m) => m.role === 'tool').at(-1).content, /unsaved changes in the editor; they were saved too/);
    assert.ok(lastOf('toolDiff'), 'the panel got the diff');
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(doc.getText(), 'USER one\ntwo\nthree\n', 'undo reverts only the agent edit');
    await vscode.commands.executeCommand('redo');
    await doc.save();
  });

  test('approval from the keyboard commands, and a reloaded panel gets everything back', async () => {
    await setCfg('approvalMode', 'ask');
    await until(() => vscode.workspace.getConfiguration('starkCode').get('approvalMode') === 'ask', 'the approval setting');
    script = [toolCall('write_file', { path: 'new.txt', content: 'hello\n', explanation: 'Add a file.' }), { content: 'Created.' }];
    const run = provider.onMessage({ type: 'send', text: 'create new.txt', includeContext: false });
    await until(() => provider.pending.size === 1, 'the approval prompt');
    assert.strictEqual(lastOf('approval').summary, 'Create new.txt (+1 −0)');
    assert.ok(!fs.existsSync(path.join(root, 'new.txt')), 'nothing is written before approval');
    // The panel reloads while the prompt is waiting.
    posts.length = 0;
    await provider.onMessage({ type: 'ready' });
    const types = posts.map((p) => p.type);
    assert.strictEqual(types[0], 'clear');
    for (const t of ['user', 'tool', 'status', 'approval', 'config']) assert.ok(types.includes(t), `replay includes ${t}`);
    assert.strictEqual(lastOf('status').busy, true);
    assert.ok(posts.filter((p) => p.type === 'user').some((p) => p.text === 'uppercase two') && posts.some((p) => p.type === 'user' && p.text === 'create new.txt'));
    await vscode.commands.executeCommand('oaiAgent.approve');
    await run;
    assert.strictEqual(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'hello\n');
    assert.strictEqual(provider.pending.size, 0);
    assert.strictEqual(lastOf('status').busy, false);
    // Denying from the keyboard command.
    script = [toolCall('write_file', { path: 'other.txt', content: 'x' })];
    const run2 = provider.onMessage({ type: 'send', text: 'create other.txt', includeContext: false });
    await until(() => provider.pending.size === 1, 'the second prompt');
    await vscode.commands.executeCommand('oaiAgent.deny');
    await run2;
    assert.ok(!fs.existsSync(path.join(root, 'other.txt')));
    assert.strictEqual(lastOf('toolResult').denied, true);
  });

  test('chats are saved, listed, reloaded and a new chat starts clean', async () => {
    const id = provider.agent.chatId;
    let items = await provider.listChats();
    assert.deepStrictEqual(items.map((c) => [c.id, c.title, c.current]), [[id, 'uppercase two', true]]);
    await vscode.commands.executeCommand('oaiAgent.newChat');
    await until(() => provider.agent.messages.length === 0, 'the new chat');
    assert.notStrictEqual(provider.agent.chatId, id);
    posts.length = 0;
    await provider.onMessage({ type: 'loadChat', id });
    assert.strictEqual(provider.agent.chatId, id);
    assert.ok(posts.some((p) => p.type === 'user' && p.text === 'create new.txt'), 'the transcript is replayed');
    assert.deepStrictEqual(provider.agent.changedSince(1).map((p) => path.basename(p)).sort(), ['a.txt', 'new.txt']);
    await provider.onMessage({ type: 'deleteChat', id });
    items = await provider.listChats();
    assert.ok(!items.some((c) => c.id === id));
  });

  const failures = [];
  for (const t of tests) {
    try {
      await Promise.race([t.fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('test timed out after 60s')), 60000))]);
      console.log(`ok - ${t.name}`);
    } catch (e) {
      failures.push(t.name);
      console.error(`not ok - ${t.name}\n${e && e.stack ? e.stack : e}`);
    }
  }
  await srv.close().catch(() => {});
  console.log(`# vscode tests: ${tests.length - failures.length} passed, ${failures.length} failed`);
  if (failures.length) throw new Error(`${failures.length} VS Code test(s) failed: ${failures.join('; ')}`);
};
