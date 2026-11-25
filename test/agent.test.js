const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { scriptedModel, mockServer, sseChat, toolCall, tempWorkspace, makeAgent, toolResults } = require('./helpers');

test('tool loop: read, edit, final answer', async (t) => {
  const srv = await scriptedModel([toolCall('read_file', { path: 'a.txt' }), toolCall('edit_file', { path: 'a.txt', old_string: 'v1', new_string: 'v2' }), { content: 'Done.' }]);
  t.after(srv.close);
  const root = tempWorkspace({ 'a.txt': 'v1\n' });
  const { agent } = makeAgent({ base: srv.base, root });
  await agent.run('change it');
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'v2\n');
  assert.strictEqual(agent.messages.at(-1).content, 'Done.');
  assert.ok(!JSON.stringify(srv.requests.map((r) => r.body)).includes('_turn'), 'internal fields must not reach the API');
});

test('editing requires reading the file first', async (t) => {
  const srv = await scriptedModel([toolCall('edit_file', { path: 'a.txt', old_string: 'v1', new_string: 'v2' })]);
  t.after(srv.close);
  const root = tempWorkspace({ 'a.txt': 'v1\n' });
  const { agent } = makeAgent({ base: srv.base, root });
  await agent.run('x');
  assert.match(toolResults(agent)[0], /read .* before modifying/);
});

test('approval card carries the diff, counts and explanation', async (t) => {
  const srv = await scriptedModel([toolCall('read_file', { path: 'login.js' }),
    toolCall('edit_file', { path: 'login.js', old_string: '  if (!user) return false;', new_string: '  if (!user || !pass) return false;', explanation: 'Reject empty passwords.' })]);
  t.after(srv.close);
  const root = tempWorkspace({ 'login.js': 'function login(user, pass) {\n  if (!user) return false;\n}\n' });
  const { agent, approvals } = makeAgent({ base: srv.base, root });
  await agent.run('fix');
  assert.strictEqual(approvals[0].summary, 'Edit login.js (+1 −1)');
  assert.strictEqual(approvals[0].explanation, 'Reject empty passwords.');
  assert.ok(approvals[0].diff.hunks.length === 1);
});

test('denied action stops the turn; feedback is passed to the model', async (t) => {
  const srv = await scriptedModel([toolCall('run_command', { command: 'npm publish' })]);
  t.after(srv.close);
  const { agent } = makeAgent({ base: srv.base, root: tempWorkspace(), approve: () => ({ decision: 'no', feedback: 'not now' }) });
  await agent.run('x');
  assert.match(toolResults(agent)[0], /denied.*not now/);
});

test('a denial is flagged for the panel, and reply text in progress is available for a panel reload', async (t) => {
  let seenWhileStreaming = null, agentRef;
  const srv = await mockServer(async (req, body, res) => {
    if (body.messages.at(-1).role === 'user' && /say/.test(body.messages.at(-1).content)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello wor' } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 150));
      seenWhileStreaming = agentRef.streaming;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ld' } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    sseChat(res, [toolCall('run_command', { command: 'npm publish' })], { finish: 'tool_calls' });
  });
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace(), approve: () => ({ decision: 'no' }) });
  agentRef = agent;
  await agent.run('publish it');
  assert.strictEqual(posts.find((p) => p.type === 'toolResult').denied, true);
  assert.ok(posts.some((p) => p.type === 'info' && p.warn && /You denied that action/.test(p.text)));
  await agent.run('say hello');
  assert.strictEqual(seenWhileStreaming, 'Hello wor');
  assert.strictEqual(agent.streaming, null);
  assert.strictEqual(agent.messages.at(-1).content, 'Hello world');
});

