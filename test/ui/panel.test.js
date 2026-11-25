// Panel tests: the real webview code in headless Chromium. Skipped when Playwright isn't installed,
// unless REQUIRE_UI=1 (CI).
const test = require('node:test');
const assert = require('node:assert');
const { openPanel, closeBrowser, skip } = require('./harness');
const { diffLines } = require('../../src/diff');

test.after(closeBrowser);
const ui = (name, fn) => test(name, { skip }, async () => {
  const p = await openPanel();
  try { await fn(p); assert.deepStrictEqual(p.errors, [], 'no script errors in the panel'); } finally { await p.close(); }
});
const config = { type: 'config', model: 'model-a', baseUrl: 'https://x/v1', approvalMode: 'ask', apiMode: 'chat', models: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'tiny', noTools: true }] };
const approval = (id, extra = {}) => ({ type: 'approval', id, name: 'run_command', summary: 'npm test', allowAlways: true, ...extra });
const tool = (id, name = 'run_command', args = { command: 'npm test' }) => ({ type: 'tool', id, name, args });
const big = Array.from({ length: 400 }, (_, i) => `line ${i} of output`).join('\n');

ui('sending: Enter sends, /compact is a command, model dropdown shows names', async ({ page, send, sent }) => {
  await send(config);
  assert.deepStrictEqual(await page.$$eval('#model option', (o) => o.map((x) => x.textContent)), ['model-a', 'model-b', 'tiny (no tools)']);
  await page.fill('#input', 'fix the bug'); await page.press('#input', 'Enter');
  await page.fill('#input', '/compact keep the API notes'); await page.press('#input', 'Enter');
  await page.fill('#input', 'please /compact this'); await page.press('#input', 'Enter');
  await page.selectOption('#model', 'model-b');
  assert.deepStrictEqual(await sent(), [
    { type: 'send', text: 'fix the bug', includeContext: true }, { type: 'compact', focus: 'keep the API notes' },
    { type: 'send', text: 'please /compact this', includeContext: true }, { type: 'setModel', model: 'model-b' }]);
});

ui('approval card: Allow is focused; Enter allows, Esc denies, feedback denies with a message', async ({ page, send, sent }) => {
  await page.focus('#input');
  await send(tool('a')); await send(approval('a'));
  assert.strictEqual(await page.evaluate(() => document.activeElement.dataset.a), 'yes');
  await page.keyboard.press('Enter');
  await send(tool('b')); await send(approval('b'));
  await page.keyboard.press('Escape');
  await send(tool('c')); await send(approval('c'));
  await page.fill('.approval .fb', 'use pnpm'); await page.press('.approval .fb', 'Enter');
  assert.deepStrictEqual(await sent(), [
    { type: 'approve', id: 'a', decision: 'yes', feedback: '' }, { type: 'approve', id: 'b', decision: 'no', feedback: '' },
    { type: 'approve', id: 'c', decision: 'no', feedback: 'use pnpm' }]);
  assert.strictEqual(await page.locator('.approval').count(), 0);
});

ui('keys outside the card never answer a prompt', async ({ page, send, sent }) => {
  await send(tool('r', 'read_file', { path: 'a.js' })); await send({ type: 'toolResult', id: 'r', ok: true, output: big });
  await send(tool('d')); await send(approval('d', { summary: 'rm -rf build', warning: 'Potentially destructive command.', allowAlways: false }));
  await page.click('.tool >> nth=0 >> summary'); await page.keyboard.press('Escape');
  await page.click('.tool >> nth=0 >> pre.out'); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  assert.deepStrictEqual(await sent(), []);
  assert.strictEqual(await page.locator('.approval').count(), 1);
  assert.strictEqual(await page.locator('.approval [data-a="always"]').count(), 0, 'no "always allow" on dangerous prompts');
});

ui('a waiting prompt that is out of view shows the bar; nothing pending hides it', async ({ page, send }) => {
  assert.strictEqual(await page.isVisible('#pendingBar'), false, 'hidden with nothing pending');
  for (let i = 0; i < 6; i++) { await send(tool('r' + i, 'read_file', { path: `f${i}.js` })); await send({ type: 'toolResult', id: 'r' + i, ok: true, output: big }); }
  await send(tool('c')); await send(approval('c'));
  assert.strictEqual(await page.isVisible('#pendingBar'), false, 'hidden while the card is visible');
  for (let i = 0; i < 4; i++) await page.click(`.tool >> nth=${i} >> summary`);
  await page.evaluate(() => { document.getElementById('log').scrollTop = 0; });
  await page.waitForFunction(() => !document.getElementById('pendingBar').hidden);
  assert.strictEqual(await page.isVisible('#pendingBar'), true);
  const top = await page.evaluate(() => document.getElementById('log').scrollTop);
  await send({ type: 'info', text: 'new output' });
  assert.strictEqual(await page.evaluate(() => document.getElementById('log').scrollTop), top, 'reading position is kept');
  await page.click('#pendingBar');
  await page.waitForFunction(() => document.getElementById('pendingBar').hidden);
  assert.strictEqual(await page.evaluate(() => document.activeElement.dataset.a), 'yes');
  await send({ type: 'approvalDone', id: 'c' });
  assert.strictEqual(await page.isVisible('#pendingBar'), false);
});

