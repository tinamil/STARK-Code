// Keeps eval/ working: the task checkers must fail on an untouched task and pass on its reference
// solution, and the runner must work end to end against a (mock) OpenAI-compatible server.
const test = require('node:test');
const assert = require('node:assert');
const { execFile } = require('child_process');
const path = require('path');
const { mockServer, sseChat, toolCall, tempWorkspace } = require('./helpers');

const run = (args, env, cwd) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(__dirname, '..', 'eval', 'run.js'), ...args], { env: { ...process.env, ...env }, cwd, timeout: 60000 },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
});

test('eval task checkers reject the untouched task and accept the reference solution', async () => {
  const r = await run(['--self-test'], {});
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual((r.out.match(/^ok /gm) || []).length, 5);
});

test('eval runner: runs a task against a model, scores it and writes the results file', async (t) => {
  let n = 0;
  const srv = await mockServer(async (req, body, res) => {
    const script = [toolCall('read_file', { path: 'sum.js' }), toolCall('edit_file', { path: 'sum.js', old_string: 'i < n', new_string: 'i <= n' }), { content: 'Fixed the loop bound.' }];
    const next = script[n++] || { content: 'done' };
    sseChat(res, [next], { finish: next.tool_calls ? 'tool_calls' : 'stop', usage: { prompt_tokens: 1000, completion_tokens: 20 } });
  });
  t.after(srv.close);
  const cwd = tempWorkspace();
  const r = await run(['fix-bug'], { EVAL_BASE_URL: srv.base, EVAL_API_KEY: 'k', EVAL_MODEL: 'mock' }, cwd);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /fix-bug … PASS {2}3 steps, 2 tool calls \(0 failed\), 0 re-reads, 3060 tokens/);
  const saved = JSON.parse(require('fs').readFileSync(path.join(cwd, 'eval-results.json'), 'utf8'));
  assert.deepStrictEqual([saved.model, saved.results[0].pass, saved.results[0].tools], ['mock', true, { read_file: 1, edit_file: 1 }]);
  assert.strictEqual(srv.requests[0].headers.authorization, 'Bearer k');
});

test('eval runner: a wrong result is reported as a failure with the reason', async (t) => {
  const srv = await mockServer(async (req, body, res) => sseChat(res, [{ content: 'Looks fine to me.' }]));
  t.after(srv.close);
  const r = await run(['fix-bug'], { EVAL_BASE_URL: srv.base, EVAL_API_KEY: 'k' }, tempWorkspace());
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /FAIL[\s\S]*tests still fail/);
});
