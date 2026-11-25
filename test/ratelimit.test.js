const test = require('node:test');
const assert = require('node:assert');
const { mockServer, sseChat, toolCall, tempWorkspace, makeAgent, toolResults } = require('./helpers');
const { readMeta, testConnection } = require('../src/llm');

const limits = (o = {}) => ({
  'X-RateLimit-Limit-Credits-Day': '5000000', 'X-RateLimit-Remaining-Credits-Day': String(o.credits ?? 4000000), 'X-RateLimit-Reset-Credits-Day': '3600',
  'X-RateLimit-Limit-Tokens-Minute': String(o.tpm ?? 500000), 'X-RateLimit-Remaining-Tokens-Minute': String(o.tokensLeft ?? 499000), 'X-RateLimit-Reset-Tokens-Minute': String(o.tokensReset ?? 40),
  'X-RateLimit-Limit-Requests-Minute': '120', 'X-RateLimit-Remaining-Requests-Minute': String(o.requestsLeft ?? 119), 'X-RateLimit-Reset-Requests-Minute': String(o.requestsReset ?? 40),
});

test('parses STARK rate-limit headers', () => {
  const m = readMeta(new Headers(limits()));
  assert.deepStrictEqual([m.tokensLimit, m.tokensRemaining, m.tokensResetS, m.requestsLimit, m.requestsRemaining, m.creditsLimit, m.creditsResetS], [500000, 499000, 40, 120, 119, 5000000, 3600]);
});

test('connection test reports the rate limits', async (t) => {
  const srv = await mockServer(async (req, body, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200); return res.end('{"data":[]}'); }
    if (body.messages.some((m) => m.role === 'tool')) return sseChat(res, [{ content: 'Sunny' }], { headers: limits() });
    sseChat(res, [toolCall('get_weather', { city: 'Paris' })], { finish: 'tool_calls', headers: limits() });
  });
  t.after(srv.close);
  const r = await testConnection({ baseUrl: srv.base, model: 'm' });
  assert.ok(r.lines.some((l) => l === '• Rate limits: 500,000 tokens/minute, 120 requests/minute'), r.lines.join('\n'));
});

test('context window is capped under the tokens-per-minute limit', async (t) => {
  const srv = await mockServer(async (req, body, res) => sseChat(res, [{ content: 'hi' }], { headers: limits({ tpm: 50000 }) }));
  t.after(srv.close);
  const { agent, posts, cfg } = makeAgent({ base: srv.base, root: tempWorkspace() });
  assert.strictEqual(agent.effectiveWindow(cfg), 1000000);
  await agent.run('hello');
  assert.strictEqual(agent.effectiveWindow(cfg), 45000);
  assert.ok(posts.some((p) => p.type === 'info' && /45k-token context window/.test(p.text)));
});

test('waits for the minute to reset instead of sending a request that would exceed it', async (t) => {
  let n = 0;
  const srv = await mockServer(async (req, body, res) => {
    if (n++ === 0) return sseChat(res, [toolCall('list_dir', {})], { finish: 'tool_calls', headers: limits({ tokensLeft: 50, tokensReset: 1 }) });
    sseChat(res, [{ content: 'done' }], { headers: limits() });
  });
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace() });
  const t0 = Date.now();
  await agent.run('go');
  assert.ok(posts.some((p) => p.type === 'info' && /tokens-per-minute limit/.test(p.text)));
  assert.ok(Date.now() - t0 >= 1000, 'waited for the reset');
  assert.strictEqual(agent.messages.at(-1).content, 'done');
});

test('waits when no requests are left this minute', async (t) => {
  let n = 0;
  const srv = await mockServer(async (req, body, res) => {
    if (n++ === 0) return sseChat(res, [toolCall('list_dir', {})], { finish: 'tool_calls', headers: limits({ requestsLeft: 0, requestsReset: 1 }) });
    sseChat(res, [{ content: 'done' }]);
  });
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace() });
  await agent.run('go');
  assert.ok(posts.some((p) => p.type === 'info' && /requests-per-minute limit/.test(p.text)));
});

test('a reopened chat larger than the per-minute limit is summarized instead of retried', async (t) => {
  const srv = await mockServer(async (req, body, res, raw) => {
    if (raw.length > 50000 * 3.5 * 0.9) { res.writeHead(429, { 'Retry-After': '1', ...limits({ tpm: 50000, tokensLeft: 50000 }) }); return res.end('{"error":"rate limited"}'); }
    if (!body.tools) return sseChat(res, [{ content: 'SUMMARY' }], { headers: limits({ tpm: 50000 }) });
    sseChat(res, [{ content: 'continued' }], { headers: limits({ tpm: 50000 }) });
  });
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace() });
  const filler = 'x'.repeat(20000);
  agent.messages = [{ role: 'system', content: 's' }];
  for (let i = 1; i <= 12; i++) agent.messages.push({ role: 'user', content: `q${i} ${filler}`, _turn: i }, { role: 'assistant', content: `a${i} ${filler}` });
  agent.turnCounter = 12;
  await agent.run('next');
  assert.deepStrictEqual(posts.filter((p) => p.type === 'error'), []);
  assert.strictEqual(agent.messages.at(-1).content, 'continued');
  assert.strictEqual(srv.requests.filter((r) => r.raw.length > 50000 * 3.5 * 0.9).length, 1, 'the oversized request is not retried');
});