test('rewind restores files across turns, including deleting created files', async (t) => {
  const srv = await scriptedModel([
    toolCall('read_file', { path: 'a.txt' }), toolCall('edit_file', { path: 'a.txt', old_string: 'v1', new_string: 'v2' }), toolCall('write_file', { path: 'b.txt', content: 'new' }), { content: 'ok' },
    toolCall('edit_file', { path: 'a.txt', old_string: 'v2', new_string: 'v3' }), { content: 'ok' }]);
  t.after(srv.close);
  const root = tempWorkspace({ 'a.txt': 'v1\n' });
  const { agent } = makeAgent({ base: srv.base, root });
  await agent.run('one', 'one'); await agent.run('two', 'two');
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'v3\n');
  let r = await agent.revertTo(2);
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'v2\n');
  assert.strictEqual(r.text, 'two');
  r = await agent.revertTo(1);
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'v1\n');
  assert.ok(!fs.existsSync(path.join(root, 'b.txt')));
  assert.strictEqual(agent.messages.length, 1);
});

test('edits keep the file encoding, and rewind restores the exact bytes', async (t) => {
  const original = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('Grüße\r\nzweite Zeile\r\n', 'utf16le')]);
  const cp1252 = Buffer.from([0x43, 0x61, 0x66, 0xE9, 0x20, 0x80, 0x0D, 0x0A]);   // "Café €\r\n"
  const srv = await scriptedModel([toolCall('read_file', { path: 'u16.txt' }), toolCall('edit_file', { path: 'u16.txt', old_string: 'zweite', new_string: 'dritte' }),
    toolCall('read_file', { path: 'w.txt' }), toolCall('edit_file', { path: 'w.txt', old_string: '€', new_string: '€ and “quotes”' }),
    toolCall('edit_file', { path: 'w.txt', old_string: 'Café', new_string: 'Café 😀' })]);
  t.after(srv.close);
  const root = tempWorkspace(); fs.writeFileSync(path.join(root, 'u16.txt'), original); fs.writeFileSync(path.join(root, 'w.txt'), cp1252);
  const { agent } = makeAgent({ base: srv.base, root });
  await agent.run('edit');
  const u16 = fs.readFileSync(path.join(root, 'u16.txt'));
  assert.ok(u16.subarray(0, 2).equals(Buffer.from([0xFF, 0xFE])), 'still UTF-16 LE with BOM');
  assert.strictEqual(u16.subarray(2).toString('utf16le'), 'Grüße\r\ndritte Zeile\r\n');
  assert.ok(fs.readFileSync(path.join(root, 'w.txt')).equals(Buffer.from([0x43, 0x61, 0x66, 0xE9, 0x20, 0x80, 0x20, 0x61, 0x6E, 0x64, 0x20, 0x93, 0x71, 0x75, 0x6F, 0x74, 0x65, 0x73, 0x94, 0x0D, 0x0A])), 'still Windows-1252');
  assert.match(toolResults(agent).at(-1), /Windows-1252/, 'emoji refused instead of corrupting the file');
  await agent.revertTo(1);
  assert.ok(fs.readFileSync(path.join(root, 'u16.txt')).equals(original));
  assert.ok(fs.readFileSync(path.join(root, 'w.txt')).equals(cp1252));
});

test('files over 2 MB are edited but not copied for Rewind, and Rewind says so', async (t) => {
  const big = 'x'.repeat(2.5 * 1024 * 1024) + '\nEND\n';
  const srv = await scriptedModel([toolCall('read_file', { path: 'big.txt', offset: 2, limit: 5 }), toolCall('edit_file', { path: 'big.txt', old_string: 'END', new_string: 'FIN' })]);
  t.after(srv.close);
  const root = tempWorkspace({ 'big.txt': big });
  const { agent } = makeAgent({ base: srv.base, root });
  await agent.run('edit');
  assert.ok(fs.readFileSync(path.join(root, 'big.txt'), 'utf8').endsWith('FIN\n'));
  assert.ok(agent.checkpoints[0].skipped);
  assert.ok(JSON.stringify(agent.toJSON()).length < 100000, 'saved chat stays small');
  const r = await agent.revertTo(1);
  assert.deepStrictEqual(r.skipped.map((p) => path.basename(p)), ['big.txt']);
});

