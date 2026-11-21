const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { Agent } = require('./agent');
const { listModels, testConnection } = require('./llm');

const SECRET_KEY = 'oaiAgent.apiKey';
const PROPOSED_SCHEME = 'oai-agent-proposed';

function getConfig() {
  const c = vscode.workspace.getConfiguration('oaiAgent');
  const keys = ['apiMode', 'baseUrl', 'model', 'models', 'contextWindow', 'maxTokens', 'temperature', 'maxSteps', 'approvalMode',
    'autoApproveCommands', 'autoApproveReadOnlyCommands', 'shell', 'commandTimeoutMs', 'maxToolOutputChars', 'extraHeaders', 'extraBody', 'customInstructions'];
  const o = {};
  for (const k of keys) o[k] = c.get(k);
  return o;
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
    this.proposals = new Map();   // id -> {path, newContent}
    this.serverModels = [];
    this.output = vscode.window.createOutputChannel('OAI Agent');
    this.chatsDir = vscode.Uri.joinPath(context.globalStorageUri, 'chats');
    this.proposedProvider = {
      provideTextDocumentContent: (uri) => {
        const p = this.proposals.get(new URLSearchParams(uri.query).get('id'));
        return p ? p.newContent : '';
      },
    };
    this.agent = new Agent({
      getConfig, getRoot,
      getApiKey: () => this.getKey(),
      ui: {
        post: (m) => this.post(m),
        log: (t) => this.output.append(t),
        registerProposal: (id, p) => this.proposals.set(id, p),
        approve: (req) => new Promise((resolve) => {
          this.pending.set(req.id, resolve);
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
    this.post({ type: 'config', model: c.model, baseUrl: c.baseUrl, models, approvalMode: c.approvalMode, apiMode: c.apiMode });
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
<div id="top"><select id="model" title="Model"></select><span class="sp"></span>
<button id="btnNew" title="New chat">New</button><button id="btnHistory" title="Past chats">History</button><button id="btnSetup" title="Connection setup">Setup</button></div>
<div id="panel" hidden></div>
<div id="log"></div>
<div id="todos" hidden></div>
<div id="bottom">
<textarea id="input" rows="3" placeholder="Ask the agent… (Enter to send, Shift+Enter for newline)"></textarea>
<div id="row"><label><input type="checkbox" id="ctx" checked> Include file/selection</label><span class="sp"></span><span id="usage"></span><button id="send">Send</button></div>
</div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;

    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: 'error', text: String(e.message || e) })));
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready': {
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
      case 'stop': this.agent.stop(); break;
      case 'new': await this.newChat(); break;
      case 'setModel': await vscode.workspace.getConfiguration('oaiAgent').update('model', m.model, vscode.ConfigurationTarget.Global); break;
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
        const r = await testConnection({ apiMode: m.apiMode, baseUrl: m.baseUrl, model: m.model, apiKey, headers: getConfig().extraHeaders, extraBody: getConfig().extraBody });
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
        const c = vscode.workspace.getConfiguration('oaiAgent');
        await c.update('baseUrl', m.baseUrl, vscode.ConfigurationTarget.Global);
        await c.update('model', m.model, vscode.ConfigurationTarget.Global);
        if (m.apiMode) await c.update('apiMode', m.apiMode, vscode.ConfigurationTarget.Global);
        // Only store the context window when it differs, so the default can change in later versions.
        if (m.contextWindow && Number(m.contextWindow) !== c.get('contextWindow')) await c.update('contextWindow', Number(m.contextWindow), vscode.ConfigurationTarget.Global);
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
      case 'openSettings': vscode.commands.executeCommand('workbench.action.openSettings', 'oaiAgent'); break;
      // ----- history -----
      case 'history': this.post({ type: 'history', items: await this.listChats() }); break;
      case 'loadChat': await this.loadChat(m.id); break;
      case 'deleteChat': {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.chatsDir, `${m.id}.json`)).then(undefined, () => {});
        this.post({ type: 'history', items: await this.listChats() });
        break;
      }
      // ----- rewind -----
      case 'revert': await this.revert(m.turn); break;
    }
  }

  async setupState() {
    const c = getConfig();
    return { apiMode: c.apiMode, baseUrl: c.baseUrl, model: c.model, contextWindow: c.contextWindow, hasKey: !!(await this.getKey()) };
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
    await vscode.workspace.fs.createDirectory(this.chatsDir);
    const data = Buffer.from(JSON.stringify(this.agent.toJSON()));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.chatsDir, `${this.agent.chatId}.json`), data);
  }

  async listChats() {
    let entries = [];
    try { entries = await vscode.workspace.fs.readDirectory(this.chatsDir); } catch { return []; }
    const root = getRoot();
    const items = [];
    for (const [name] of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        const d = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.chatsDir, name))).toString('utf8'));
        if (d.root === root) items.push({ id: d.id, title: d.title, updated: d.updated, current: d.id === this.agent.chatId });
      } catch { /* skip corrupt */ }
    }
    return items.sort((a, b) => b.updated - a.updated).slice(0, 100);
  }

  async loadChat(id) {
    if (this.agent.busy) { this.post({ type: 'info', text: 'Stop the agent before switching chats.' }); return; }
    await this.saveChat();
    const d = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.chatsDir, `${id}.json`))).toString('utf8'));
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
          this.post({ type: 'tool', id: tc.id, name: tc.function.name, args });
          const r = results.get(tc.id);
          if (r !== undefined) this.post({ type: 'toolResult', id: tc.id, ok: !/^(Error:|The user denied)/.test(r), output: String(r).slice(0, 8000) });
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
    if (r.text) this.post({ type: 'restoreInput', text: r.text });
    await this.saveChat();
  }
}

