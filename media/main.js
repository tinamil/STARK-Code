(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input'), send = $('send'), panel = $('panel'), modelSel = $('model');
  let busy = false, expiryWarned = false, ctxText = '', creditText = '', cur = null, curText = '', curReasoning = null, renderPending = false;
  const toolEls = new Map();
  const isMac = navigator.platform.toUpperCase().includes('MAC');

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function inline(s) {
    return s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  }
  function md(src) {
    const parts = src.split('```');
    let html = '';
    parts.forEach((p, i) => {
      if (i % 2 === 1) {
        const nl = p.indexOf('\n');
        html += `<pre><code>${esc(nl >= 0 ? p.slice(nl + 1) : p)}</code></pre>`;
        return;
      }
      let inList = null;
      for (const raw of esc(p).split('\n')) {
        let m;
        const close = () => { if (inList) { html += `</${inList}>`; inList = null; } };
        if ((m = raw.match(/^(#{1,6})\s+(.*)/))) { close(); html += `<div class="h">${inline(m[2])}</div>`; }
        else if ((m = raw.match(/^\s*[-*]\s+(.*)/))) { if (inList !== 'ul') { close(); html += '<ul>'; inList = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
        else if ((m = raw.match(/^\s*\d+[.)]\s+(.*)/))) { if (inList !== 'ol') { close(); html += '<ol>'; inList = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
        else if (raw.trim() === '') { close(); html += '<div class="gap"></div>'; }
        else { close(); html += `<div>${inline(raw)}</div>`; }
      }
      if (inList) html += `</${inList}>`;
    });
    return html;
  }
  const scroll = () => { if (log.scrollHeight - log.scrollTop - log.clientHeight < 200) log.scrollTop = log.scrollHeight; };
  function add(cls, html) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.innerHTML = html;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  function render() {
    renderPending = false;
    if (cur) { cur.querySelector('.body').innerHTML = md(curText); scroll(); }
  }
  function setBusy(b) {
    busy = b;
    send.textContent = b ? 'Stop' : 'Send';
    send.classList.toggle('stop', b);
    document.body.classList.toggle('busy', b);
  }
  function argSummary(name, a) {
    if (!a || typeof a !== 'object') return String(a || '').slice(0, 80);
    if (name === 'run_command') return a.command;
    if (name === 'todo_write') return `${(a.todos || []).length} items`;
    return a.path || a.pattern || a.url || '';
  }

  // ---------- input ----------
  function submit() {
    if (busy) { vscode.postMessage({ type: 'stop' }); return; }
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text, includeContext: $('ctx').checked });
  }
  send.onclick = submit;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  $('btnNew').onclick = () => vscode.postMessage({ type: 'new' });
  $('btnSetup').onclick = () => (panel.dataset.kind === 'setup' && !panel.hidden) ? closePanel() : vscode.postMessage({ type: 'getSetup' });
  $('btnHistory').onclick = () => (panel.dataset.kind === 'history' && !panel.hidden) ? closePanel() : vscode.postMessage({ type: 'history' });
  modelSel.onchange = () => vscode.postMessage({ type: 'setModel', model: modelSel.value });

  // ---------- approvals ----------
  const pendingCards = () => [...document.querySelectorAll('.approval')];
  function answer(box, decision) {
    if (decision === 'diff') { vscode.postMessage({ type: 'diff', id: box.dataset.id }); return; }
    vscode.postMessage({ type: 'approve', id: box.dataset.id, decision, feedback: box.querySelector('.fb').value });
    box.remove();
    const next = pendingCards()[0];
    if (next && document.hasFocus()) next.querySelector('[data-a="yes"]').focus();
    else if (document.hasFocus()) input.focus();
  }
  document.addEventListener('keydown', (e) => {
    const box = pendingCards()[0];
    if (!box || e.isComposing) return;
    const inFeedback = e.target.classList && e.target.classList.contains('fb');
    if (e.key === 'Escape') { e.preventDefault(); answer(box, 'no'); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && box.querySelector('[data-a="diff"]')) { e.preventDefault(); answer(box, 'diff'); }
    else if (e.key === 'Enter' && inFeedback) { e.preventDefault(); answer(e.target.closest('.approval'), e.target.value.trim() ? 'no' : 'yes'); }
    else if (e.key === 'Enter' && e.target === document.body) { e.preventDefault(); answer(box, 'yes'); }
  });

  // ---------- side panel (setup / history) ----------
  function closePanel() { panel.hidden = true; panel.innerHTML = ''; delete panel.dataset.kind; }
  function showSetup(m) {
    panel.dataset.kind = 'setup'; panel.hidden = false;
    panel.innerHTML = `<div class="ptitle">${m.first ? 'Welcome. Connect a model to get started.' : 'Connection'}</div>
      <label>API<select id="sApi"><option value="chat">Chat Completions (/chat/completions)</option><option value="responses">Responses (/responses)</option></select></label>
      <label>Base URL<input id="sBase" value="${esc(m.baseUrl || '')}" placeholder="http://localhost:11434/v1"></label>
      <label>API key<input id="sKey" type="password" placeholder="${m.hasKey ? '•••••• (saved, leave blank to keep)' : 'optional for local servers'}"></label>
      <label>Model<div class="hrow"><input id="sModel" list="sModels" value="${esc(m.model || '')}" placeholder="model name"><button id="sFetch" title="Load models from server">Load</button></div><datalist id="sModels"></datalist></label>
      <label>Context window (tokens)<input id="sCtx" type="number" value="${m.contextWindow || 32000}"></label>
      <div class="btns"><button id="sTest">Test connection</button><button id="sSave" class="primary">Save</button><span class="sp"></span>${m.hasKey ? '<button id="sClear" title="Delete saved key">Clear key</button>' : ''}<button id="sMore">All settings</button></div>
      <pre id="sOut" hidden></pre>`;
    $('sApi').value = m.apiMode || 'chat';
    const vals = () => ({ apiMode: $('sApi').value, baseUrl: $('sBase').value.trim(), model: $('sModel').value.trim(), apiKey: $('sKey').value, contextWindow: $('sCtx').value });
    $('sFetch').onclick = () => vscode.postMessage({ type: 'fetchModels', ...vals() });
    $('sTest').onclick = () => vscode.postMessage({ type: 'testSetup', ...vals() });
    $('sSave').onclick = () => vscode.postMessage({ type: 'saveSetup', ...vals() });
    if ($('sClear')) $('sClear').onclick = () => vscode.postMessage({ type: 'saveSetup', ...vals(), apiKey: null });
    $('sMore').onclick = () => vscode.postMessage({ type: 'openSettings' });
    vscode.postMessage({ type: 'fetchModels', ...vals() });
  }
  function showHistory(items) {
    panel.dataset.kind = 'history'; panel.hidden = false;
    panel.innerHTML = `<div class="ptitle">Chats in this workspace</div>` + (items.length ? items.map((it) =>
      `<div class="hitem${it.current ? ' current' : ''}" data-id="${esc(it.id)}"><span class="ht">${esc(it.title)}</span><span class="hd">${new Date(it.updated).toLocaleString()}</span><button class="hdel" title="Delete">✕</button></div>`).join('')
      : '<div class="muted">No saved chats yet.</div>');
    panel.querySelectorAll('.hitem').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.classList.contains('hdel')) vscode.postMessage({ type: 'deleteChat', id: el.dataset.id });
        else vscode.postMessage({ type: 'loadChat', id: el.dataset.id });
      };
    });
  }

  // ---------- messages from extension ----------
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'config':
        modelSel.innerHTML = (m.models.length ? m.models : [{ id: '' }]).map((x) => `<option value="${esc(x.id)}"${x.id === m.model ? ' selected' : ''}>${esc(x.id || '(no model set)')}${x.noTools ? ' (no tools)' : ''}</option>`).join('');
        modelSel.title = `${m.model} @ ${m.baseUrl} (api: ${m.apiMode}, approval: ${m.approvalMode})`;
        break;
      case 'status': setBusy(m.busy); break;
      case 'clear': log.innerHTML = ''; $('todos').hidden = true; $('usage').textContent = ''; toolEls.clear(); break;
      case 'user': {
        const d = add('user', `<div class="ut">${esc(m.text).replace(/\n/g, '<br>')}</div><button class="rewind" title="Rewind: restore files the agent changed since this message and edit it">↶ Rewind</button>`);
        d.querySelector('.rewind').onclick = () => vscode.postMessage({ type: 'revert', turn: m.turn });
        break;
      }
      case 'restoreInput': input.value = m.text; input.focus(); break;
      case 'assistantStart':
        curText = ''; curReasoning = null;
        cur = add('assistant', '<div class="body"></div>');
        break;
      case 'delta':
        curText += m.text;
        if (!renderPending) { renderPending = true; requestAnimationFrame(render); }
        break;
      case 'reasoning':
        if (!cur) break;
        if (!curReasoning) {
          const d = document.createElement('details');
          d.className = 'reasoning';
          d.innerHTML = '<summary>Thinking…</summary><pre></pre>';
          cur.insertBefore(d, cur.firstChild);
          curReasoning = d.querySelector('pre');
        }
        curReasoning.textContent += m.text;
        break;
      case 'assistantEnd':
        render();
        if (cur && !curText.trim() && !curReasoning) cur.remove();
        cur = null;
        break;
      case 'tool': {
        const d = add('tool', `<details><summary><span class="st">…</span> <b>${esc(m.name)}</b> <span class="arg">${esc(argSummary(m.name, m.args))}</span></summary><pre class="args">${esc(typeof m.args === 'string' ? m.args : JSON.stringify(m.args, null, 2))}</pre><pre class="out"></pre></details>`);
        toolEls.set(m.id, d);
        break;
      }
      case 'toolResult': {
        const d = toolEls.get(m.id);
        if (!d) break;
        d.classList.add(m.ok ? 'ok' : 'fail');
        d.querySelector('.st').textContent = m.ok ? '✓' : '✗';
        d.querySelector('.out').textContent = m.output;
        const ap = d.querySelector('.approval'); if (ap) ap.remove();
        break;
      }
      case 'approval': {
        const d = toolEls.get(m.id) || add('tool', '');
        const box = document.createElement('div');
        box.className = 'approval' + (m.warning ? ' danger' : '');
        box.dataset.id = m.id;
        const mod = isMac ? '⌘' : 'Ctrl';
        box.innerHTML = `<div class="q">Allow <b>${esc(m.name)}</b>?</div>${m.warning ? `<div class="warn">⚠ ${esc(m.warning)}</div>` : ''}<pre>${esc(m.summary)}</pre>
          <input class="fb" placeholder="Feedback (Enter denies with this message)">
          <div class="btns"><button data-a="yes" class="primary">Allow</button>${m.canDiff ? '<button data-a="diff">View diff</button>' : ''}${m.allowAlways ? `<button data-a="always">Always allow ${esc(m.name)}</button>` : ''}<button data-a="no" class="deny">Deny</button></div>
          <div class="keys">Enter allow · Esc deny${m.canDiff ? ` · ${mod}+Enter diff` : ''} · from editor: ${mod}+Alt+Y / ${mod}+Alt+N</div>`;
        box.addEventListener('click', (e) => { const a = e.target.dataset && e.target.dataset.a; if (a) answer(box, a); });
        d.appendChild(box);
        log.scrollTop = log.scrollHeight;
        // Only take focus if the panel already has it — never steal focus from the editor.
        if (document.hasFocus() && pendingCards()[0] === box) box.querySelector('[data-a="yes"]').focus();
        break;
      }
      case 'approvalDone': {
        const box = document.querySelector(`.approval[data-id="${CSS.escape(m.id)}"]`);
        if (box) box.remove();
        break;
      }
      case 'todos': {
        const t = $('todos');
        t.hidden = !m.todos.length;
        t.innerHTML = m.todos.map((x) => `<div class="todo ${x.status}">${x.status === 'completed' ? '☑' : x.status === 'in_progress' ? '▶' : '☐'} ${esc(x.content)}</div>`).join('');
        break;
      }
      case 'usage': {
        const u = m.usage || {};
        const used = u.prompt_tokens || m.est;
        ctxText = used ? `${Math.round(used / 1000)}k / ${Math.round(m.window / 1000)}k ctx` : '';
        $('usage').textContent = [ctxText, creditText].filter(Boolean).join(' · ');
        break;
      }
      case 'meta': {
        const x = m.meta;
        if (x.creditsRemaining !== undefined) {
          creditText = `${x.creditsRemaining.toLocaleString()}${x.creditsLimit !== undefined ? ` / ${x.creditsLimit.toLocaleString()}` : ''} credits`;
          $('usage').textContent = [ctxText, creditText].filter(Boolean).join(' · ');
          $('usage').title = 'Daily credits remaining (from gateway headers)';
        }
        if (x.keyExpiringSoon && !expiryWarned) {
          expiryWarned = true;
          add('info warn', esc(`⚠ Your API key expires ${x.keyExpiresAt ? new Date(x.keyExpiresAt).toLocaleString() : 'within 7 days'}. Renew it, then update it under Setup.`));
        }
        break;
      }
      case 'setup': showSetup(m); break;
      case 'setupModels': {
        const dl = $('sModels'); if (!dl) break;
        dl.innerHTML = m.models.map((x) => {
          const id = typeof x === 'string' ? x : x.id;
          return `<option value="${esc(id)}"${x.tools === false ? ' label="no tool calling"' : ''}>`;
        }).join('');
        if (m.error && $('sOut')) { $('sOut').hidden = false; $('sOut').textContent = `Could not load models: ${m.error}`; }
        break;
      }
      case 'testResult': {
        const o = $('sOut'); if (!o) break;
        o.hidden = false;
        o.className = m.running ? '' : m.ok ? 'good' : 'bad';
        o.textContent = m.running ? 'Testing… (sends one or two small requests)' : m.lines.join('\n');
        if (m.suggestMode && $('sApi')) { $('sApi').value = m.suggestMode; o.textContent += `\n\nAPI switched to "${m.suggestMode}". Click Save to keep it.`; }
        break;
      }
      case 'history': showHistory(m.items); break;
      case 'panelClose': closePanel(); break;
      case 'info': add('info', esc(m.text)); break;
      case 'error': add('error', esc(m.text)); break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
