// Streaming client for OpenAI-compatible endpoints with tool calling.
// Supports /chat/completions ("chat" mode) and /responses ("responses" mode).
// Both return the same shape: { content, reasoning, toolCalls[], finishReason, usage, meta }.

class LlmError extends Error {
  constructor(msg, retryable, retryAfter) { super(msg); this.retryable = retryable; this.retryAfter = retryAfter; }
}

/** Gateway metadata from response headers (STARK-style rate-limit / key-expiry headers). */
function readMeta(h) {
  const num = (k) => { const v = h.get(k); return v == null || v === '' ? undefined : Number(v); };
  const meta = {
    creditsLimit: num('x-ratelimit-limit-credits-day'),
    creditsRemaining: num('x-ratelimit-remaining-credits-day'),
    creditsUsed: num('x-ratelimit-credits-used'),
    keyExpiresAt: h.get('x-stark-key-expires-at') || undefined,
    keyExpiringSoon: (h.get('x-stark-key-expiring-soon') || '').toLowerCase() === 'true',
  };
  for (const k of Object.keys(meta)) if (meta[k] === undefined || Number.isNaN(meta[k])) delete meta[k];
  return meta;
}

function parseRetryAfter(v) {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isNaN(n)) return n;
  const d = Date.parse(v);
  return Number.isNaN(d) ? undefined : Math.max(0, (d - Date.now()) / 1000);
}

async function post(url, body, { apiKey, headers = {}, signal }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal && signal.aborted) throw e;
    throw new LlmError(`Request to ${url} failed: ${e.cause?.message || e.message}`, true);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const hint = res.status === 401 ? ' (check the API key)' : res.status === 403 ? ' (key lacks scope for this model/endpoint)' : '';
    throw new LlmError(`HTTP ${res.status}${hint} from ${url}: ${t.slice(0, 2000)}`,
      res.status === 429 || res.status >= 500, parseRetryAfter(res.headers.get('retry-after')));
  }
  return res;
}

