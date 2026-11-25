// Keeping the conversation small: trimming stale tool output, pinned facts, rolling summaries and
// /compact. These are methods of Agent (mixed in by src/agent.js), so `this` is the agent.
const { resolvePath, rel } = require('./tools');
const { isContextOverflow } = require('./limits');

class Compaction {
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

  /** Index where the kept recent steps start: what fits in the low mark, cut at a step boundary. */
  tailStart(low) {
    const tailBudget = Math.max(1500, low - this.est([this.messages[0]]) - 1200);
    let size = 0, cut = this.messages.length;
    for (let i = this.messages.length - 1; i > 1; i--) {
      size += this.est([this.messages[i]]);
      if (size > tailBudget) break;
      cut = i;
    }
    // Cut at an assistant/user boundary so tool calls stay paired with their results.
    while (cut < this.messages.length && this.messages[cut].role === 'tool') cut++;
    if (cut >= this.messages.length) cut = this.messages.length - 1;
    while (cut > 1 && this.messages[cut].role === 'tool') cut--;
    return cut;
  }

  /**
   * Free space without a model call. Anywhere: file contents that were read again later. Before
   * `tailStart` (older steps) also: contents of files changed since they were read, and large output.
   * Returns the number of characters freed.
   */
  pruneStale(tailStart) {
    const root = this.getRoot();
    const calls = new Map();
    for (const m of this.messages) {
      for (const tc of m.tool_calls || []) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments) || {}; } catch { /* bad args */ }
        calls.set(tc.id, { name: tc.function.name, path: typeof args.path === 'string' ? resolvePath(root, args.path) : null, full: !args.offset && !args.limit });
      }
    }
    const lastFullRead = new Map(), lastChange = new Map();
    this.messages.forEach((m, i) => {
      const c = m.role === 'tool' && calls.get(m.tool_call_id);
      if (!c || !c.path || m._pruned || /^Error:/.test(String(m.content))) return;
      if (c.name === 'read_file' && c.full) lastFullRead.set(c.path, i);
      if (c.name === 'edit_file' || c.name === 'write_file') lastChange.set(c.path, i);
    });
    let freed = 0;
    this.messages.forEach((m, i) => {
      const c = m.role === 'tool' && calls.get(m.tool_call_id);
      if (!c || m._pruned) return;
      const content = String(m.content);
      let next = null;
      if (c.name === 'read_file' && lastFullRead.get(c.path) > i) next = '[Removed: this file was read again later in the conversation.]';
      else if (i < tailStart) {
        if (c.name === 'read_file' && lastChange.get(c.path) > i) next = '[Removed: this file was changed after this read. Read it again if you need its contents.]';
        else if (content.length > 1500) next = `${content.slice(0, 600)}\n[Older output trimmed: ${(content.length - 600).toLocaleString('en-US')} more characters. Run the tool again if you need it.]`;
      }
      if (next !== null && next.length < content.length) { freed += content.length - next.length; m.content = next; m._pruned = true; }
    });
    return freed;
  }

  /** Record what must survive summarizing word for word: the user's requests and the latest task list. */
  collectPinned(removed) {
    for (const m of removed) {
      if (m.role === 'user' && m._turn && !this.pinned.requests.some((r) => r.turn === m._turn)) {
        this.pinned.requests.push({ turn: m._turn, text: String(m._display || m.content || '').slice(0, 2000) });
      }
      for (const tc of m.tool_calls || []) {
        if (tc.function.name !== 'todo_write') continue;
        try { const t = JSON.parse(tc.function.arguments).todos; if (Array.isArray(t)) this.pinned.todos = t; } catch { /* bad args */ }
      }
    }
  }

  /** The summary message: exact facts kept by the extension, then the model's summary of the rest. */
  summaryMessage(summary, kept) {
    const parts = ['[Summary of earlier conversation in this session]'];
    const reqs = this.pinned.requests;
    if (reqs.length) {
      const total = reqs.reduce((n, r) => n + r.text.length, 0);
      const lines = reqs.map((r, i) => `${i + 1}. ${total > 8000 && i < reqs.length - 5 && r.text.length > 300 ? `${r.text.slice(0, 300)}…` : r.text}`);
      parts.push(`## The user's requests so far (their exact words, oldest first)\n${lines.join('\n')}`);
    }
    const root = this.getRoot();
    const files = [...new Set(this.checkpoints.map((c) => rel(root, c.path)))];
    if (files.length) parts.push(`## Files you have changed in this session\n${files.slice(0, 100).map((f) => `- ${f}`).join('\n')}${files.length > 100 ? `\n- …and ${files.length - 100} more` : ''}`);
    const todoInKept = kept.some((m) => (m.tool_calls || []).some((tc) => tc.function.name === 'todo_write'));
    if (this.pinned.todos && this.pinned.todos.length && !todoInKept) {
      parts.push(`## Task list\n${this.pinned.todos.map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n')}`);
    }
    parts.push(`## Earlier work\n${summary}`);
    return { role: 'user', content: parts.join('\n\n'), _summary: summary };
  }

  async maybeCompact(cfg) {
    const { window, high, low } = this.compactionMarks(cfg);
    const before = this.est(this.messages);
    if (before < high) return;

    // First, free space without a model call. Often that is enough.
    if (this.pruneStale(this.tailStart(low)) > 0) {
      this.rebuildReadFiles();
      const after = this.est(this.messages);
      if (after < high * 0.9) {
        this.ui.post({ type: 'info', text: `Trimmed old tool output to keep the conversation small (about ${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tokens).` });
        return;
      }
    }

    const cut = this.tailStart(low);
    const head = this.messages.slice(1, cut);
    if (head.length < 2) { this.pruneStale(Math.max(2, this.messages.length - 2)); this.rebuildReadFiles(); return; }

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
    this.collectPinned(head);
    const kept = this.messages.slice(cut);
    this.messages = [this.messages[0], this.summaryMessage(summary, kept), { role: 'assistant', content: 'Understood. Continuing from the summary.' }, ...kept];
    if (this.messages[3] && this.messages[3].role === 'assistant' && this.messages[2].role === 'assistant') {
      this.messages.splice(2, 1);
    }
    this.rebuildReadFiles();
    if (this.est(this.messages) > high && this.pruneStale(Math.max(2, this.messages.length - 2))) this.rebuildReadFiles();
    this.ui.post({ type: 'info', text: `Summarized earlier steps to keep the conversation small (about ${Math.round(before / 1000)}k → ${Math.round(this.est(this.messages) / 1000)}k tokens).` });
  }

  /** After compaction, only files whose contents are still in the conversation count as read. */
  rebuildReadFiles() {
    this.readFiles.clear();
    const root = this.getRoot();
    const answered = new Set(this.messages.filter((m) => m.role === 'tool' && !m._pruned && !/^Error:/.test(String(m.content))).map((m) => m.tool_call_id));
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
      if (m._summary !== undefined) return `[earlier summary]\n${m._summary}`;
      if (m.role === 'tool') return `[tool result]\n${String(m.content).slice(0, 1500)}`;
      let s = `[${m.role}]\n${m.content || ''}`;
      if (m.tool_calls) s += '\n' + m.tool_calls.map((t) => `-> ${t.function.name}(${String(t.function.arguments).slice(0, 500)})`).join('\n');
      return s;
    }).join('\n\n');
    const maxChars = Math.floor(window * 0.5 * 3.5);
    const r = await this.callModel(cfg, [
      { role: 'system', content: 'You compress coding-agent transcripts. Write a dense summary (at most about 600 words) that lets the agent continue the work: what was found out about the code, decisions made and why, what was changed and how, commands run and their outcomes, errors encountered, the current state, and the next steps. The user\'s requests, the list of changed files and the task list are recorded separately, so do not repeat them. The transcript may begin with an earlier summary: carry forward everything in it that still matters. No preamble.' + (focus ? `\n\nThe user asked the summary to focus on: ${focus}` : '') },
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
      const before = this.est(this.messages);
      const summary = await this.summarize(cfg, body, this.effectiveWindow(cfg), focus);
      this.collectPinned(body);
      this.messages = [this.messages[0], this.summaryMessage(summary, []), { role: 'assistant', content: 'Understood. Continuing from the summary.' }];
      this.readFiles.clear();
      this.ui.post({ type: 'compacted', summary: this.messages[1].content, before, after: this.est(this.messages) });
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
}

module.exports = { Compaction };
