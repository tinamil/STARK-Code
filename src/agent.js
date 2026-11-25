const fs = require('fs');
const path = require('path');
const { streamChat } = require('./llm');
const { toolDefs, getTool, truncate, resolvePath } = require('./tools');
const { buildSystemPrompt } = require('./prompt');
const { diffLines } = require('./diff');
const readonly = require('./readonly');
const textfile = require('./textfile');
const { RateLimits, isContextOverflow } = require('./limits');
const { Compaction } = require('./compaction');

/** Copy a mixin class's methods onto a class. */
function mixin(target, source) {
  for (const k of Object.getOwnPropertyNames(source.prototype)) if (k !== 'constructor') target.prototype[k] = source.prototype[k];
}

// Rewind keeps a copy of each file before the agent first changes it in a turn; larger files are not copied.
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const psreadonly = require('./psreadonly');
const { resolveShell } = require('./shell');

const DEFAULT_CHARS_PER_TOKEN = 3.5;
// Strip internal fields (prefixed with _) before sending to the API.
// Also drop empty content on tool-call-only assistant messages (chats saved by older versions have "").
const forApi = (msgs) => msgs.map((m) => {
  const o = {};
  for (const k in m) if (k[0] !== '_') o[k] = m[k];
  if (o.role === 'assistant' && o.tool_calls && o.tool_calls.length && !o.content) delete o.content;
  return o;
});

// Commands that always require approval, regardless of mode or "always allow".
const DANGER = [
  /\brm\s+(-\S*[rRf]|--recursive|--force)/, /\bgit\s+push\b.*(\s-f\b|--force)/, /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\b.*\s-\S*f/, /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, /\bgit\s+branch\s+-D\b/,
  /\bgit\s+(rebase|filter-branch|stash\s+(drop|clear))\b/, /\bdrop\s+(table|database|schema)\b/i, /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i, /\bmkfs\b/, /\bdd\s+.*\bof=/, /\b(shutdown|reboot|halt)\b/, /\bdel\s+.*\/[sq]\b/i,
  /\b(rmdir|rd)\s+.*\/s\b/i, /Remove-Item\b.*-Recurse/i, /\bformat\s+[a-z]:/i, /\bch(mod|own)\s+-R\b/, /\bsudo\b/,
  /:\(\)\s*\{/, />\s*\/dev\/sd/, /\bkubectl\s+delete\b/, /\bterraform\s+(destroy|apply)\b/, /\b(npm|yarn|pnpm)\s+publish\b/,
  /\bdocker\s+(system\s+prune|rm|rmi|volume\s+rm)\b/, /\b(curl|wget)\b.*\|\s*(sudo\s+)?(ba|z)?sh\b/,
];
const isDangerous = (cmd) => DANGER.some((re) => re.test(cmd));
const isOutside = (root, p) => { const r = path.relative(root, p); return r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r); };

/**
 * ui: { post(msg), approve({id,name,summary,canDiff}) -> Promise<{decision:'yes'|'no'|'always', feedback?}>,
 *       registerProposal(id, {path,newContent}), log(text) }
 */
class Agent {
  /** io: { readText(path), writeText(path, text, encoding) }; defaults to plain file I/O (src/textfile.js). */
  constructor({ getConfig, getApiKey, getRoot, ui, io }) {
    this.getConfig = getConfig; this.getApiKey = getApiKey; this.getRoot = getRoot; this.ui = ui;
    this.io = io || textfile;
    this.charsPerToken = DEFAULT_CHARS_PER_TOKEN;   // calibrated from the gateway's real token counts
    this.limits = null;       // latest gateway rate-limit headers (per key, kept across chats)
    this.limitsAt = 0;
    this.capNoticeShown = false;
    this.reset();
  }

