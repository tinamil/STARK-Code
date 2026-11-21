const fs = require('fs');
const path = require('path');
const { complete } = require('./llm');
const { toolDefs, getTool, truncate, resolvePath } = require('./tools');
const { buildSystemPrompt } = require('./prompt');

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
  constructor({ getConfig, getApiKey, getRoot, ui }) {
    this.getConfig = getConfig; this.getApiKey = getApiKey; this.getRoot = getRoot; this.ui = ui;
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
    const restored = new Set();
    for (const c of cps.slice().reverse()) {
      if (c.before === null) { try { await fs.promises.unlink(c.path); } catch { /* already gone */ } }
      else { await fs.promises.mkdir(path.dirname(c.path), { recursive: true }); await fs.promises.writeFile(c.path, c.before, 'utf8'); }
      restored.add(c.path);
    }
    this.checkpoints = this.checkpoints.filter((c) => c.turn < turn);
    const idx = this.messages.findIndex((m) => m.role === 'user' && m._turn === turn);
    let text = '', rewound = false;
    if (idx > 0) { text = this.messages[idx]._display || ''; this.messages = this.messages.slice(0, idx); rewound = true; }
    else this.messages.push({ role: 'user', content: '[The user reverted all file changes made since an earlier point (now summarized). Re-read files before editing.]' }, { role: 'assistant', content: 'Noted.' });
    this.readFiles.clear();
    return { files: [...restored], text, rewound };
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
      else this.ui.post({ type: 'error', text: String(e.message || e) });
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
        const r = await complete({
          apiMode: cfg.apiMode, baseUrl: cfg.baseUrl, apiKey, model: cfg.model, messages: forApi(messages),
          tools: withTools ? toolDefs() : undefined,
          signal: this.abort.signal,
          onText: (t) => { streamed = true; onText && onText(t); },
          onReasoning: (t) => { streamed = true; onReasoning && onReasoning(t); },
          extraBody: cfg.extraBody, headers: cfg.extraHeaders,
          maxTokens: cfg.maxTokens, temperature: cfg.temperature,
        });
        if (r.meta && Object.keys(r.meta).length) this.ui.post({ type: 'meta', meta: r.meta });
        return r;
      } catch (e) {
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
      this.ui.post({ type: 'assistantStart' });
      let r;
      try {
        r = await this.callModel(cfg, this.messages, true,
          (t) => { partial += t; this.ui.post({ type: 'delta', text: t }); },
          (t) => this.ui.post({ type: 'reasoning', text: t }));
      } catch (e) {
        if (signal.aborted && partial) this.messages.push({ role: 'assistant', content: partial + '\n[interrupted by user]' });
        // The model's real limit is below the configured window: learn a smaller limit for this chat,
        // summarize, and retry the step (at most a few times per chat).
        if (!signal.aborted && !partial && isContextOverflow(e) && (this.overflowRetries = (this.overflowRetries || 0) + 1) <= 3) {
          const est = estTokens(this.messages);
          this.learnedWindow = Math.max(8000, Math.floor(Math.min(est, this.effectiveWindow(cfg)) * 0.8));
          this.ui.post({ type: 'info', text: `The model's context limit is smaller than the configured ${Math.round((cfg.contextWindow || 0) / 1000)}k. Using about ${Math.round(this.learnedWindow / 1000)}k for this chat and summarizing earlier messages.` });
          step--;
          continue;
        }
        throw e;
      } finally {
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
        this.ui.post({ type: 'info', text: 'Action denied. Tell the agent what to do instead.' });
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
      // Only auto-approve simple commands (no chaining/redirection) matching a prefix.
      if (!/[;&|`$<>\r\n]/.test(cmd) && (cfg.autoApproveCommands || []).some((p) => cmd === p || cmd.startsWith(p + ' '))) return null;
    }
    return { allowAlways: true };
  }

  async execTool(tc, cfg, root) {
    const id = tc.id, name = tc.function.name;
    const tool = getTool(name);
    let args;
    try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
    catch { args = null; }
    this.ui.post({ type: 'tool', id, name, args: args || tc.function.arguments });
    const done = (ok, output, extra = {}) => { this.ui.post({ type: 'toolResult', id, ok, output: String(output).slice(0, 8000) }); return { output, ...extra }; };

    if (!tool) return done(false, `Error: unknown tool "${name}".`);
    if (!args || typeof args !== 'object') return done(false, `Error: arguments for ${name} were not valid JSON: ${tc.function.arguments}`);

    const ctx = {
      root, cfg, signal: this.abort.signal, readFiles: this.readFiles,
      post: (m) => this.ui.post(m), log: (t) => this.ui.log && this.ui.log(t),
    };
    try {
      const prep = tool.prepare ? await tool.prepare(args, ctx) : {};
      if (tool.category === 'edit' && prep.path && fs.existsSync(prep.path) && !this.readFiles.has(prep.path)) {
        return done(false, `Error: read ${args.path} with read_file before modifying it.`);
      }
      const need = this.needsApproval(tool, args, cfg, prep, root);
      if (need) {
        const canDiff = typeof prep.newContent === 'string';
        if (canDiff) this.ui.registerProposal(id, { path: prep.path, newContent: prep.newContent });
        const summary = prep.summary || (tool.category === 'read' ? `${name} ${args.path}` : name);
        const ans = await this.ui.approve({ id, name, summary, canDiff, warning: need.warning, allowAlways: need.allowAlways });
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
        let before = null;
        try { before = await fs.promises.readFile(prep.path, 'utf8'); } catch { /* new file */ }
        this.checkpoints.push({ turn: this.turn, path: prep.path, before });
      }
      const out = await tool.run(args, ctx, prep);
      return done(true, out);
    } catch (e) {
      if (this.abort.signal.aborted) return done(false, 'Interrupted by user.');
      return done(false, `Error: ${e.message || e}`);
    }
  }

  effectiveWindow(cfg) {
    const w = cfg.contextWindow || 1000000;
    return this.learnedWindow ? Math.min(w, this.learnedWindow) : w;
  }

  async maybeCompact(cfg) {
    const window = this.effectiveWindow(cfg);
    if (estTokens(this.messages) < window * 0.7) return;

    // Keep a recent tail (~30% of window) starting at an assistant/user boundary so tool pairs stay intact.
    let size = 0, cut = this.messages.length;
    for (let i = this.messages.length - 1; i > 1; i--) {
      size += estTokens([this.messages[i]]);
      if (size > window * 0.3) break;
      cut = i;
    }
    while (cut < this.messages.length && this.messages[cut].role === 'tool') cut++;
    if (cut >= this.messages.length) cut = this.messages.length - 1;
    while (cut > 1 && this.messages[cut].role === 'tool') cut--;

    const head = this.messages.slice(1, cut);
    if (head.length < 2) { this.shrinkToolOutputs(); return; }

    this.ui.post({ type: 'info', text: 'Context is getting full — summarizing earlier conversation…' });
    const transcript = head.map((m) => {
      if (m.role === 'tool') return `[tool result]\n${String(m.content).slice(0, 1500)}`;
      let s = `[${m.role}]\n${m.content || ''}`;
      if (m.tool_calls) s += '\n' + m.tool_calls.map((t) => `-> ${t.function.name}(${t.function.arguments.slice(0, 500)})`).join('\n');
      return s;
    }).join('\n\n');
    const maxChars = Math.floor(window * 0.5 * 3.5);
    const r = await this.callModel(cfg, [
      { role: 'system', content: 'You compress coding-agent transcripts. Write a dense summary that lets the agent continue the work: the user\'s requests (quote them verbatim), decisions made, files read/changed and how, commands run and their outcomes, errors encountered, current state, and remaining TODOs. No preamble.' },
      { role: 'user', content: transcript.length > maxChars ? '...[older part omitted]...\n' + transcript.slice(-maxChars) : transcript },
    ], false);
    this.messages = [
      this.messages[0],
      { role: 'user', content: `[Summary of earlier conversation in this session]\n${r.content}` },
      { role: 'assistant', content: 'Understood. Continuing from the summary.' },
      ...this.messages.slice(cut),
    ];
    if (this.messages[3] && this.messages[3].role === 'assistant' && this.messages[2].role === 'assistant') {
      this.messages.splice(2, 1);
    }
    this.readFiles.clear();
    if (estTokens(this.messages) > window * 0.7) this.shrinkToolOutputs();
  }

  shrinkToolOutputs() {
    const tools = this.messages.filter((m) => m.role === 'tool');
    tools.slice(0, -2).forEach((m) => { if (m.content.length > 2000) m.content = truncate(m.content, 2000); });
  }
}

module.exports = { Agent };