test('file changed while waiting for approval: nothing is written', async (t) => {
  const srv = await scriptedModel([toolCall('read_file', { path: 'a.txt' }), toolCall('edit_file', { path: 'a.txt', old_string: 'v1', new_string: 'v2' })]);
  t.after(srv.close);
  const root = tempWorkspace({ 'a.txt': 'v1\n' });
  const { agent } = makeAgent({ base: srv.base, root, approve: () => { fs.writeFileSync(path.join(root, 'a.txt'), 'v1\nuser edit\n'); return { decision: 'yes' }; } });
  await agent.run('x');
  assert.match(toolResults(agent).at(-1), /changed while waiting/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'v1\nuser edit\n');
});

test('approval rules: read-only commands, newlines, reads outside the workspace, destructive commands', async () => {
  const root = tempWorkspace();
  const { agent, cfg } = makeAgent({ base: 'http://127.0.0.1:1/v1', root, config: { autoApproveCommands: ['git status'] } });
  const { getTool } = require('../src/tools');
  const asks = async (name, args, cfgOver = {}) => {
    const c = { ...cfg, ...cfgOver }; const tool = getTool(name);
    const prep = name === 'run_command' ? { readOnly: await agent.isReadOnlyCommand(args, c, root) } : {};
    return !!agent.needsApproval(tool, args, c, prep, root);
  };
  assert.strictEqual(await asks('run_command', { command: 'git status' }), false);
  assert.strictEqual(await asks('run_command', { command: 'node --version' }), false);
  assert.strictEqual(await asks('run_command', { command: 'git status\npython evil.py' }), true);
  assert.strictEqual(await asks('run_command', { command: 'node --version' }, { autoApproveReadOnlyCommands: false }), true);
  assert.strictEqual(await asks('read_file', { path: 'a.txt' }), false);
  assert.strictEqual(await asks('read_file', { path: '../secret' }), true);
  assert.strictEqual(await asks('read_file', { path: '..foo/x' }), false);
  assert.strictEqual(await asks('run_command', { command: 'rm -rf build' }, { approvalMode: 'auto' }), true);
  assert.strictEqual(await asks('run_command', { command: 'npm test' }, { approvalMode: 'auto' }), false);
});

test('read-only command runs without approval end to end', async (t) => {
  const srv = await scriptedModel([toolCall('run_command', { command: 'node --version' }), toolCall('run_command', { command: 'node -e "process.exit(3)"' })]);
  t.after(srv.close);
  const { agent, approvals } = makeAgent({ base: srv.base, root: tempWorkspace() });
  await agent.run('x');
  assert.deepStrictEqual(approvals.map((a) => a.summary), ['node -e "process.exit(3)"']);
  assert.match(toolResults(agent)[0], /^Exit code: 0\nv\d+/);
  assert.match(toolResults(agent)[1], /^Exit code: 3/);
});

test('New Chat during a run: the stopped run cannot write into the new chat', async (t) => {
  const srv = await scriptedModel([toolCall('run_command', { command: 'npm test' })]);
  t.after(srv.close);
  const { agent } = makeAgent({ base: srv.base, root: tempWorkspace() });
  agent.ui.approve = () => new Promise((res) => agent.abort.signal.addEventListener('abort', () => res({ decision: 'no' })));
  agent.run('go');
  await new Promise((r) => setTimeout(r, 200));
  agent.stop(); await agent.idle(); agent.reset();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(agent.messages.length, 0);
});