/** Reads an SSE body, calling onEvent(eventName, json). Returns raw text if the body wasn't SSE. */
async function readSse(res, onEvent) {
  const decoder = new TextDecoder();
  let buf = '', raw = '', sawData = false, event = null;
  const handleLine = (line) => {
    line = line.replace(/\r$/, '');
    if (line === '') { event = null; return; }
    if (line.startsWith('event:')) { event = line.slice(6).trim(); return; }
    if (!line.startsWith('data:')) return;
    sawData = true;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    onEvent(j.type || event, j);
  };
  for await (const chunk of res.body) {
    const s = decoder.decode(chunk, { stream: true });
    if (!sawData) raw += s;
    buf += s;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  if (buf) handleLine(buf);
  return sawData ? null : raw;
}

function deepMerge(a, b) {
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object' || Array.isArray(b)) return b;
  const o = { ...a };
  for (const k of Object.keys(b)) o[k] = deepMerge(a[k], b[k]);
  return o;
}

function finalize(out) {
  out.toolCalls = out.toolCalls.filter(Boolean).filter((t) => t.function.name);
  out.toolCalls.forEach((t, i) => { if (!t.id) t.id = `call_${Date.now()}_${i}`; });
  return out;
}

// ---------------- /chat/completions ----------------
const NO_STREAM_OPTIONS = new Set();   // chat URLs that rejected stream_options
async function streamChat(opts) {
  const { baseUrl, apiKey, model, messages, tools, signal, onText, onReasoning,
    extraBody = {}, headers = {}, maxTokens, temperature } = opts;

  const body = { model, messages, stream: true, ...extraBody };
  if (tools && tools.length) { body.tools = tools; if (!('tool_choice' in extraBody)) body.tool_choice = 'auto'; }
  if (maxTokens) body.max_tokens = maxTokens;
  if (typeof temperature === 'number') body.temperature = temperature;

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  // Ask for token usage in the final stream chunk. Strict gateways may reject the unknown field:
  // then retry once without it and remember not to send it to this server again.
  const useStreamOptions = !NO_STREAM_OPTIONS.has(url) && !('stream_options' in extraBody);
  if (useStreamOptions) body.stream_options = { include_usage: true };
  let res;
  try {
    res = await post(url, body, { apiKey, headers, signal });
  } catch (e) {
    // Retry only when the error points at the field itself, not at any 400 (e.g. context overflow).
    if (!useStreamOptions || !/^HTTP (400|422)\b/.test(e.message) ||
      !/stream_options|include_usage|extra (inputs|fields)|unrecognized|unknown (field|parameter|argument)|additional propert/i.test(e.message)) throw e;
    delete body.stream_options;
    res = await post(url, body, { apiKey, headers, signal });
    NO_STREAM_OPTIONS.add(url);
  }

  const out = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null, meta: readMeta(res.headers) };
  const applyMessage = (m) => {
    if (m.content) { out.content += m.content; onText && onText(m.content); }
    const r = m.reasoning_content || m.reasoning;
    if (typeof r === 'string' && r) { out.reasoning += r; onReasoning && onReasoning(r); }
    for (const tc of m.tool_calls || []) {
      const idx = typeof tc.index === 'number' ? tc.index : out.toolCalls.length;
      let cur = out.toolCalls[idx];
      if (!cur) cur = out.toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) cur.id = tc.id;
      const fn = tc.function || {};
      if (fn.name && fn.name !== cur.function.name) cur.function.name += fn.name;
      if (fn.arguments != null) {
        cur.function.arguments += typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
      }
      // Keep provider-specific fields (e.g. Gemini 3's extra_content.google.thought_signature).
      // They must be sent back unchanged on the next request or the provider rejects the call.
      for (const k of Object.keys(tc)) {
        if (k === 'index' || k === 'id' || k === 'type' || k === 'function') continue;
        cur[k] = deepMerge(cur[k], tc[k]);
      }
    }
  };
  const raw = await readSse(res, (_, j) => {
    if (j.error) throw new LlmError(`Stream error: ${JSON.stringify(j.error)}`, false);
    if (j.usage) out.usage = j.usage;
    const ch = j.choices && j.choices[0];
    if (!ch) return;
    if (ch.delta) applyMessage(ch.delta);
    else if (ch.message) applyMessage(ch.message);
    if (ch.finish_reason) out.finishReason = ch.finish_reason;
  });
  if (raw !== null && raw.trim()) {   // server ignored stream:true
    let j;
    try { j = JSON.parse(raw); } catch { throw new LlmError(`Unexpected response: ${raw.slice(0, 500)}`, false); }
    if (j.error) throw new LlmError(`API error: ${JSON.stringify(j.error)}`, false);
    const ch = j.choices && j.choices[0];
    if (ch && ch.message) applyMessage(ch.message);
    out.finishReason = ch && ch.finish_reason;
    out.usage = j.usage || null;
  }
  return finalize(out);
}

// ---------------- /responses ----------------
/** Convert chat-format history to Responses API instructions + input items (stateless, store:false). */
function toResponsesInput(messages) {
  const instructions = [];
  const input = [];
  for (const m of messages) {
    if (m.role === 'system') instructions.push(m.content);
    else if (m.role === 'user') input.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const tc of m.tool_calls || []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
      }
    } else if (m.role === 'tool') input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content) });
  }
  return { instructions: instructions.join('\n\n') || undefined, input };
}