  reset() {
    this.messages = [];
    this.checkpoints = [];   // {turn, path, before: string|null}
    this.turnCounter = 0;
    this.chatId = `${Date.now()}`;
    this.created = Date.now();
    this.readFiles = new Set();
    this.learnedWindow = 0;    // lower limit discovered from a context-overflow error, for this chat
    this.pinned = { requests: [], todos: null };   // kept word for word across summaries
    this.title = '';
    this.sessionAllowed = new Set();
    this.busy = false;
    this.abort = null;
    this.streaming = null;
    this.queued = [];          // messages typed while the agent works: {id, text, display}
  }

  /** Add a message while the agent is working; it is delivered after the current step. */
  enqueue(text, display) {
    const id = `q${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    this.queued.push({ id, text, display: display || text });
    return id;
  }
  unqueue(id) { this.queued = this.queued.filter((q) => q.id !== id); }

  /**
   * Deliver everything queued as one new user turn (several messages are joined with a blank line).
   * Only called between steps, when every tool call has its result.
   */
  takeQueued() {
    if (!this.queued.length) return false;
    const batch = this.queued.splice(0);
    const display = batch.map((q) => q.display).join('\n\n');
    this.turn = ++this.turnCounter;
    this.messages.push({ role: 'user', content: batch.map((q) => q.text).join('\n\n'), _turn: this.turn, _display: display });
    this.ui.post({ type: 'user', text: display, turn: this.turn, queuedIds: batch.map((q) => q.id) });
    return true;
  }

  stop() { if (this.abort) this.abort.abort(); }

  toJSON() {
    return { id: this.chatId, created: this.created, updated: Date.now(), root: this.getRoot(),
      title: this.title || '(untitled)', messages: this.messages,
      checkpoints: this.checkpoints, turnCounter: this.turnCounter, pinned: this.pinned };
  }

  load(d) {
    this.reset();
    this.chatId = d.id; this.created = d.created; this.messages = d.messages || [];
    this.checkpoints = d.checkpoints || []; this.turnCounter = d.turnCounter || 0;
    this.pinned = d.pinned || { requests: [], todos: null };
    this.title = d.title && d.title !== '(untitled)' ? d.title : '';
    // Refresh the system prompt (environment/date/project instructions may have changed).
    if (this.messages[0] && this.messages[0].role === 'system') this.messages[0].content = buildSystemPrompt(this.getRoot(), this.getConfig());
  }

  /** Files changed since (and including) the given user turn. */
  changedSince(turn) {
    return [...new Set(this.checkpoints.filter((c) => c.turn >= turn).map((c) => c.path))];
  }

  /** Restore files to their state before `turn` and rewind the conversation to just before that message. */
  async revertTo(turn) {
    if (this.busy) throw new Error('Stop the agent before rewinding.');
    const cps = this.checkpoints.filter((c) => c.turn >= turn);
    const restored = new Set(), skipped = new Set();
    for (const c of cps.slice().reverse()) {
      if (c.skipped) { skipped.add(c.path); continue; }
      if (c.before === null) { try { await fs.promises.unlink(c.path); } catch { /* already gone */ } }
      else if (c.bytes) { await fs.promises.mkdir(path.dirname(c.path), { recursive: true }); await fs.promises.writeFile(c.path, Buffer.from(c.bytes, 'base64')); }
      else await this.io.writeText(c.path, c.before, c.encoding || 'utf8');
      restored.add(c.path);
      skipped.delete(c.path);
    }
    this.checkpoints = this.checkpoints.filter((c) => c.turn < turn);
    this.pinned.requests = this.pinned.requests.filter((r) => r.turn < turn);
    const idx = this.messages.findIndex((m) => m.role === 'user' && m._turn === turn);
    let text = '', rewound = false;
    if (idx > 0) { text = this.messages[idx]._display || ''; this.messages = this.messages.slice(0, idx); rewound = true; }
    else this.messages.push({ role: 'user', content: '[The user reverted all file changes made since an earlier point (now summarized). Re-read files before editing.]' }, { role: 'assistant', content: 'Noted.' });
    this.readFiles.clear();
    return { files: [...restored], skipped: [...skipped].filter((p) => !restored.has(p)), text, rewound };
  }

  /** Resolves once any in-flight run has fully finished. */
  async idle() { if (this.running) await this.running.catch(() => {}); }

  run(userText, displayText) {
    if (this.busy) return Promise.resolve();
    this.running = this._run(userText, displayText);
    return this.running;
  }

  async _run(userText, displayText) {
    if (this.busy) return;
    this.busy = true;
    this.abort = new AbortController();
    this.ui.post({ type: 'status', busy: true });
    const cfg = this.getConfig();
    const root = this.getRoot();
    try {
      if (!cfg.model) throw new Error('No model configured. Set "oaiAgent.model" in Settings.');
      if (!this.messages.length) this.messages.push({ role: 'system', content: buildSystemPrompt(root, cfg) });
      this.turn = ++this.turnCounter;
      this.messages.push({ role: 'user', content: userText, _turn: this.turn, _display: displayText || userText });
      if (!this.title) this.title = String(displayText || userText).slice(0, 80);
      this.ui.post({ type: 'user', text: displayText || userText, turn: this.turn });
      await this.loop(cfg, root);
    } catch (e) {
      if (this.abort.signal.aborted) this.ui.post({ type: 'info', text: 'Stopped.' });
      else this.ui.post({ type: 'error', text: String(e.message || e), unlockUrl: e.unlockUrl });
    } finally {
      this.busy = false;
      // Messages still queued (stopped, failed, or step limit): hand them back to the input box.
      const left = this.queued.splice(0);
      if (left.length) this.ui.post({ type: 'queuedLeft', ids: left.map((q) => q.id), text: left.map((q) => q.display).join('\n\n') });
      this.ui.post({ type: 'status', busy: false });
    }
  }

  async callModel(cfg, messages, withTools, onText, onReasoning) {
    const apiKey = await this.getApiKey();
    for (let attempt = 0; ; attempt++) {
      let streamed = false;
      try {
        const sent = forApi(messages);
        const sentChars = JSON.stringify(sent).length + (withTools ? JSON.stringify(toolDefs()).length : 0);
        await this.throttle(Math.ceil(sentChars / this.charsPerToken));
        const r = await streamChat({
          baseUrl: cfg.baseUrl, apiKey, model: cfg.model, messages: sent,
          tools: withTools ? toolDefs() : undefined,
          signal: this.abort.signal,
          onText: (t) => { streamed = true; onText && onText(t); },
          onReasoning: (t) => { streamed = true; onReasoning && onReasoning(t); },
          extraBody: cfg.extraBody, headers: cfg.extraHeaders,
          maxTokens: cfg.maxTokens, temperature: cfg.temperature,
        });
        if (r.meta && Object.keys(r.meta).length) { this.updateLimits(r.meta); this.ui.post({ type: 'meta', meta: r.meta }); }
        if (r.usage) this.calibrate(sentChars, r.usage.prompt_tokens);
        return r;
      } catch (e) {
        if (e.meta) this.updateLimits(e.meta);
        // Larger than the per-minute token limit: retrying can never succeed; the caller compacts instead.
        const tpm = this.limits && this.limits.tokensLimit;
        if (tpm && this.est(messages) > tpm * 0.9 && /^HTTP 429\b/.test(e.message || '')) { e.tooLarge = true; throw e; }
        const maxAttempts = 5;
        if (this.abort.signal.aborted || streamed || !e.retryable || attempt >= maxAttempts) throw e;
        // Honor Retry-After (rate limits); otherwise exponential backoff.
        const waitS = Math.min(e.retryAfter !== undefined ? Math.max(1, e.retryAfter) : 1.5 * 2 ** attempt, 120);
        const why = /HTTP 429/.test(e.message) ? 'Rate limited' : e.message.slice(0, 200);
        this.ui.post({ type: 'info', text: `${why}. Retrying in ${Math.round(waitS)}s (${attempt + 1}/${maxAttempts})…` });
        await new Promise((resolve) => {
          const t = setTimeout(resolve, waitS * 1000);
          this.abort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        if (this.abort.signal.aborted) throw e;
      }
    }
  }

  async loop(cfg, root) {
    const signal = this.abort.signal;
    for (let step = 0; step < (cfg.maxSteps || 100); step++) {
      // Not right after another user message (e.g. the automatic "continue"), so user messages never come two in a row.
      if (step > 0 && this.messages[this.messages.length - 1].role !== 'user') this.takeQueued();
      await this.maybeCompact(cfg);

      let partial = '';
      this.streaming = '';   // reply text so far, so a reloaded panel can show it
      this.ui.post({ type: 'assistantStart' });
      let r;
      try {
        r = await this.callModel(cfg, this.messages, true,
          (t) => { partial += t; this.streaming = partial; this.ui.post({ type: 'delta', text: t }); },
          (t) => this.ui.post({ type: 'reasoning', text: t }));
      } catch (e) {
        if (signal.aborted && partial) this.messages.push({ role: 'assistant', content: partial + '\n[interrupted by user]' });
        // The model's real limit is below the configured window: learn a smaller limit for this chat,
        // summarize, and retry the step (at most a few times per chat).
        if (!signal.aborted && !partial && e.tooLarge && (this.overflowRetries = (this.overflowRetries || 0) + 1) <= 3) {
          // effectiveWindow() now caps to the per-minute limit, so maybeCompact() shrinks the history.
          step--;
          continue;
        }
        if (!signal.aborted && !partial && isContextOverflow(e) && (this.overflowRetries = (this.overflowRetries || 0) + 1) <= 3) {
          const est = this.est(this.messages);
          this.learnedWindow = Math.max(8000, Math.floor(Math.min(est, this.effectiveWindow(cfg)) * 0.8));
          this.ui.post({ type: 'info', text: `The model's context limit is smaller than the configured ${Math.round((cfg.contextWindow || 0) / 1000)}k. Using about ${Math.round(this.learnedWindow / 1000)}k for this chat and summarizing earlier messages.` });
          step--;
          continue;
        }
        throw e;
      } finally {
        this.streaming = null;
        this.ui.post({ type: 'assistantEnd' });
      }
      this.overflowRetries = 0;
      if (r.usage) this.ui.post({ type: 'usage', usage: r.usage, est: this.est(this.messages), window: this.effectiveWindow(cfg) });

      // Match the gateway's documented shape: a tool-call-only assistant message has no content
      // field (an empty string can reach Gemini as an empty text part, which it rejects).
      const msg = { role: 'assistant' };
      if (r.content || !r.toolCalls.length) msg.content = r.content || '';
      if (r.toolCalls.length) msg.tool_calls = r.toolCalls;
      this.messages.push(msg);

      if (!r.toolCalls.length) {
        if (r.finishReason === 'length') {
          this.messages.push({ role: 'user', content: 'Your response was cut off by the output token limit. Continue exactly where you left off.' });
          continue;
        }
        if (this.takeQueued()) continue;   // the user added instructions while this reply was being written
        return;
      }

      let stopAfter = false;
      for (let i = 0; i < r.toolCalls.length; i++) {
        const tc = r.toolCalls[i];
        let result;
        if (signal.aborted) result = 'Interrupted by user before this tool ran.';
        else if (stopAfter) result = 'Skipped: the user denied a previous action in this turn.';
        else {
          const res = await this.execTool(tc, cfg, root);
          result = res.output;
          if (res.denied && !res.feedback) stopAfter = true;
        }
        this.messages.push({ role: 'tool', tool_call_id: tc.id, content: truncate(String(result), cfg.maxToolOutputChars || 20000) });
      }
      if (signal.aborted) throw new Error('aborted');
      if (stopAfter) {
        if (this.takeQueued()) continue;   // the user already said what to do instead
        this.ui.post({ type: 'info', warn: true, text: 'You denied that action, so the agent stopped. Tell it what to do instead.' });
        return;
      }
    }
    this.ui.post({ type: 'info', text: `Reached max steps (${cfg.maxSteps}). Send "continue" to keep going.` });
  }

  /** Returns null (no approval needed) or {warning?: string, allowAlways: boolean}. */
  needsApproval(tool, args, cfg, prep, root) {
    if (tool.category === 'meta') return null;
    if (tool.category === 'read') {
      // Reading outside the workspace (e.g. ~/.ssh, other projects) needs approval; inside it never does.
      if (args.path && isOutside(root, resolvePath(root, args.path))) {
        return this.sessionAllowed.has('read_outside') ? null : { warning: 'This reads outside the workspace.', allowAlways: true, allowKey: 'read_outside' };
      }
      return null;
    }
    if (tool.name === 'run_command' && isDangerous(String(args.command || ''))) {
      return { warning: 'Potentially destructive command. This always requires approval.', allowAlways: false };
    }
    if (tool.category === 'edit' && prep.path) {
      if (isOutside(root, prep.path)) return { warning: 'This file is outside the workspace.', allowAlways: false };
    }
    if (cfg.approvalMode === 'auto') return null;
    if (cfg.approvalMode === 'autoEdit' && tool.category === 'edit') return null;
    if (this.sessionAllowed.has(tool.name)) return null;
    if (tool.name === 'run_command') {
      const cmd = String(args.command || '').trim();
      // Read-only commands inside the workspace (Get-Content, git status, node --check, read-only
      // PowerShell scripts, ...) run without asking. prep.readOnly is computed in execTool.
      if (cfg.autoApproveReadOnlyCommands !== false && prep.readOnly) return null;
      // Only auto-approve simple commands (no chaining/redirection) matching a prefix.
      if (!/[;&|`$<>\r\n]/.test(cmd) && (cfg.autoApproveCommands || []).some((p) => cmd === p || cmd.startsWith(p + ' '))) return null;
    }
    return { allowAlways: true };
  }

  /** What Rewind needs to restore a file: its text and encoding, raw bytes, or a note that it was too large. */
  async snapshot(p) {
    let st;
    try { st = await fs.promises.stat(p); } catch { return { before: null }; }   // new file: Rewind deletes it
    if (st.size > MAX_CHECKPOINT_BYTES) return { skipped: true, size: st.size };
    const f = await this.io.readText(p);
    if (f.binary) return { bytes: (await fs.promises.readFile(p)).toString('base64') };
    return { before: f.text, encoding: f.encoding };
  }

  /** Simple commands are checked by pattern; PowerShell scripts by PowerShell's parser (when available). */
  async isReadOnlyCommand(args, cfg, root) {
    const cmd = String(args.command || '').trim();
    const cwd = resolvePath(root, args.cwd || '.');
    if (readonly.classify(cmd, { root, cwd }).ok) return true;
    if (cfg.autoApproveReadOnlyScripts === false) return false;
    const sh = resolveShell(cfg);
    const script = psreadonly.extractScript(cmd, { shell: sh.kind === 'powershell' ? 'powershell' : sh.kind === 'cmd' ? 'cmd.exe' : '/bin/sh' });
    if (!script) return false;
    try { return (await psreadonly.classifyPowerShell(script, { root, cwd })).ok; } catch { return false; }
  }

  async execTool(tc, cfg, root) {
    const id = tc.id, name = tc.function.name;
    const tool = getTool(name);
    let args;
    try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
    catch { args = null; }
    this.ui.post({ type: 'tool', id, name, args: displayArgs(args || tc.function.arguments) });
    const done = (ok, output, extra = {}) => { this.ui.post({ type: 'toolResult', id, ok, output: String(output).slice(0, 8000), denied: !!extra.denied }); return { output, ...extra }; };

    if (!tool) return done(false, `Error: unknown tool "${name}".`);
    if (!args || typeof args !== 'object') return done(false, `Error: arguments for ${name} were not valid JSON: ${tc.function.arguments}`);

    // Live output from a running command, sent to the panel in small batches.
    let live = '', liveTimer = null;
    const flushLive = () => { liveTimer = null; if (live) { this.ui.post({ type: 'toolOutput', id, text: live }); live = ''; } };
    const ctx = {
      progress: (t) => { live = (live + t).slice(-20000); if (!liveTimer) liveTimer = setTimeout(flushLive, 150); },
      root, cfg, signal: this.abort.signal, readFiles: this.readFiles, io: this.io,
      post: (m) => this.ui.post(m), log: (t) => this.ui.log && this.ui.log(t),
    };
    try {
      const prep = tool.prepare ? await tool.prepare(args, ctx) : {};
      if (tool.category === 'edit' && prep.path && fs.existsSync(prep.path) && !this.readFiles.has(prep.path)) {
        return done(false, `Error: read ${args.path} with read_file before modifying it.`);
      }
      if (tool.name === 'run_command' && cfg.autoApproveReadOnlyCommands !== false) prep.readOnly = await this.isReadOnlyCommand(args, cfg, root);
      // Diff of the proposed change, shown in the approval card and in the tool row.
      const diff = typeof prep.newContent === 'string' ? diffLines(prep.oldContent, prep.newContent) : null;
      if (diff) prep.summary = `${prep.summary} (+${diff.adds} −${diff.dels})`;
      const explanation = typeof args.explanation === 'string' ? args.explanation.slice(0, 500) : '';
      const need = this.needsApproval(tool, args, cfg, prep, root);
      // Stopped while the checks above were running: don't show a prompt nobody will answer.
      if (this.abort.signal.aborted) return done(false, 'Interrupted by user.');
      if (need) {
        const canDiff = typeof prep.newContent === 'string';
        if (canDiff) this.ui.registerProposal(id, { path: prep.path, newContent: prep.newContent });
        const summary = prep.summary || (tool.category === 'read' ? `${name} ${args.path}` : name);
        const ans = await this.ui.approve({ id, name, summary, canDiff, warning: need.warning, allowAlways: need.allowAlways, explanation, diff });
        if (this.abort.signal.aborted) return done(false, 'Interrupted by user.');
        if (ans.decision === 'always' && need.allowAlways) this.sessionAllowed.add(need.allowKey || name);
        if (ans.decision === 'no') {
          const fb = (ans.feedback || '').trim();
          return done(false, `The user denied this action.${fb ? ` User feedback: ${fb}` : ''}`, { denied: true, feedback: fb });
        }
        // The file may have changed while the approval was pending; never write content the user didn't see.
        if (canDiff && tool.prepare) {
          let again;
          try { again = await tool.prepare(args, ctx); } catch (e) { again = null; }
          if (!again || again.newContent !== prep.newContent) {
            return done(false, `Error: ${args.path} changed while waiting for approval. Re-read it and try again.`);
          }
        }
      }
      if (tool.category === 'edit' && prep.path && !this.checkpoints.some((c) => c.turn === this.turn && c.path === prep.path)) {
        this.checkpoints.push({ turn: this.turn, path: prep.path, ...(await this.snapshot(prep.path)) });
      }
      const out = await tool.run(args, ctx, prep);
      if (diff) this.ui.post({ type: 'toolDiff', id, diff, summary: prep.summary, explanation });
      return done(true, out);
    } catch (e) {
      if (this.abort.signal.aborted) return done(false, 'Interrupted by user.');
      return done(false, `Error: ${e.message || e}`);
    } finally {
      clearTimeout(liveTimer);
    }
  }
}

mixin(Agent, RateLimits);
mixin(Agent, Compaction);

/** Tool arguments as shown in the panel: long strings (file contents) are shortened; diffs show the change. */
function displayArgs(args, max = 2000) {
  const cut = (s) => (s.length > max ? `${s.slice(0, max)}… [${(s.length - max).toLocaleString('en-US')} more characters not shown]` : s);
  if (typeof args === 'string') return cut(args);
  if (!args || typeof args !== 'object') return args;
  const out = Array.isArray(args) ? [] : {};
  for (const k of Object.keys(args)) out[k] = typeof args[k] === 'string' ? cut(args[k]) : args[k];
  return out;
}

module.exports = { Agent, displayArgs };