test('tool-call-only assistant messages omit content; tool_choice is auto', async (t) => {
  const srv = await mockServer(async (req, body, res) => {
    if (body.messages.some((m) => m.role === 'assistant' && m.tool_calls && m.content === '')) { res.writeHead(400); return res.end('{"error":"empty text parameter"}'); }
    if (body.messages.some((m) => m.role === 'tool')) return sseChat(res, [{ content: 'done' }]);
    sseChat(res, [toolCall('list_dir', {})], { finish: 'tool_calls' });
  });
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace() });
  // A chat saved by an older version has content: "" on a tool-call message.
  agent.messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'x', _turn: 1 },
    { role: 'assistant', content: '', tool_calls: [{ id: 'old', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old', content: '' }, { role: 'assistant', content: 'ok' }];
  agent.turnCounter = 1;
  await agent.run('again');
  assert.deepStrictEqual(posts.filter((p) => p.type === 'error'), []);
  assert.strictEqual(srv.requests.at(-1).body.tool_choice, 'auto');
});

test('Gemini 3 thought signatures are echoed back on the next request', async (t) => {
  let n = 0;
  const srv = await mockServer(async (req, body, res) => {
    for (const m of body.messages) for (const tc of m.tool_calls || []) {
      if (!(tc.extra_content && tc.extra_content.google && tc.extra_content.google.thought_signature === `sig-${tc.id}`)) { res.writeHead(400); return res.end('{"error":{"message":"Function call is missing a thought_signature"}}'); }
    }
    if (n++ === 0) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '' }, extra_content: { google: { thought_signature: 'sig-c1' } } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    sseChat(res, [{ content: 'listed' }]);
  });
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace() });
  await agent.run('list');
  assert.deepStrictEqual(posts.filter((p) => p.type === 'error'), []);
  assert.strictEqual(agent.messages.at(-1).content, 'listed');
});

test('context overflow: learns a smaller limit, summarizes, and finishes', async (t) => {
  let n = 0;
  const srv = await mockServer(async (req, body, res, raw) => {
    if (raw.length > 70000) { res.writeHead(400); return res.end('{"error":{"message":"This model\'s maximum context length is 20000 tokens."}}'); }
    if (!body.tools) return sseChat(res, [{ content: 'SUMMARY' }]);
    if (n < 3) { n++; return sseChat(res, [toolCall('read_file', { path: 'big.txt' })], { finish: 'tool_calls' }); }
    sseChat(res, [{ content: 'All done.' }]);
  });
  t.after(srv.close);
  const root = tempWorkspace({ 'big.txt': ('lorem ipsum dolor sit amet '.repeat(8) + '\n').repeat(900) });
  const { agent, posts } = makeAgent({ base: srv.base, root, config: { maxToolOutputChars: 30000 } });
  await agent.run('read it three times');
  assert.deepStrictEqual(posts.filter((p) => p.type === 'error'), []);
  assert.strictEqual(agent.messages.at(-1).content, 'All done.');
  assert.ok(agent.learnedWindow > 0 && agent.learnedWindow < 1000000);
  assert.strictEqual(srv.requests.filter((r) => r.raw.length > 70000).length, 1, 'the oversized request is sent once');
});

test('/compact summarizes everything, honors focus, and Stop leaves the chat unchanged', async (t) => {
  let slow = false;
  const srv = await mockServer(async (req, body, res) => {
    if (slow) await new Promise((r) => setTimeout(r, 2000));
    if (!body.tools) return sseChat(res, [{ content: 'SUMMARY: read a.txt' }]);
    if (!body.messages.some((m) => m.role === 'tool') && !body.messages.some((m) => /SUMMARY/.test(m.content || ''))) return sseChat(res, [toolCall('read_file', { path: 'a.txt' })], { finish: 'tool_calls' });
    sseChat(res, [{ content: 'ok' }]);
  });
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace({ 'a.txt': 'hello' }) });
  assert.strictEqual(await agent.compactNow(''), false);
  await agent.run('read a.txt');
  assert.ok(await agent.compactNow('keep file contents'));
  assert.strictEqual(agent.messages.length, 3);
  assert.match(srv.requests.at(-1).body.messages[0].content, /keep file contents/);
  assert.ok(posts.some((p) => p.type === 'compacted'));
  await agent.run('next');
  assert.deepStrictEqual(srv.requests.at(-1).body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  slow = true; const before = agent.messages.length;
  const p = agent.compactNow(''); setTimeout(() => agent.stop(), 200); await p;
  assert.strictEqual(agent.messages.length, before);
});

