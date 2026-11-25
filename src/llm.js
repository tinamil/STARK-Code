// Streaming client for OpenAI-compatible endpoints with tool calling.
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
    creditsResetS: num('x-ratelimit-reset-credits-day'),
    tokensLimit: num('x-ratelimit-limit-tokens-minute'),
    tokensRemaining: num('x-ratelimit-remaining-tokens-minute'),
    tokensResetS: num('x-ratelimit-reset-tokens-minute'),
    requestsLimit: num('x-ratelimit-limit-requests-minute'),
    requestsRemaining: num('x-ratelimit-remaining-requests-minute'),
    requestsResetS: num('x-ratelimit-reset-requests-minute'),
    keyExpiresAt: h.get('x-stark-key-expires-at') || undefined,
    keyExpiringSoon: (h.get('x-stark-key-expiring-soon') || '').toLowerCase() === 'true',
  };
  for (const k of Object.keys(meta)) if (meta[k] === undefined || Number.isNaN(meta[k])) delete meta[k];
  return meta;
}

/**
 * STARK locks keys 14 days after creation or unlock and answers 401 with
 * {"error": {"message": "API key locked ...", "unlock_url": "https://..."}}. Returns an LlmError
 * carrying the unlock URL, or null if the body isn't a locked-key error.
 */
function lockedKeyError(bodyText) {
  let j;
  try { j = JSON.parse(bodyText); } catch { return null; }
  const err = (j && j.error) || {};
  const raw = typeof err.unlock_url === 'string' ? err.unlock_url : '';
  if (!raw && !/locked/i.test(String(err.message || ''))) return null;
  const url = /^https:\/\//i.test(raw) ? raw : '';
  const e = new LlmError(`Your API key is locked. STARK locks keys 14 days after they're created or unlocked. ${url ? 'Unlock it, then send "continue".' : 'Unlock it on the API Keys page of the STARK portal, then send "continue".'}`, false);
  e.code = 'key_locked';
  if (url) e.unlockUrl = url;
  return e;
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
    const locked = res.status === 401 ? lockedKeyError(t) : null;
    if (locked) throw locked;
    const hint = res.status === 401 ? ' (the API key is invalid or expired; update it under Setup)' : res.status === 403 ? ' (key lacks scope for this model/endpoint)' : '';
    const err = new LlmError(`HTTP ${res.status}${hint} from ${url}: ${t.slice(0, 2000)}`,
      res.status === 429 || res.status >= 500, parseRetryAfter(res.headers.get('retry-after')));
    err.meta = readMeta(res.headers);
    throw err;
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

// ---------------- models / connection test ----------------
/** Returns [{id, tools}] where tools is true/false if the server reports capabilities, else undefined. */
async function listModels({ baseUrl, apiKey, headers = {} }) {
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const res = await fetch(url, { headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...headers }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw (res.status === 401 && lockedKeyError(t)) || new Error(`HTTP ${res.status}`);
  }
  const j = await res.json();
  const arr = Array.isArray(j) ? j : (j.data || j.models || []);
  return arr.map((m) => (typeof m === 'string' ? { id: m } : {
    id: m.id || m.name,
    tools: m.capabilities && typeof m.capabilities.tools === 'boolean' ? m.capabilities.tools : undefined,
  })).filter((m) => m.id).sort((a, b) => a.id.localeCompare(b.id));
}

async function probeTools(opts) {
  const t0 = Date.now();
  const r = await streamChat({
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
    const r2 = await streamChat({
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

/** Checks reachability, chat, and tool calling. Returns { ok, lines, models, unlockUrl? }. */
async function testConnection(opts) {
  const lines = [];
  const ep = '/chat/completions';
  let models = [];
  try {
    models = await listModels(opts);
    lines.push(`✓ Reached server (${models.length} models listed)`);
    const m = models.find((x) => x.id === opts.model);
    if (opts.model && models.length && !m) lines.push(`⚠ "${opts.model}" is not in the server's model list`);
    if (m && m.tools === false) lines.push(`⚠ The server says "${opts.model}" does not support tool calling`);
  } catch (e) {
    if (e.code === 'key_locked') { lines.push(`✗ ${e.message.replace(/, then send "continue"\./, ', then test again.')}`); return { ok: false, lines, models, unlockUrl: e.unlockUrl }; }
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
    }
    if (meta.creditsRemaining !== undefined) lines.push(`• Credits today: ${meta.creditsRemaining}${meta.creditsLimit !== undefined ? ` / ${meta.creditsLimit}` : ''} remaining`);
    if (meta.tokensLimit !== undefined || meta.requestsLimit !== undefined) {
      lines.push(`• Rate limits: ${[meta.tokensLimit !== undefined ? `${meta.tokensLimit.toLocaleString('en-US')} tokens/minute` : '', meta.requestsLimit !== undefined ? `${meta.requestsLimit} requests/minute` : ''].filter(Boolean).join(', ')}`);
    }
    if (meta.keyExpiringSoon) lines.push(`⚠ API key expires ${meta.keyExpiresAt || 'within 7 days'}`);
    return { ok: p.ok, lines, models };
  } catch (e) {
    if (e.code === 'key_locked') { lines.push(`✗ ${e.message.replace(/, then send "continue"\./, ', then test again.')}`); return { ok: false, lines, models, unlockUrl: e.unlockUrl }; }
    lines.push(`✗ Request to ${ep} failed: ${e.message}`);
    return { ok: false, lines, models };
  }
}

module.exports = { streamChat, listModels, testConnection, readMeta, LlmError };