ui('edit approval shows the diff and explanation; finished edit keeps them; denial is marked', async ({ page, send }) => {
  const diff = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
  await send(tool('e', 'edit_file', { path: 'src/x.js' }));
  await send({ type: 'approval', id: 'e', name: 'edit_file', summary: 'Edit src/x.js (+2 −1)', canDiff: true, allowAlways: true, explanation: 'Uppercase b and add d.', diff });
  assert.strictEqual(await page.textContent('.approval .q'), 'Edit src/x.js (+2 −1)?');
  assert.strictEqual(await page.textContent('.approval .why'), 'Uppercase b and add d.');
  assert.deepStrictEqual([await page.locator('.approval .dl.add').count(), await page.locator('.approval .dl.del').count()], [2, 1]);
  await send({ type: 'approvalDone', id: 'e' });
  await send({ type: 'toolDiff', id: 'e', diff, summary: 'Edit src/x.js (+2 −1)', explanation: 'Uppercase b and add d.' });
  await send({ type: 'toolResult', id: 'e', ok: true, output: 'Edited src/x.js (1 replacement).' });
  assert.strictEqual(await page.textContent('.tool .arg'), 'src/x.js (+2 −1)');
  assert.strictEqual(await page.locator('.tool .diff').count(), 1);
  await send(tool('n')); await send({ type: 'toolResult', id: 'n', ok: false, denied: true, output: 'The user denied this action.' });
  await send({ type: 'toolResult', id: 'n', ok: false, denied: true, output: 'The user denied this action.' });
  assert.strictEqual(await page.locator('.tool.denied .badge').count(), 1);
});

ui('streaming text renders markdown safely; a bad message is reported and later ones still work', async ({ page, send }) => {
  await send({ type: 'assistantStart' });
  await send({ type: 'delta', text: 'Use `x` and **bold** <img src=x onerror=alert(1)>\n\n```js\nconst a = "<b>";\n```' });
  await send({ type: 'assistantEnd' });
  assert.strictEqual(await page.locator('.msg.assistant img').count(), 0, 'HTML from the model is escaped');
  assert.strictEqual(await page.textContent('.msg.assistant pre code'), 'const a = "<b>";\n');
  await send({ type: 'config' });
  await send({ type: 'info', text: 'still working' });
  assert.match(await page.textContent('.msg.error'), /Display problem \(config\)/);
  assert.match(await page.textContent('#log'), /still working/);
  // remove the expected error so the "no script errors" check only sees unexpected ones
});

ui('setup: model picker lists names under the field, filters, and is keyboard driven', async ({ page, send, sent }) => {
  await send({ type: 'setup', baseUrl: 'https://x/v1', model: '', hasKey: true, apiMode: 'chat', contextWindow: 1000000 });
  await send({ type: 'setupModels', models: [{ id: 'gemini-flash', tools: false }, { id: 'gemini-flash-withtools', tools: true }, { id: 'gemini-lite-withtools', tools: true }] });
  await page.click('#sModel');
  assert.deepStrictEqual(await page.$$eval('#sList .cname', (o) => o.map((x) => x.textContent)), ['gemini-flash-withtools', 'gemini-lite-withtools', 'gemini-flash']);
  const field = await page.locator('#sModel').boundingBox(), list = await page.locator('#sList').boundingBox();
  assert.ok(list.y >= field.y + field.height - 1 && Math.abs(list.x - field.x) < 4, 'the list sits directly under the field');
  await page.type('#sModel', 'lite');
  assert.deepStrictEqual(await page.$$eval('#sList .cname', (o) => o.map((x) => x.textContent)), ['gemini-lite-withtools']);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.strictEqual(await page.inputValue('#sModel'), 'gemini-lite-withtools');
  assert.strictEqual(await page.isVisible('#sList'), false);
  await page.fill('#sModel', 'gemini-flash'); await page.evaluate(() => document.activeElement.blur());
  assert.match(await page.textContent('#sHint'), /does not support tool calling/);
  await sent();
  await page.click('#sSave');
  assert.deepStrictEqual((await sent()).map((m) => [m.type, m.model, m.apiMode]), [['saveSetup', 'gemini-flash', 'chat']]);
  await send({ type: 'testResult', ok: false, lines: ['✗ Your API key is locked.'], unlockUrl: 'https://portal.example/unlock/1' });
  await send({ type: 'testResult', ok: false, lines: ['✗ Your API key is locked.'], unlockUrl: 'https://portal.example/unlock/1' });
  assert.strictEqual(await page.locator('#panel .unlock button').count(), 1);
  await page.click('#panel .unlock button');
  assert.deepStrictEqual(await sent(), [{ type: 'openUnlock', url: 'https://portal.example/unlock/1' }]);
});

