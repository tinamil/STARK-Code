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
  assert.ok(summaries >= 2, `compacted repeatedly (${summaries})`);
  assert.ok(Math.max(...sizes) < 6000 + 1500, `requests stay near the high mark (max ${Math.max(...sizes)})`);
  assert.match(lastSummaryInput, /SUMMARY #\d/, 'later summaries build on the earlier summary');
  assert.match(fs.readFileSync(path.join(root, 'f11.txt'), 'utf8'), /^changed 11/, 'a file still in the conversation can be edited without re-reading');
  assert.ok(posts.some((p) => p.type === 'info' && /Summarized earlier steps/.test(p.text)));
});

test('compaction marks: defaults, window cap, and low mark below high', () => {
  const { agent, cfg } = makeAgent({ base: 'http://127.0.0.1:1/v1', root: tempWorkspace() });
  assert.deepStrictEqual(agent.compactionMarks(cfg), { window: 1000000, high: 50000, low: 10000 });
  assert.deepStrictEqual(agent.compactionMarks({ ...cfg, contextWindow: 32000 }), { window: 32000, high: 22400, low: 10000 });
  assert.deepStrictEqual(agent.compactionMarks({ ...cfg, compactAt: 200000, compactTo: 150000 }), { window: 1000000, high: 200000, low: 100000 });
});