/** v0.3.0's Setup list could save the literal text "[object Object]" as the model; clear it. */
async function repairBadModelSetting() {
  const c = vscode.workspace.getConfiguration('oaiAgent');
  const info = c.inspect('model') || {};
  const bad = (v) => typeof v === 'string' && v.includes('[object Object]');
  if (bad(info.globalValue)) await c.update('model', undefined, vscode.ConfigurationTarget.Global);
  if (bad(info.workspaceValue)) await c.update('model', undefined, vscode.ConfigurationTarget.Workspace);
  const models = c.get('models') || [];
  if (models.some(bad)) await c.update('models', models.filter((m) => !bad(m)), vscode.ConfigurationTarget.Global);
}

/** Setup used to store the old 32000 default whenever it was saved; clear that once so the new default applies. */
async function migrateContextWindow(context) {
  if (context.globalState.get('migratedContextWindow')) return;
  const c = vscode.workspace.getConfiguration('oaiAgent');
  if ((c.inspect('contextWindow') || {}).globalValue === 32000) await c.update('contextWindow', undefined, vscode.ConfigurationTarget.Global);
  await context.globalState.update('migratedContextWindow', true);
}

function activate(context) {
  repairBadModelSetting().catch(() => {});
  migrateContextWindow(context).catch(() => {});
  const provider = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('oaiAgent.chat', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, provider.proposedProvider),
    vscode.commands.registerCommand('oaiAgent.setApiKey', async () => {
      const v = await vscode.window.showInputBox({ prompt: 'API key for the OpenAI-compatible endpoint (leave empty to clear)', password: true, ignoreFocusOut: true });
      if (v === undefined) return;
      if (v) await context.secrets.store(SECRET_KEY, v); else await context.secrets.delete(SECRET_KEY);
      vscode.window.showInformationMessage(v ? 'OAI Agent: API key saved.' : 'OAI Agent: API key cleared.');
    }),
    vscode.commands.registerCommand('oaiAgent.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('oaiAgent.stop', () => provider.agent.stop()),
    vscode.commands.registerCommand('oaiAgent.approve', () => provider.answerOldest('yes')),
    vscode.commands.registerCommand('oaiAgent.deny', () => provider.answerOldest('no')),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('oaiAgent')) provider.sendConfig();
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