test('locked STARK key: the error carries the unlock link (https only)', async (t) => {
  let url = 'https://portal.example/unlock/k1';
  const srv = await mockServer(async (req, body, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'unauthorized', message: 'API key locked', unlock_url: url } })); });
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace() });
  await agent.run('hi');
  assert.strictEqual(posts.find((p) => p.type === 'error').unlockUrl, url);
  url = 'javascript:alert(1)'; posts.length = 0;
  await agent.run('hi');
  assert.strictEqual(posts.find((p) => p.type === 'error').unlockUrl, undefined);
  assert.match(posts.find((p) => p.type === 'error').text, /API Keys page/);
});

test('panel shows shortened tool arguments; the model and the file get the full content', async (t) => {
  const content = 'x'.repeat(50000);
  const srv = await scriptedModel([toolCall('write_file', { path: 'big.txt', content })]);
  t.after(srv.close);
  const root = tempWorkspace();
  const { agent, posts } = makeAgent({ base: srv.base, root });
  await agent.run('write');
  const shown = posts.find((p) => p.type === 'tool').args.content;
  assert.ok(shown.length < 2100 && /48,000 more characters/.test(shown));
  assert.strictEqual(fs.readFileSync(path.join(root, 'big.txt'), 'utf8').length, 50000);
  assert.strictEqual(JSON.parse(agent.messages.find((m) => m.tool_calls).tool_calls[0].function.arguments).content.length, 50000);
});

test('rolling compaction keeps the conversation between the low and high marks', async (t) => {
  let step = 0; const sizes = []; let summaries = 0; let lastSummaryInput = '';
  const est = (msgs) => Math.ceil(JSON.stringify(msgs).length / 3.5);
  const srv = await mockServer(async (req, body, res) => {
    if (!body.tools) { summaries++; lastSummaryInput = body.messages[1].content; return sseChat(res, [{ content: `SUMMARY #${summaries}: user asked "read the files then fix f0"` }]); }
    sizes.push(est(body.messages));
    if (step < 12) { const i = step++; return sseChat(res, [toolCall('read_file', { path: `f${i}.txt` })], { finish: 'tool_calls' }); }
    if (step++ === 12) return sseChat(res, [toolCall('edit_file', { path: 'f11.txt', old_string: 'marker', new_string: 'changed' })], { finish: 'tool_calls' });
    sseChat(res, [{ content: 'All done.' }]);
  });
  t.after(srv.close);
  const files = {}; for (let i = 0; i < 12; i++) files[`f${i}.txt`] = `marker ${i}\n` + 'some file content here\n'.repeat(120);
  const root = tempWorkspace(files);
  const { agent, posts } = makeAgent({ base: srv.base, root, config: { compactAt: 6000, compactTo: 3000 } });
  await agent.run('read the files then fix f0');
  assert.deepStrictEqual(posts.filter((p) => p.type === 'error'), []);
  assert.strictEqual(agent.messages.at(-1).content, 'All done.');
  assert.ok(Math.max(...sizes) < 6000 + 1500, `requests stay near the high mark (max ${Math.max(...sizes)})`);
  assert.ok(posts.some((p) => p.type === 'info' && /Trimmed old tool output/.test(p.text)), 'old output is trimmed without a model call');
  assert.ok(summaries <= 2, `trimming avoids most summary calls (${summaries})`);
  assert.match(fs.readFileSync(path.join(root, 'f11.txt'), 'utf8'), /^changed 11/, 'a file still in the conversation can be edited without re-reading');
});

