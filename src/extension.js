const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { Agent, displayArgs } = require('./agent');
const { listModels, testConnection } = require('./llm');
const { createEditorIo } = require('./editorio');
const { ChatStore } = require('./chatstore');
const { panelBody } = require('./panelhtml');

const SECRET_KEY = 'oaiAgent.apiKey';
const PROPOSED_SCHEME = 'oai-agent-proposed';

// Settings live under "starkCode". They were "oaiAgent" before 0.14.0.
const CONFIG = 'starkCode';
const OLD_CONFIG = 'oaiAgent';
const CONFIG_KEYS = ['baseUrl', 'model', 'models', 'contextWindow', 'compactAt', 'compactTo', 'maxTokens', 'temperature', 'maxSteps', 'approvalMode',
    'autoApproveCommands', 'autoApproveReadOnlyCommands', 'autoApproveReadOnlyScripts', 'shell', 'commandTimeoutMs', 'maxToolOutputChars', 'extraHeaders', 'extraBody', 'customInstructions'];

function getConfig() {
  const c = vscode.workspace.getConfiguration(CONFIG);
  const o = {};
  for (const k of CONFIG_KEYS) o[k] = c.get(k);
  return o;
}

/** Moves settings saved under the old "oaiAgent" prefix to "starkCode", at the scope they were set. */
async function migrateSettings() {
  const T = vscode.ConfigurationTarget;
  const scopes = [['globalValue', T.Global], ['workspaceValue', T.Workspace], ['workspaceFolderValue', T.WorkspaceFolder]];
  for (const k of CONFIG_KEYS) {
    const old = vscode.workspace.getConfiguration(OLD_CONFIG).inspect(k);
    if (!old) continue;
    for (const [field, target] of scopes) {
      if (old[field] === undefined) continue;
      try {
        const cur = vscode.workspace.getConfiguration(CONFIG);
        if (cur.inspect(k)[field] === undefined) await cur.update(k, old[field], target);
        await vscode.workspace.getConfiguration(OLD_CONFIG).update(k, undefined, target);
      } catch { /* read-only or unavailable settings file: leave it */ }
    }
  }
}
function getRoot() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : os.homedir();
}
const stripContext = (t) => String(t || '').replace(/\n*<context>[\s\S]*<\/context>\s*$/, '');

class ChatViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.pending = new Map();     // approval id -> resolve
    this.pendingReqs = new Map(); // approval id -> request, so a reloaded panel can show it again
    this.proposals = new Map();   // id -> {path, newContent}
    this.serverModels = [];
    this.output = vscode.window.createOutputChannel('STARK Code');
    this.chats = new ChatStore(vscode.Uri.joinPath(context.globalStorageUri, 'chats').fsPath);
    this.proposedProvider = {
      provideTextDocumentContent: (uri) => {
        const p = this.proposals.get(new URLSearchParams(uri.query).get('id'));
        return p ? p.newContent : '';
      },
    };
    this.agent = new Agent({
      getConfig, getRoot,
      io: createEditorIo(vscode),
      getApiKey: () => this.getKey(),
      ui: {
        post: (m) => this.post(m),
        log: (t) => this.output.append(t),
        registerProposal: (id, p) => this.proposals.set(id, p),
        approve: (req) => new Promise((resolve) => {
          if (this.agent.abort && this.agent.abort.signal.aborted) { resolve({ decision: 'no' }); return; }
          this.pending.set(req.id, resolve);
          this.pendingReqs.set(req.id, req);
          this.updateApprovalContext();
          this.post({ type: 'approval', ...req });
          const onAbort = () => this.resolveApproval(req.id, { decision: 'no' });
          this.agent.abort && this.agent.abort.signal.addEventListener('abort', onAbort, { once: true });
        }),
      },
    });
  }

  async getKey() { return (await this.context.secrets.get(SECRET_KEY)) || ''; }
  post(m) { if (this.view) this.view.webview.postMessage(m); }

  updateApprovalContext() {
    vscode.commands.executeCommand('setContext', 'oaiAgent.awaitingApproval', this.pending.size > 0);
  }
  resolveApproval(id, answer) {
    const r = this.pending.get(id);
    if (!r) return;
    this.pending.delete(id);
    this.pendingReqs.delete(id);
    this.updateApprovalContext();
    this.post({ type: 'approvalDone', id });
    r(answer);
  }
  /** Used by keyboard commands: answer the oldest pending approval. */
  answerOldest(decision) {
    const id = this.pending.keys().next().value;
    if (id) this.resolveApproval(id, { decision });
  }

  sendConfig() {
    const c = getConfig();
    const noTools = new Set(this.serverModels.filter((m) => m.tools === false).map((m) => m.id));
    const ids = [...new Set([c.model, ...(c.models || []), ...this.serverModels.map((m) => m.id)].filter(Boolean))];
    const models = ids.map((id) => ({ id, noTools: noTools.has(id) }));
    this.post({ type: 'config', model: c.model, baseUrl: c.baseUrl, models, approvalMode: c.approvalMode });
  }
  async refreshServerModels() {
    try { this.serverModels = await listModels({ baseUrl: getConfig().baseUrl, apiKey: await this.getKey(), headers: getConfig().extraHeaders }); }
    catch { this.serverModels = []; }
    this.sendConfig();
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
${panelBody()}
<script nonce="${nonce}" src="${js}"></script></body></html>`;

    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: 'error', text: String(e.message || e) })));
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready': {
        // The panel (re)loaded: VS Code recreates it when the view is moved or reloaded. Rebuild it
        // from the agent's state so a running task and any waiting prompt stay reachable.
        if (this.agent.messages.length) {
          this.replay();
          this.post({ type: 'status', busy: this.agent.busy });
          // A reply that is being written right now: show what has arrived; later text keeps appending.
          if (typeof this.agent.streaming === 'string') { this.post({ type: 'assistantStart' }); if (this.agent.streaming) this.post({ type: 'delta', text: this.agent.streaming }); }
          for (const req of this.pendingReqs.values()) this.post({ type: 'approval', ...req });
          for (const q of this.agent.queued) this.post({ type: 'queued', id: q.id, text: q.display });
        }
        this.sendConfig();
        this.refreshServerModels();
        if (!getConfig().model) this.post({ type: 'setup', ...(await this.setupState()), first: true });
        break;
      }
      case 'send': {
        let text = m.text;
        if (m.includeContext) text += this.editorContext();
        await this.agent.run(text, m.text);
        await this.saveChat();
        break;
      }
      case 'queue': {
        // Typed while the agent works: delivered after the current step. If it just finished, send normally.
        const text = m.text + (m.includeContext ? this.editorContext() : '');
        if (!this.agent.busy) { await this.agent.run(text, m.text); await this.saveChat(); break; }
        this.post({ type: 'queued', id: this.agent.enqueue(text, m.text), text: m.text });
        break;
      }
      case 'unqueue': this.agent.unqueue(m.id); break;
      case 'stop': this.agent.stop(); break;
      case 'compact': if (await this.agent.compactNow((m.focus || '').trim())) await this.saveChat(); break;
      case 'new': await this.newChat(); break;
      case 'setModel': await vscode.workspace.getConfiguration(CONFIG).update('model', m.model, vscode.ConfigurationTarget.Global); break;
      case 'approve': this.resolveApproval(m.id, { decision: m.decision, feedback: m.feedback }); break;
      case 'diff': this.showDiff(m.id); break;
      case 'open': {
        const p = path.isAbsolute(m.path) ? m.path : path.join(getRoot(), m.path);
        vscode.window.showTextDocument(vscode.Uri.file(p), { preview: true });
        break;
      }
      // ----- setup -----
      case 'getSetup': this.post({ type: 'setup', ...(await this.setupState()) }); break;
      case 'testSetup': {
        this.post({ type: 'testResult', running: true });
        const apiKey = m.apiKey !== undefined && m.apiKey !== '' ? m.apiKey : await this.getKey();
        const r = await testConnection({ baseUrl: m.baseUrl, model: m.model, apiKey, headers: getConfig().extraHeaders, extraBody: getConfig().extraBody });
        this.post({ type: 'testResult', ...r });
        break;
      }
      case 'fetchModels': {
        const apiKey = m.apiKey ? m.apiKey : await this.getKey();
        try { this.post({ type: 'setupModels', models: await listModels({ baseUrl: m.baseUrl, apiKey, headers: getConfig().extraHeaders }) }); }
        catch (e) { this.post({ type: 'setupModels', models: [], error: e.cause?.message || e.message }); }
        break;
      }
      case 'saveSetup': {
        const c = vscode.workspace.getConfiguration(CONFIG);
        await c.update('baseUrl', m.baseUrl, vscode.ConfigurationTarget.Global);
        await c.update('model', m.model, vscode.ConfigurationTarget.Global);
        if (['ask', 'autoEdit', 'auto'].includes(m.approvalMode) && m.approvalMode !== c.get('approvalMode')) await c.update('approvalMode', m.approvalMode, vscode.ConfigurationTarget.Global);
        // A memory preset sets both compaction sizes. "Custom" sends neither and leaves them alone.
        const at = Number(m.compactAt), to = Number(m.compactTo);
        if (at > 0 && to > 0 && to < at && (at !== c.get('compactAt') || to !== c.get('compactTo'))) {
          await c.update('compactAt', at, vscode.ConfigurationTarget.Global);
          await c.update('compactTo', to, vscode.ConfigurationTarget.Global);
        }
        if (m.apiKey === null) await this.context.secrets.delete(SECRET_KEY);
        else if (m.apiKey) await this.context.secrets.store(SECRET_KEY, m.apiKey);
        this.post({ type: 'panelClose' });
        this.refreshServerModels();
        break;
      }
      case 'openUnlock': {
        // Only gateway-provided https URLs, and only on the user's click.
        if (typeof m.url === 'string' && /^https:\/\//i.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      }
      case 'openSettings': vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.oai-agent'); break;
      // ----- history -----
      case 'history': this.post({ type: 'history', items: await this.listChats() }); break;
      case 'loadChat': await this.loadChat(m.id); break;
      case 'deleteChat': {
        await this.chats.remove(m.id);
        this.post({ type: 'history', items: await this.listChats() });
        break;
      }
      // ----- rewind -----
      case 'revert': await this.revert(m.turn); break;
    }
  }

  async setupState() {
    const c = getConfig();
    return { baseUrl: c.baseUrl, model: c.model, compactAt: c.compactAt, compactTo: c.compactTo, approvalMode: c.approvalMode, hasKey: !!(await this.getKey()) };
  }

  editorContext() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') return '';
    const file = vscode.workspace.asRelativePath(ed.document.uri);
    const sel = ed.selection;
    if (sel.isEmpty) return `\n\n<context>Active file in editor: ${file} (cursor at line ${sel.active.line + 1})</context>`;
    const text = ed.document.getText(sel).slice(0, 20000);
    return `\n\n<context>Selected text in ${file} (lines ${sel.start.line + 1}-${sel.end.line + 1}):\n\`\`\`\n${text}\n\`\`\`</context>`;
  }

  async showDiff(id) {
    const p = this.proposals.get(id);
    if (!p) return;
    const exists = await vscode.workspace.fs.stat(vscode.Uri.file(p.path)).then(() => true, () => false);
    const left = exists ? vscode.Uri.file(p.path) : vscode.Uri.parse(`${PROPOSED_SCHEME}:/empty?id=__none__`);
    const right = vscode.Uri.parse(`${PROPOSED_SCHEME}:/${path.basename(p.path)}?id=${encodeURIComponent(id)}`);
    vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(p.path)} (proposed)`);
  }

  clearPending() {
    for (const id of [...this.pending.keys()]) this.resolveApproval(id, { decision: 'no' });
    this.proposals.clear();
  }

  async newChat() {
    this.agent.stop();
    this.clearPending();
    // Let the stopped run finish writing to the old chat before starting a new one.
    await this.agent.idle();
    await this.saveChat();
    this.agent.reset();
    this.post({ type: 'clear' });
  }

  // ----- persistence -----
  async saveChat() {
    if (!this.agent.messages.some((m) => m.role === 'user')) return;
    try { await this.chats.save(this.agent.toJSON()); }
    catch (e) { this.post({ type: 'error', text: `Could not save this chat: ${e.message}` }); }
  }

  async listChats() {
    const items = await this.chats.list(getRoot());
    return items.map((c) => ({ ...c, current: c.id === this.agent.chatId }));
  }

  async loadChat(id) {
    if (this.agent.busy) { this.post({ type: 'info', text: 'Stop the agent before switching chats.' }); return; }
    await this.saveChat();
    const d = await this.chats.load(id);
    this.clearPending();
    this.agent.load(d);
    this.replay();
    this.post({ type: 'panelClose' });
  }

  /** Rebuild the webview transcript from agent.messages. */
  replay() {
    this.post({ type: 'clear' });
    const msgs = this.agent.messages;
    const results = new Map(msgs.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]));
    let todos = null;
    for (const m of msgs) {
      if (m.role === 'user') {
        if (m._turn) this.post({ type: 'user', text: m._display || stripContext(m.content), turn: m._turn });
        else if (String(m.content).startsWith('[Summary')) this.post({ type: 'info', text: 'Earlier conversation was summarized.' });
      } else if (m.role === 'assistant') {
        if (m.content && m.content !== 'Understood. Continuing from the summary.' && m.content !== 'Noted.') {
          this.post({ type: 'assistantStart' }); this.post({ type: 'delta', text: m.content }); this.post({ type: 'assistantEnd' });
        }
        for (const tc of m.tool_calls || []) {
          let args; try { args = JSON.parse(tc.function.arguments); } catch { args = tc.function.arguments; }
          if (tc.function.name === 'todo_write' && args && args.todos) todos = args.todos;
          this.post({ type: 'tool', id: tc.id, name: tc.function.name, args: displayArgs(args) });
          const r = results.get(tc.id);
          if (r !== undefined) this.post({ type: 'toolResult', id: tc.id, ok: !/^(Error:|The user denied)/.test(r), output: String(r).slice(0, 8000), denied: /^The user denied/.test(r) });
        }
      }
    }
    if (todos) this.post({ type: 'todos', todos });
  }

  async revert(turn) {
    if (this.agent.busy) { this.post({ type: 'info', text: 'Stop the agent before rewinding.' }); return; }
    const files = this.agent.changedSince(turn).map((p) => vscode.workspace.asRelativePath(p));
    const detail = files.length
      ? `These files will be restored to their state before that message:\n${files.slice(0, 15).join('\n')}${files.length > 15 ? `\n…and ${files.length - 15} more` : ''}\n\nChanges made by shell commands are not tracked.`
      : 'No files were changed by the agent since that message.';
    const ok = await vscode.window.showWarningMessage('Rewind the conversation to this message?', { modal: true, detail }, 'Rewind');
    if (ok !== 'Rewind') return;
    const r = await this.agent.revertTo(turn);
    this.replay();
    this.post({ type: 'info', text: `Rewound${r.files.length ? `, restored ${r.files.length} file(s)` : ''}.` });
    if (r.skipped && r.skipped.length) this.post({ type: 'error', text: `Not restored (too large to keep a copy, over 2 MB): ${r.skipped.map((p) => vscode.workspace.asRelativePath(p)).join(', ')}` });
    if (r.text) this.post({ type: 'restoreInput', text: r.text });
    await this.saveChat();
  }
}

async function activate(context) {
  await migrateSettings();
  const provider = new ChatViewProvider(context);
  // Always-visible way back to the panel, wherever it is docked or hidden.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(comment-discussion) STARK Code';
  status.tooltip = 'Open the STARK Code chat (Ctrl+Alt+S)';
  status.command = 'oaiAgent.open';
  status.show();
  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('oaiAgent.open', () => vscode.commands.executeCommand('oaiAgent.chat.focus')),
    vscode.window.registerWebviewViewProvider('oaiAgent.chat', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, provider.proposedProvider),
    vscode.commands.registerCommand('oaiAgent.setApiKey', async () => {
      const v = await vscode.window.showInputBox({ prompt: 'API key for the OpenAI-compatible endpoint (leave empty to clear)', password: true, ignoreFocusOut: true });
      if (v === undefined) return;
      if (v) await context.secrets.store(SECRET_KEY, v); else await context.secrets.delete(SECRET_KEY);
      vscode.window.showInformationMessage(v ? 'STARK Code: API key saved.' : 'STARK Code: API key cleared.');
    }),
    vscode.commands.registerCommand('oaiAgent.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('oaiAgent.stop', () => provider.agent.stop()),
    vscode.commands.registerCommand('oaiAgent.approve', () => provider.answerOldest('yes')),
    vscode.commands.registerCommand('oaiAgent.deny', () => provider.answerOldest('no')),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG)) provider.sendConfig();
    }),
  );
  // Returned for the tests that run inside VS Code (test/vscode).
  return { provider };
}

function deactivate() {}

module.exports = { activate, deactivate };