async function streamResponses(opts) {
  const { baseUrl, apiKey, model, messages, tools, signal, onText, onReasoning,
    extraBody = {}, headers = {}, maxTokens, temperature } = opts;
  const { instructions, input } = toResponsesInput(messages);
  const body = { model, input, stream: true, store: false, ...extraBody };
  if (instructions) body.instructions = instructions;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
  }
  if (maxTokens) body.max_output_tokens = maxTokens;
  if (typeof temperature === 'number') body.temperature = temperature;

  const url = baseUrl.replace(/\/+$/, '') + '/responses';
  const res = await post(url, body, { apiKey, headers, signal });
  const out = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null, meta: readMeta(res.headers) };
  const byItem = new Map();   // item id / output_index -> tool call
  const callFor = (item, idx) => {
    const key = item && item.id ? item.id : `idx${idx}`;
    let c = byItem.get(key) || (idx != null ? byItem.get(`idx${idx}`) : undefined);
    if (!c) {
      c = { id: '', type: 'function', function: { name: '', arguments: '' } };
      byItem.set(key, c); if (idx != null) byItem.set(`idx${idx}`, c);
      out.toolCalls.push(c);
    }
    return c;
  };
  const applyFinal = (r) => {
    if (!r) return;
    if (r.usage) out.usage = { prompt_tokens: r.usage.input_tokens, completion_tokens: r.usage.output_tokens, total_tokens: r.usage.total_tokens };
    if (r.status === 'incomplete') out.finishReason = (r.incomplete_details && r.incomplete_details.reason) === 'max_output_tokens' ? 'length' : 'incomplete';
    else if (r.status) out.finishReason = r.status === 'completed' ? 'stop' : r.status;
    if (r.status === 'failed') throw new LlmError(`Response failed: ${JSON.stringify(r.error || {})}`, false);
  };
  const applyItem = (item, idx) => {
    if (item.type === 'function_call') {
      const c = callFor(item, idx);
      c.id = item.call_id || c.id; c.function.name = item.name || c.function.name;
      if (typeof item.arguments === 'string' && item.arguments) c.function.arguments = item.arguments;
    }
  };

  const raw = await readSse(res, (type, j) => {
    switch (type) {
      case 'response.output_text.delta':
        out.content += j.delta; onText && onText(j.delta); break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        out.reasoning += j.delta; onReasoning && onReasoning(j.delta); break;
      case 'response.output_item.added':
      case 'response.output_item.done':
        if (j.item) applyItem(j.item, j.output_index); break;
      case 'response.function_call_arguments.delta': {
        const c = callFor({ id: j.item_id }, j.output_index); c.function.arguments += j.delta; break;
      }
      case 'response.function_call_arguments.done': {
        const c = callFor({ id: j.item_id }, j.output_index); if (typeof j.arguments === 'string') c.function.arguments = j.arguments; break;
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed':
        applyFinal(j.response); break;
      case 'error':
        throw new LlmError(`Stream error: ${JSON.stringify(j.error || j)}`, false);
    }
  });

  if (raw !== null && raw.trim()) {   // non-streaming JSON response
    let r;
    try { r = JSON.parse(raw); } catch { throw new LlmError(`Unexpected response: ${raw.slice(0, 500)}`, false); }
    if (r.error) throw new LlmError(`API error: ${JSON.stringify(r.error)}`, false);
    (r.output || []).forEach((item, i) => {
      if (item.type === 'message') {
        for (const c of item.content || []) if (c.type === 'output_text' && c.text) { out.content += c.text; onText && onText(c.text); }
      } else applyItem(item, i);
    });
    applyFinal(r);
  }
  // Some servers report status "completed" even when they stop to call tools.
  if (out.toolCalls.length && out.finishReason === 'stop') out.finishReason = 'tool_calls';
  return finalize(out);
}

/** Dispatch on opts.apiMode ('chat' | 'responses'). */
function complete(opts) {
  return opts.apiMode === 'responses' ? streamResponses(opts) : streamChat(opts);
}