test('compaction marks: defaults, window cap, and low mark below high', () => {
  const { agent, cfg } = makeAgent({ base: 'http://127.0.0.1:1/v1', root: tempWorkspace() });
  assert.deepStrictEqual(agent.compactionMarks(cfg), { window: 1000000, high: 50000, low: 10000 });
  assert.deepStrictEqual(agent.compactionMarks({ ...cfg, contextWindow: 32000 }), { window: 32000, high: 22400, low: 10000 });
  assert.deepStrictEqual(agent.compactionMarks({ ...cfg, compactAt: 200000, compactTo: 150000 }), { window: 1000000, high: 200000, low: 100000 });
});

test('trimming: repeated reads, reads of since-changed files, and old large output', async () => {
  const root = tempWorkspace();
  const { agent } = makeAgent({ base: 'http://127.0.0.1:1/v1', root });
  const call = (id, name, args) => ({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const result = (id, content) => ({ role: 'tool', tool_call_id: id, content });
  const big = 'x'.repeat(5000);
  agent.messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'go', _turn: 1 },
    call('1', 'read_file', { path: 'a.js' }), result('1', big),            // read again later -> removed
    call('2', 'read_file', { path: 'b.js' }), result('2', big),            // changed later, old -> removed
    call('3', 'run_command', { command: 'npm test' }), result('3', big),   // old large output -> trimmed
    call('4', 'edit_file', { path: 'b.js', old_string: 'x', new_string: 'y' }), result('4', 'Edited b.js (1 replacement).'),
    call('5', 'read_file', { path: 'a.js' }), result('5', big),            // latest read of a.js -> kept
    call('6', 'read_file', { path: 'c.js' }), result('6', big),            // recent -> kept
    call('7', 'edit_file', { path: 'c.js', old_string: 'x', new_string: 'y' }), result('7', 'Edited c.js (1 replacement).'),
  ];
  const freed = agent.pruneStale(10);   // steps from index 10 on are "recent"
  const c = (id) => agent.messages.find((m) => m.tool_call_id === id).content;
  assert.match(c('1'), /read again later/);
  assert.match(c('2'), /changed after this read/);
  assert.ok(c('3').length < 800 && /Older output trimmed: 4,400 more characters/.test(c('3')));
  assert.strictEqual(c('5'), big);
  assert.strictEqual(c('6'), big, 'a recent read stays even though the file was edited after it');
  assert.ok(freed > 14000);
  agent.rebuildReadFiles();
  const has = (f) => agent.readFiles.has(path.join(root, f));
  assert.deepStrictEqual([has('a.js'), has('b.js'), has('c.js')], [true, false, true], 'b.js must be read again before editing');
  assert.ok(!JSON.stringify(agent.toJSON().messages.map((m) => m.role)).includes('_pruned'));
});

