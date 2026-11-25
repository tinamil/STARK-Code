const test = require('node:test');
const assert = require('node:assert');
const { mockServer, sseChat, makeAgent, tempWorkspace } = require('./helpers');
const { streamChat, testConnection, listModels } = require('../src/llm');

const STARK = { 'X-RateLimit-Limit-Credits-Day': '5000', 'X-RateLimit-Remaining-Credits-Day': '4210', 'X-Stark-Key-Expiring-Soon': 'true', 'X-Stark-Key-Expires-At': '2026-11-25T00:00:00Z' };

test('usage via stream_options; strict gateways get one retry without it', async (t) => {
  let strict = false;
  const srv = await mockServer(async (req, body, res) => {
    if (strict && body.stream_options) { res.writeHead(422); return res.end('{"detail":"Extra inputs are not permitted: stream_options"}'); }
    sseChat(res, [{ content: 'ok' }], { usage: body.stream_options ? { prompt_tokens: 1234, completion_tokens: 5 } : undefined });
  });
  t.after(srv.close);
  const r = await streamChat({ baseUrl: srv.base, model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(r.usage.prompt_tokens, 1234);
  strict = true; srv.requests.length = 0;
  const base2 = srv.base + '/';
  await streamChat({ baseUrl: base2, model: 'm', messages: [] }); await streamChat({ baseUrl: base2, model: 'm', messages: [] });
  assert.deepStrictEqual(srv.requests.map((q) => 'stream_options' in q.body), [true, false, false]);
});

test('429 with Retry-After is retried, and STARK headers are reported', async (t) => {
  let first429 = true;
  const srv = await mockServer(async (req, body, res) => {
    if (first429) { first429 = false; res.writeHead(429, { 'Retry-After': '1' }); return res.end('{}'); }
    sseChat(res, [{ content: 'hello' }], { headers: STARK });
  });
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace() });
  await agent.run('hi');
  assert.strictEqual(agent.messages.at(-1).content, 'hello');
  assert.ok(posts.some((p) => p.type === 'info' && /Rate limited/.test(p.text)));
  assert.deepStrictEqual(posts.find((p) => p.type === 'meta').meta, { creditsLimit: 5000, creditsRemaining: 4210, keyExpiresAt: '2026-11-25T00:00:00Z', keyExpiringSoon: true });
});

test('connection test: round trip, a gateway that drops tools, models without tools', async (t) => {
  let chatDropsTools = true;
  const srv = await mockServer(async (req, body, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200); return res.end(JSON.stringify({ data: [{ id: 'good', capabilities: { tools: true } }, { id: 'tiny', capabilities: { tools: false } }] })); }
    if (chatDropsTools) return sseChat(res, [{ content: 'I would call get_weather.' }]);
    if (body.messages.some((m) => m.role === 'tool')) return sseChat(res, [{ content: 'Sunny' }]);
    sseChat(res, [{ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }], { finish: 'tool_calls' });
  });
  t.after(srv.close);
  let r = await testConnection({ baseUrl: srv.base, model: 'good' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.lines.some((l) => /Tool calling failed via \/chat\/completions: the model answered in text/.test(l)), r.lines.join('\n'));
  chatDropsTools = false;
  r = await testConnection({ baseUrl: srv.base, model: 'good' });
  assert.ok(r.ok, r.lines.join('\n'));
  r = await testConnection({ baseUrl: srv.base, model: 'tiny' });
  assert.ok(r.lines.some((l) => /does not support tool calling/.test(l)));
  assert.deepStrictEqual((await listModels({ baseUrl: srv.base })).map((m) => [m.id, m.tools]), [['good', true], ['tiny', false]]);
});
