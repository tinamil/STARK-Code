const fs = require('fs');
const path = require('path');
const { complete } = require('./llm');
const { toolDefs, getTool, truncate, resolvePath } = require('./tools');
const { buildSystemPrompt } = require('./prompt');
const { diffLines } = require('./diff');
const readonly = require('./readonly');
const textfile = require('./textfile');

// Rewind keeps a copy of each file before the agent first changes it in a turn; larger files are not copied.
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const psreadonly = require('./psreadonly');

const estTokens = (msgs) => Math.ceil(JSON.stringify(msgs).length / 3.5);
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
// Errors servers return when the request is larger than the model's context window.
const isContextOverflow = (e) => /^HTTP (400|413|422)\b/.test(e.message || '') &&
  /context[ _-]?(length|window)|maximum context|too many (input )?tokens|exceeds? the (maximum|max|context)|input (is )?too long|prompt is too long|token limit|max_?tokens.*exceed|request too large/i.test(e.message);
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
    this.sessionAllowed = new Set();
    this.busy = false;
    this.abort = null;
    this.streaming = null;
  }

  stop() { if (this.abort) this.abort.abort(); }

  toJSON() {
    const first = this.messages.find((m) => m.role === 'user' && m._display);
    return { id: this.chatId, created: this.created, updated: Date.now(), root: this.getRoot(),
      title: first ? first._display.slice(0, 80) : '(untitled)', messages: this.messages,
      checkpoints: this.checkpoints, turnCounter: this.turnCounter };
  }

  load(d) {
    this.reset();
    this.chatId = d.id; this.created = d.created; this.messages = d.messages || [];
    this.checkpoints = d.checkpoints || []; this.turnCounter = d.turnCounter || 0;
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
      this.ui.post({ type: 'user', text: displayText || userText, turn: this.turn });
      await this.loop(cfg, root);
    } catch (e) {
      if (this.abort.signal.aborted) this.ui.post({ type: 'info', text: 'Stopped.' });
      else this.ui.post({ type: 'error', text: String(e.message || e), unlockUrl: e.unlockUrl });
    } finally {
      this.busy = false;
      this.ui.post({ type: 'status', busy: false });
    }
  }

  async callModel(cfg, messages, withTools, onText, onReasoning) {
    const apiKey = await this.getApiKey();
    for (let attempt = 0; ; attempt++) {
      let streamed = false;
      try {
        await this.throttle(estTokens(messages) + (withTools ? 1300 : 0));
        const r = await complete({
          apiMode: cfg.apiMode, baseUrl: cfg.baseUrl, apiKey, model: cfg.model, messages: forApi(messages),
          tools: withTools ? toolDefs() : undefined,
          signal: this.abort.signal,
          onText: (t) => { streamed = true; onText && onText(t); },
          onReasoning: (t) => { streamed = true; onReasoning && onReasoning(t); },
          extraBody: cfg.extraBody, headers: cfg.extraHeaders,
          maxTokens: cfg.maxTokens, temperature: cfg.temperature,
        });
        if (r.meta && Object.keys(r.meta).length) { this.updateLimits(r.meta); this.ui.post({ type: 'meta', meta: r.meta }); }
        return r;
      } catch (e) {
        if (e.meta) this.updateLimits(e.meta);
        // Larger than the per-minute token limit: retrying can never succeed; the caller compacts instead.
        const tpm = this.limits && this.limits.tokensLimit;
        if (tpm && estTokens(messages) > tpm * 0.9 && /^HTTP 429\b/.test(e.message || '')) { e.tooLarge = true; throw e; }
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
          const est = estTokens(this.messages);
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
      if (r.usage) this.ui.post({ type: 'usage', usage: r.usage, est: estTokens(this.messages), window: this.effectiveWindow(cfg) });

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
    const shell = cfg.shell || (process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh');
    const script = psreadonly.extractScript(cmd, { shell });
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

    const ctx = {
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
    }
  }

  /**
   * The context size the agent actually works within: the configured window, lowered by a limit
   * learned from a context-overflow error, and kept under the gateway's tokens-per-minute limit
   * (a single request larger than that could never be sent).
   */
  effectiveWindow(cfg) {
    let w = cfg.contextWindow || 1000000;
    if (this.learnedWindow) w = Math.min(w, this.learnedWindow);
    const tpm = this.limits && this.limits.tokensLimit;
    if (tpm > 0 && tpm * 0.9 < w) {
      w = Math.floor(tpm * 0.9);
      if (!this.capNoticeShown) {
        this.capNoticeShown = true;
        this.ui.post({ type: 'info', text: `Using a ${Math.round(w / 1000)}k-token context window to stay under the gateway's ${Math.round(tpm / 1000)}k tokens-per-minute limit.` });
      }
    }
    return w;
  }

  updateLimits(meta) {
    const keys = ['tokensLimit', 'tokensRemaining', 'tokensResetS', 'requestsLimit', 'requestsRemaining', 'requestsResetS', 'creditsLimit', 'creditsRemaining', 'creditsResetS'];
    if (!keys.some((k) => meta[k] !== undefined)) return;
    this.limits = { ...(this.limits || {}), ...meta };
    this.limitsAt = Date.now();
  }

  /**
   * Wait for the per-minute window to reset when the next request would exceed what's left of it,
   * instead of sending it and getting a 429. Uses the most recent rate-limit headers.
   */
  async throttle(estimate) {
    const L = this.limits;
    if (!L) return;
    const elapsed = (Date.now() - this.limitsAt) / 1000;
    let wait = 0, why = '';
    if (L.tokensRemaining !== undefined && L.tokensResetS > elapsed && estimate > L.tokensRemaining && !(L.tokensLimit && estimate > L.tokensLimit)) {
      wait = L.tokensResetS - elapsed; why = 'tokens-per-minute';
    }
    if (L.requestsRemaining !== undefined && L.requestsRemaining <= 0 && L.requestsResetS > elapsed && L.requestsResetS - elapsed > wait) {
      wait = L.requestsResetS - elapsed; why = 'requests-per-minute';
    }
    if (wait <= 0) return;
    wait = Math.min(wait + 0.5, 65);
    this.ui.post({ type: 'info', text: `Waiting ${Math.ceil(wait)}s for the gateway's ${why} limit to reset…` });
    await new Promise((resolve) => {
      const t = setTimeout(resolve, wait * 1000);
      this.abort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (this.abort.signal.aborted) throw new Error('aborted');
    this.limits = { ...L, tokensRemaining: undefined, requestsRemaining: undefined };   // window reset; wait for fresh headers
  }

  /**
   * Rolling compaction. When the conversation passes the high mark (compactAt, default 50k tokens),
   * the oldest steps are summarized so it drops to about the low mark (compactTo, default 10k).
   * The high mark never exceeds 70% of the effective context window.
   */
  compactionMarks(cfg) {
    const window = this.effectiveWindow(cfg);
    const high = Math.max(2000, Math.min(cfg.compactAt > 0 ? cfg.compactAt : 50000, Math.floor(window * 0.7)));
    let low = cfg.compactTo > 0 ? cfg.compactTo : 10000;
    if (low > high / 2) low = Math.floor(high / 2);
    return { window, high, low };
  }

  async maybeCompact(cfg) {
    const { window, high, low } = this.compactionMarks(cfg);
    const before = estTokens(this.messages);
    if (before < high) return;

    // Keep the most recent steps: what fits in the low mark after the system prompt and the summary.
    const tailBudget = Math.max(1500, low - estTokens([this.messages[0]]) - 1200);
    let size = 0, cut = this.messages.length;
    for (let i = this.messages.length - 1; i > 1; i--) {
      size += estTokens([this.messages[i]]);
      if (size > tailBudget) break;
      cut = i;
    }
    // Cut at an assistant/user boundary so tool calls stay paired with their results.
    while (cut < this.messages.length && this.messages[cut].role === 'tool') cut++;
    if (cut >= this.messages.length) cut = this.messages.length - 1;
    while (cut > 1 && this.messages[cut].role === 'tool') cut--;

    const head = this.messages.slice(1, cut);
    if (head.length < 2) { this.shrinkToolOutputs(); return; }

    // The summary request itself can be too large (a big chat reopened from History, before the
    // gateway's limits are known): shrink what is sent and try again.
    let summary, sumWindow = window;
    for (let attempt = 0; ; attempt++) {
      try { summary = await this.summarize(cfg, head, sumWindow); break; }
      catch (e) {
        if (attempt >= 2 || this.abort.signal.aborted || !(e.tooLarge || isContextOverflow(e))) throw e;
        sumWindow = Math.floor(Math.min(sumWindow, this.effectiveWindow(cfg)) / 2);
      }
    }
    this.messages = [
      this.messages[0],
      { role: 'user', content: `[Summary of earlier conversation in this session]\n${summary}` },
      { role: 'assistant', content: 'Understood. Continuing from the summary.' },
      ...this.messages.slice(cut),
    ];
    if (this.messages[3] && this.messages[3].role === 'assistant' && this.messages[2].role === 'assistant') {
      this.messages.splice(2, 1);
    }
    this.rebuildReadFiles();
    if (estTokens(this.messages) > high) this.shrinkToolOutputs();
    this.ui.post({ type: 'info', text: `Summarized earlier steps to keep the conversation small (about ${Math.round(before / 1000)}k → ${Math.round(estTokens(this.messages) / 1000)}k tokens).` });
  }

  /** After compaction, only files whose contents are still in the conversation count as read. */
  rebuildReadFiles() {
    this.readFiles.clear();
    const root = this.getRoot();
    const answered = new Set(this.messages.filter((m) => m.role === 'tool' && !/^Error:/.test(String(m.content))).map((m) => m.tool_call_id));
    for (const m of this.messages) {
      for (const tc of m.tool_calls || []) {
        if (!['read_file', 'write_file'].includes(tc.function.name) || !answered.has(tc.id)) continue;
        try { const p = JSON.parse(tc.function.arguments).path; if (p) this.readFiles.add(resolvePath(root, p)); } catch { /* bad args */ }
      }
    }
  }

  /** Ask the model for a summary of `msgs` that lets the work continue. `focus` is optional user guidance. */
  async summarize(cfg, msgs, window, focus) {
    const transcript = msgs.map((m) => {
      if (m.role === 'tool') return `[tool result]\n${String(m.content).slice(0, 1500)}`;
      let s = `[${m.role}]\n${m.content || ''}`;
      if (m.tool_calls) s += '\n' + m.tool_calls.map((t) => `-> ${t.function.name}(${String(t.function.arguments).slice(0, 500)})`).join('\n');
      return s;
    }).join('\n\n');
    const maxChars = Math.floor(window * 0.5 * 3.5);
    const r = await this.callModel(cfg, [
      { role: 'system', content: 'You compress coding-agent transcripts. Write a dense summary (at most about 600 words) that lets the agent continue the work: the user\'s requests (quote them verbatim), decisions made, files read/changed and how, commands run and their outcomes, errors encountered, current state, and remaining TODOs. The transcript may begin with an earlier summary: carry forward everything in it that still matters. No preamble.' + (focus ? `\n\nThe user asked the summary to focus on: ${focus}` : '') },
      { role: 'user', content: transcript.length > maxChars ? '...[older part omitted]...\n' + transcript.slice(-maxChars) : transcript },
    ], false);
    if (!r.content || !r.content.trim()) throw new Error('The model returned an empty summary.');
    return r.content.trim();
  }

  /**
   * Summarize the whole conversation now (the user's /compact). Keeps the system prompt, replaces
   * everything else with the summary. File checkpoints are kept, so earlier edits can still be reverted.
   */
  async compactNow(focus) {
    if (this.busy) throw new Error('Wait for the agent to finish (or stop it) before compacting.');
    const body = this.messages.slice(1);
    if (!body.some((m) => m.role === 'user' && m._turn)) { this.ui.post({ type: 'info', text: 'Nothing to compact yet.' }); return false; }
    const cfg = this.getConfig();
    this.busy = true;
    this.abort = new AbortController();
    this.ui.post({ type: 'status', busy: true });
    this.ui.post({ type: 'info', text: `Compacting the conversation${focus ? ` (focus: ${focus})` : ''}…` });
    try {
      const before = estTokens(this.messages);
      const summary = await this.summarize(cfg, body, this.effectiveWindow(cfg), focus);
      this.messages = [
        this.messages[0],
        { role: 'user', content: `[Summary of earlier conversation in this session]\n${summary}` },
        { role: 'assistant', content: 'Understood. Continuing from the summary.' },
      ];
      this.readFiles.clear();
      this.ui.post({ type: 'compacted', summary, before, after: estTokens(this.messages) });
      return true;
    } catch (e) {
      if (this.abort.signal.aborted) this.ui.post({ type: 'info', text: 'Compaction stopped; the conversation is unchanged.' });
      else this.ui.post({ type: 'error', text: `Compaction failed; the conversation is unchanged. ${e.message || e}`, unlockUrl: e.unlockUrl });
      return false;
    } finally {
      this.busy = false;
      this.ui.post({ type: 'status', busy: false });
    }
  }

  shrinkToolOutputs() {
    const tools = this.messages.filter((m) => m.role === 'tool');
    tools.slice(0, -2).forEach((m) => { if (m.content.length > 2000) m.content = truncate(m.content, 2000); });
  }
}

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