test('summaries keep the user\'s requests, changed files and task list word for word', async (t) => {
  const summaryInputs = [];
  const srv = await mockServer(async (req, body, res) => {
    if (!body.tools) { summaryInputs.push(body.messages[1].content); return sseChat(res, [{ content: `model summary ${summaryInputs.length}` }]); }
    const last = body.messages.at(-1);
    if (last.role === 'user' && /FIRST/.test(last.content)) return sseChat(res, [toolCall('todo_write', { todos: [{ content: 'Add validation', status: 'in_progress' }, { content: 'Write tests', status: 'pending' }] })], { finish: 'tool_calls' });
    if (last.role === 'user' && /SECOND/.test(last.content)) return sseChat(res, [toolCall('write_file', { path: 'src/new.js', content: 'x' })], { finish: 'tool_calls' });
    sseChat(res, [{ content: 'ok ' + 'padding '.repeat(150) }]);
  });
  t.after(srv.close);
  const root = tempWorkspace();
  const { agent } = makeAgent({ base: srv.base, root, config: { compactAt: 2000, compactTo: 1000 } });
  await agent.run('FIRST request: use tabs, never spaces <context>x</context>', 'FIRST request: use tabs, never spaces');
  await agent.run('SECOND request: name the file new.js', 'SECOND request: name the file new.js');
  for (let i = 0; i < 6; i++) await agent.run(`filler ${i}`, `filler ${i}`);
  const summary = agent.messages[1].content;
  assert.ok(summaryInputs.length >= 2, `summarized ${summaryInputs.length} times`);
  assert.match(summary, /1\. FIRST request: use tabs, never spaces\n2\. SECOND request: name the file new\.js/);
  assert.match(summary, /## Files you have changed in this session\n- src\/new\.js/);
  assert.match(summary, /## Task list\n- \[~\] Add validation\n- \[ \] Write tests/);
  assert.match(summary, /## Earlier work\nmodel summary \d/);
  assert.match(summaryInputs.at(-1), /\[earlier summary\]\nmodel summary/, 'later summaries build on the earlier one');
  assert.ok(!/FIRST request/.test(summaryInputs.at(-1)), 'pinned facts are not sent back through the summarizer');
  // Survives save and reload, keeps the chat title, and Rewind drops requests after the rewind point.
  const saved = JSON.parse(JSON.stringify(agent.toJSON()));
  assert.strictEqual(saved.title, 'FIRST request: use tabs, never spaces');
  const { agent: b } = makeAgent({ base: srv.base, root });
  b.load(saved);
  assert.strictEqual(b.pinned.requests[0].text, 'FIRST request: use tabs, never spaces');
  await b.revertTo(2);
  assert.deepStrictEqual(b.pinned.requests.map((r) => r.turn), [1]);
});

test('/compact keeps the pinned facts too', async (t) => {
  const srv = await scriptedModel([{ content: 'hello' }]);
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace() });
  await agent.run('Please keep functions under 20 lines');
  await agent.compactNow('');
  assert.match(agent.messages[1].content, /1\. Please keep functions under 20 lines/);
  assert.match(posts.find((p) => p.type === 'compacted').summary, /exact words/);
});

test('token estimates are calibrated from the gateway\'s real counts', async (t) => {
  const srv = await mockServer(async (req, body, res, raw) => sseChat(res, [{ content: 'ok' }], { usage: { prompt_tokens: Math.round(JSON.stringify(body.messages).length / 2 + JSON.stringify(body.tools).length / 2), completion_tokens: 1 } }));
  t.after(srv.close);
  const { agent } = makeAgent({ base: srv.base, root: tempWorkspace() });
  assert.strictEqual(agent.charsPerToken, 3.5);
  await agent.run('hello');
  assert.ok(Math.abs(agent.charsPerToken - 2) < 0.05, `learned about 2 chars per token (got ${agent.charsPerToken})`);
  const msgs = [{ role: 'user', content: 'x'.repeat(1000) }];
  assert.ok(Math.abs(agent.est(msgs) - JSON.stringify(msgs).length / 2) < 30);
  agent.calibrate(1000, 10);   // too small a sample: ignored
  assert.ok(Math.abs(agent.charsPerToken - 2) < 0.05);
});

test('messages typed while the agent works are delivered between steps', async (t) => {
  let n = 0; let agentRef;
  const srv = await mockServer(async (req, body, res) => {
    n++;
    if (n === 1) { agentRef.enqueue('also update the README <context>x</context>', 'also update the README'); return sseChat(res, [toolCall('list_dir', {})], { finish: 'tool_calls' }); }
    if (n === 2) { agentRef.enqueue('and add a test', 'and add a test'); return sseChat(res, [{ content: 'First part done.' }]); }
    sseChat(res, [{ content: 'All done.' }]);
  });
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace() });
  agentRef = agent;
  await agent.run('fix the bug', 'fix the bug');
  // Request 2 carries the first queued message, after the tool result it followed.
  assert.deepStrictEqual(srv.requests[1].body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.match(srv.requests[1].body.messages.at(-1).content, /also update the README/);
  // The second arrived during the final reply, so the agent kept going instead of stopping.
  assert.strictEqual(srv.requests.length, 3);
  assert.strictEqual(srv.requests[2].body.messages.at(-1).content, 'and add a test');
  assert.strictEqual(agent.messages.at(-1).content, 'All done.');
  const users = posts.filter((p) => p.type === 'user');
  assert.deepStrictEqual(users.map((u) => [u.text, u.turn, !!u.queuedId]), [['fix the bug', 1, false], ['also update the README', 2, true], ['and add a test', 3, true]]);
  assert.ok(!posts.some((p) => p.type === 'queuedLeft'));
});