// ---------------- models / connection test ----------------
/** Returns [{id, tools}] where tools is true/false if the server reports capabilities, else undefined. */
async function listModels({ baseUrl, apiKey, headers = {} }) {
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const res = await fetch(url, { headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...headers }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const arr = Array.isArray(j) ? j : (j.data || j.models || []);
  return arr.map((m) => (typeof m === 'string' ? { id: m } : {
    id: m.id || m.name,
    tools: m.capabilities && typeof m.capabilities.tools === 'boolean' ? m.capabilities.tools : undefined,
  })).filter((m) => m.id).sort((a, b) => a.id.localeCompare(b.id));
}

async function probeTools(opts) {
  const t0 = Date.now();
  const r = await complete({
    ...opts,
    messages: [{ role: 'user', content: 'Call the get_weather tool for the city "Paris". Respond only with the tool call.' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    signal: AbortSignal.timeout(90000),
  });
  const tc = r.toolCalls[0];
  let ok = false;
  if (tc && tc.function.name === 'get_weather') {
    try { ok = /paris/i.test(JSON.parse(tc.function.arguments || '{}').city || ''); } catch { /* bad json */ }
  }
  const res = { ok, secs: ((Date.now() - t0) / 1000).toFixed(1), why: tc ? 'returned a malformed tool call' : 'answered in text instead of calling the tool', meta: r.meta };
  if (!ok) return res;
  // Second step: send the tool result back, as the agent does on every step. This catches gateways
  // that drop tool messages and providers that need fields echoed back (e.g. Gemini thought signatures).
  try {
    const r2 = await complete({
      ...opts,
      messages: [
        { role: 'user', content: 'Call the get_weather tool for the city "Paris". Respond only with the tool call.' },
        { role: 'assistant', ...(r.content ? { content: r.content } : {}), tool_calls: r.toolCalls },
        ...r.toolCalls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: c.id === tc.id ? 'Sunny, 21°C' : 'n/a' })),
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
      signal: AbortSignal.timeout(90000),
    });
    res.roundTrip = !!(r2.content || r2.toolCalls.length);
    if (!res.roundTrip) res.roundTripError = 'the model returned an empty reply after the tool result';
  } catch (e) {
    res.roundTrip = false; res.roundTripError = e.message.slice(0, 300);
  }
  res.ok = res.roundTrip;
  return res;
}

/** Checks reachability, chat, and tool calling. Returns { ok, lines, models, suggestMode? }. */
async function testConnection(opts) {
  const lines = [];
  const mode = opts.apiMode === 'responses' ? 'responses' : 'chat';
  const ep = mode === 'responses' ? '/responses' : '/chat/completions';
  let models = [];
  try {
    models = await listModels(opts);
    lines.push(`✓ Reached server (${models.length} models listed)`);
    const m = models.find((x) => x.id === opts.model);
    if (opts.model && models.length && !m) lines.push(`⚠ "${opts.model}" is not in the server's model list`);
    if (m && m.tools === false) lines.push(`⚠ The server says "${opts.model}" does not support tool calling`);
  } catch (e) {
    lines.push(`• Could not list models (${e.cause?.message || e.message}). Some servers don't support this.`);
  }
  if (!opts.model) { lines.push('✗ No model set'); return { ok: false, lines, models }; }
  let meta = {};
  try {
    const p = await probeTools(opts);
    meta = p.meta || {};
    lines.push(`✓ ${ep} works (${p.secs}s)`);
    if (p.ok) lines.push('✓ Tool calling works (call and result round trip)');
    else {
      if (p.roundTrip === false) {
        lines.push('✓ The model calls tools');
        lines.push(`✗ Sending the tool result back via ${ep} failed: ${p.roundTripError}. The agent can't take more than one step until this works.`);
      } else lines.push(`✗ Tool calling failed via ${ep}: the model ${p.why}.`);
      // Try the other API before giving up — some gateways only pass tools through one of them.
      const other = mode === 'chat' ? 'responses' : 'chat';
      const otherEp = other === 'responses' ? '/responses' : '/chat/completions';
      try {
        const q = await probeTools({ ...opts, apiMode: other });
        if (q.ok) {
          lines.push(`✓ Tool calling works via ${otherEp}. Switch "API" to "${other}".`);
          if (meta.keyExpiringSoon) lines.push(`⚠ API key expires ${meta.keyExpiresAt || 'within 7 days'}`);
          return { ok: false, lines, models, suggestMode: other };
        }
        lines.push(`✗ Also failed via ${otherEp}${q.roundTripError ? ` (${q.roundTripError.slice(0, 150)})` : ''}. The model or gateway may not support multi-step tool calling.`);
      } catch (e) { lines.push(`• ${otherEp} not usable: ${e.message.slice(0, 200)}`); }
    }
    if (meta.creditsRemaining !== undefined) lines.push(`• Credits today: ${meta.creditsRemaining}${meta.creditsLimit !== undefined ? ` / ${meta.creditsLimit}` : ''} remaining`);
    if (meta.keyExpiringSoon) lines.push(`⚠ API key expires ${meta.keyExpiresAt || 'within 7 days'}`);
    return { ok: p.ok, lines, models };
  } catch (e) {
    lines.push(`✗ Request to ${ep} failed: ${e.message}`);
    return { ok: false, lines, models };
  }
}

module.exports = { complete, streamChat, streamResponses, toResponsesInput, listModels, testConnection, readMeta, LlmError };