ui('history, rewind, todos, compaction notice and the limits footer', async ({ page, send, sent }) => {
  await send({ type: 'history', items: [{ id: '1', title: 'Fix login', updated: Date.now(), current: true }, { id: '2', title: 'Add export', updated: Date.now() - 86400000 }] });
  await page.click('.hitem >> nth=1 >> .ht'); await page.click('.hitem >> nth=0 >> .hdel');
  await send({ type: 'panelClose' });
  await send({ type: 'user', text: 'Fix the login bug', turn: 3 });
  await page.hover('.msg.user'); await page.click('.rewind');
  assert.deepStrictEqual(await sent(), [{ type: 'loadChat', id: '2' }, { type: 'deleteChat', id: '1' }, { type: 'revert', turn: 3 }]);
  await send({ type: 'todos', todos: [{ content: 'Find bug', status: 'completed' }, { content: 'Fix it', status: 'in_progress' }] });
  assert.strictEqual(await page.locator('#todos .todo').count(), 2);
  await send({ type: 'compacted', summary: 'kept facts', before: 52000, after: 9000 });
  assert.match(await page.textContent('.compacted'), /52k → 9k/);
  await send({ type: 'usage', usage: { prompt_tokens: 7400 }, window: 1000000 });
  await send({ type: 'meta', meta: { creditsRemaining: 400000, creditsLimit: 5000000, tokensRemaining: 480000, tokensLimit: 500000 } });
  assert.strictEqual(await page.textContent('#usage'), '7k / 1000k ctx · 400,000 / 5,000,000 credits');
  assert.match(await page.getAttribute('#usage', 'title'), /Tokens this minute: 480,000 of 500,000 left/);
  assert.match(await page.textContent('#log'), /Less than 10% of today's credits left/);
});

ui('while the agent works: Enter queues a message, the button stops, queued messages can be removed or handed back', async ({ page, send, sent }) => {
  await send({ type: 'status', busy: true });
  assert.strictEqual(await page.textContent('#send'), 'Stop');
  assert.match(await page.getAttribute('#input', 'placeholder'), /Add instructions while the agent works/);
  await page.fill('#input', ''); await page.press('#input', 'Enter');
  await page.fill('#input', 'also update the README'); await page.press('#input', 'Enter');
  assert.deepStrictEqual(await sent(), [{ type: 'queue', text: 'also update the README', includeContext: true }]);
  assert.strictEqual(await page.inputValue('#input'), '');
  await send({ type: 'queued', id: 'q1', text: 'also update the README' });
  await send({ type: 'queued', id: 'q2', text: 'second note' });
  await send({ type: 'queued', id: 'q3', text: 'third note' });
  assert.strictEqual(await page.locator('.msg.queued').count(), 3);
  await page.click('.msg.queued >> nth=1 >> .qx');
  assert.deepStrictEqual(await sent(), [{ type: 'unqueue', id: 'q2' }]);
  await send({ type: 'user', text: 'also update the README', turn: 2, queuedId: 'q1' });
  assert.strictEqual(await page.locator('.msg.queued').count(), 1);
  assert.strictEqual(await page.locator('.msg.user:not(.queued)').count(), 1);
  await page.fill('#input', 'draft');
  await send({ type: 'queuedLeft', ids: ['q3'], text: 'third note' });
  assert.strictEqual(await page.locator('.msg.queued').count(), 0);
  assert.strictEqual(await page.inputValue('#input'), 'draft\n\nthird note');
  await page.click('#send');
  assert.deepStrictEqual(await sent(), [{ type: 'stop' }]);
  await send({ type: 'status', busy: false });
  assert.strictEqual(await page.textContent('#send'), 'Send');
  assert.match(await page.getAttribute('#input', 'placeholder'), /Ask the agent/);
});

ui('a running command shows its latest output, replaced by the result when it finishes', async ({ page, send }) => {
  await send(tool('c', 'run_command', { command: 'npm test' }));
  await send({ type: 'toolOutput', id: 'c', text: 'Running 12 tests\n' });
  await send({ type: 'toolOutput', id: 'c', text: '\u001b[32m✓\u001b[0m login works\n' });
  assert.strictEqual(await page.isVisible('.tool .live'), true);
  assert.strictEqual(await page.textContent('.tool .live'), 'Running 12 tests\n✓ login works\n');
  await send({ type: 'toolOutput', id: 'c', text: 'x'.repeat(5000) });
  assert.strictEqual((await page.textContent('.tool .live')).length, 3000);
  await send({ type: 'toolResult', id: 'c', ok: true, output: 'Exit code: 0\nall passed' });
  assert.strictEqual(await page.locator('.tool .live').count(), 0);
  assert.strictEqual(await page.textContent('.tool .out'), 'Exit code: 0\nall passed');
});