test('queued messages: removed ones are not sent; unsent ones come back when the agent is stopped', async (t) => {
  let agentRef;
  const srv = await mockServer(async (req, body, res) => {
    const keep = agentRef.enqueue('keep this'); const drop = agentRef.enqueue('drop this');
    agentRef.unqueue(drop);
    sseChat(res, [toolCall('run_command', { command: 'npm publish' })], { finish: 'tool_calls' });
  });
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace(), approve: () => { agentRef.stop(); return { decision: 'no' }; } });
  agentRef = agent;
  await agent.run('go');
  const left = posts.find((p) => p.type === 'queuedLeft');
  assert.strictEqual(left.text, 'keep this');
  assert.deepStrictEqual(agent.queued, []);
  assert.ok(!agent.messages.some((m) => /drop this|keep this/.test(m.content || '')));
});

test('denying an action continues with a queued message instead of stopping', async (t) => {
  let n = 0; let agentRef;
  const srv = await mockServer(async (req, body, res) => {
    if (n++ === 0) return sseChat(res, [toolCall('run_command', { command: 'npm publish' })], { finish: 'tool_calls' });
    sseChat(res, [{ content: 'OK, using pnpm.' }]);
  });
  t.after(srv.close);
  const { agent } = makeAgent({ base: srv.base, root: tempWorkspace(), approve: () => { agentRef.enqueue('use pnpm instead'); return { decision: 'no' }; } });
  agentRef = agent;
  await agent.run('publish');
  assert.strictEqual(agent.messages.at(-1).content, 'OK, using pnpm.');
  assert.deepStrictEqual(srv.requests[1].body.messages.slice(-2).map((m) => m.role), ['tool', 'user']);
});

test('a running command streams its output to the panel before it finishes', async (t) => {
  const srv = await scriptedModel([toolCall('run_command', { command: `node -e "console.log('first'); setTimeout(() => console.log('second'), 500)"` })]);
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace(), config: { approvalMode: 'auto', shell: process.platform === 'win32' ? 'cmd.exe' : '' } });
  await agent.run('run it');
  const types = posts.map((p) => p.type);
  const firstLive = types.indexOf('toolOutput'), result = types.indexOf('toolResult');
  assert.ok(firstLive > -1 && firstLive < result, 'live output arrives before the result');
  assert.match(posts.filter((p) => p.type === 'toolOutput').map((p) => p.text).join(''), /first/);
  assert.match(posts[result].output, /first[\s\S]*second/);
});

test('Stop during the slow read-only check: no approval prompt is shown and the run ends', async (t) => {
  const srv = await scriptedModel([toolCall('run_command', { command: 'npm test' })]);
  t.after(srv.close);
  const { agent, approvals } = makeAgent({ base: srv.base, root: tempWorkspace() });
  // Stand-in for the PowerShell analysis taking a while (it does on Windows).
  agent.isReadOnlyCommand = async () => { await new Promise((r) => setTimeout(r, 300)); return false; };
  const run = agent.run('go');
  await new Promise((r) => setTimeout(r, 150));
  agent.stop();
  await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('run did not end after Stop')), 5000))]);
  assert.strictEqual(approvals.length, 0);
  assert.strictEqual(agent.busy, false);
});
