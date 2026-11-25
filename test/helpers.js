// Shared test helpers: a scripted mock LLM server, a temp workspace and an Agent wired to both.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/agent');

/** Starts an HTTP server; handler(req, body, res) is async. Returns { base, close, requests }. */
async function mockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', async () => {
      let body = null;
      try { body = b ? JSON.parse(b) : null; } catch { /* not json */ }
      requests.push({ url: req.url, body, raw: b, headers: req.headers });
      try { await handler(req, body, res, b); } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((r) => server.close(r)) };
}

/** Writes an SSE chat-completions stream of the given deltas. */
function sseChat(res, deltas, { finish = 'stop', usage, headers = {} } = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
  for (const d of deltas) res.write(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
  if (usage) res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
}

let n = 0;
/** One tool call as a chat delta. */
function toolCall(name, args, extra = {}) {
  n++;
  return { tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) }, ...extra }] };
}

/** A mock server that answers each tool-enabled request with the next scripted delta. */
async function scriptedModel(script) {
  const queue = [...script];
  const srv = await mockServer(async (req, body, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[{"id":"m"}]}'); }
    if (body && !body.tools) return sseChat(res, [{ content: 'SUMMARY: the conversation so far.' }]);
    const next = queue.shift() || { content: 'done' };
    sseChat(res, [next], { finish: next.tool_calls ? 'tool_calls' : 'stop' });
  });
  srv.queue = queue;
  return srv;
}

function tempWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stark-test-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

/** Agent with a recording UI. approve(req) decides approvals (default: allow). */
function makeAgent({ base, root, config = {}, approve, io } = {}) {
  const posts = [], approvals = [];
  const cfg = { baseUrl: base, model: 'm', approvalMode: 'ask', maxSteps: 20, contextWindow: 1000000, autoApproveCommands: [], ...config };
  const agent = new Agent({
    getConfig: () => cfg, getApiKey: async () => 'test-key', getRoot: () => root, io,
    ui: {
      post: (m) => posts.push(m), log() {}, registerProposal() {},
      approve: async (r) => { approvals.push(r); return approve ? approve(r) : { decision: 'yes' }; },
    },
  });
  return { agent, posts, approvals, cfg };
}

const toolResults = (agent) => agent.messages.filter((m) => m.role === 'tool').map((m) => m.content);

module.exports = { mockServer, sseChat, toolCall, scriptedModel, tempWorkspace, makeAgent, toolResults };
