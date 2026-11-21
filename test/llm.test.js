const test = require('node:test');
const assert = require('node:assert');
const { mockServer, sseChat, makeAgent, tempWorkspace } = require('./helpers');
const { streamChat, testConnection, listModels } = require('../src/llm');

const sse = (res, events, headers = {}) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
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

test('Responses API: streamed tool call, 429 Retry-After, STARK headers, stateless input', async (t) => {
  let first429 = true, step = 0;
  const srv = await mockServer(async (req, body, res) => {
    if (first429) { first429 = false; res.writeHead(429, { 'Retry-After': '1' }); return res.end('{}'); }
    if (step++ === 0) return sse(res, [
      { type: 'response.output_text.delta', delta: 'Reading. ' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc', call_id: 'call_r', name: 'read_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc', output_index: 1, delta: '{"path":"a.txt"}' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 9, output_tokens: 1 } } }], STARK);
    sse(res, [{ type: 'response.output_text.delta', delta: 'It says hello.' }, { type: 'response.completed', response: { status: 'completed' } }], STARK);
  });
  t.after(srv.close);
  const { agent, posts } = makeAgent({ base: srv.base, root: tempWorkspace({ 'a.txt': 'hello\n' }), config: { apiMode: 'responses' } });
  await agent.run('what does a.txt say?');
  assert.strictEqual(agent.messages.at(-1).content, 'It says hello.');
  assert.ok(posts.some((p) => p.type === 'info' && /Rate limited/.test(p.text)));
  assert.deepStrictEqual(posts.find((p) => p.type === 'meta').meta, { creditsLimit: 5000, creditsRemaining: 4210, keyExpiresAt: '2026-11-25T00:00:00Z', keyExpiringSoon: true });
  const second = srv.requests.at(-1).body;
  assert.strictEqual(second.store, false);
  assert.deepStrictEqual(second.input.map((i) => i.type || i.role), ['user', 'assistant', 'function_call', 'function_call_output']);
});

test('connection test: round trip, fallback to the other API, models without tools', async (t) => {
  let chatDropsTools = true;
  const srv = await mockServer(async (req, body, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200); return res.end(JSON.stringify({ data: [{ id: 'good', capabilities: { tools: true } }, { id: 'tiny', capabilities: { tools: false } }] })); }
    if (req.url.endsWith('/responses')) {
      if (body.input.some((i) => i.type === 'function_call_output')) return sse(res, [{ type: 'response.output_text.delta', delta: 'Sunny' }, { type: 'response.completed', response: { status: 'completed' } }]);
      return sse(res, [{ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'f', call_id: 'c', name: 'get_weather', arguments: '{"city":"Paris"}' } }, { type: 'response.completed', response: { status: 'completed' } }]);
    }
    if (chatDropsTools) return sseChat(res, [{ content: 'I would call get_weather.' }]);
    if (body.messages.some((m) => m.role === 'tool')) return sseChat(res, [{ content: 'Sunny' }]);
    sseChat(res, [{ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }], { finish: 'tool_calls' });
  });
  t.after(srv.close);
  let r = await testConnection({ apiMode: 'chat', baseUrl: srv.base, model: 'good' });
  assert.strictEqual(r.suggestMode, 'responses');
  chatDropsTools = false;
  r = await testConnection({ apiMode: 'chat', baseUrl: srv.base, model: 'good' });
  assert.ok(r.ok, r.lines.join('\n'));
  r = await testConnection({ apiMode: 'chat', baseUrl: srv.base, model: 'tiny' });
  assert.ok(r.lines.some((l) => /does not support tool calling/.test(l)));
  assert.deepStrictEqual((await listModels({ baseUrl: srv.base })).map((m) => [m.id, m.tools]), [['good', true], ['tiny', false]]);
});
