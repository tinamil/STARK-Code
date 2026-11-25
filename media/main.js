(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input'), send = $('send'), panel = $('panel'), modelSel = $('model');
  let busy = false, expiryWarned = false, budgetWarned = false, limitsTip = '', ctxText = '', creditText = '', cur = null, curText = '', curReasoning = null, renderPending = false;
  const toolEls = new Map();
  const IDLE_PLACEHOLDER = input.placeholder;
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
  // Follow new output only while the user is at the bottom; never yank the view while they read above.
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 200;
  const scroll = () => { if (nearBottom()) log.scrollTop = log.scrollHeight; };
  function add(cls, html) {
    const follow = nearBottom();
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.innerHTML = html;
    log.appendChild(d);
    if (follow) log.scrollTop = log.scrollHeight;
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
    input.placeholder = b ? 'Add instructions while the agent works… (Enter to queue; sent after the current step)' : IDLE_PLACEHOLDER;
  }
  function argSummary(name, a) {
    if (!a || typeof a !== 'object') return String(a || '').slice(0, 80);
    if (name === 'run_command') return a.command;
    if (name === 'todo_write') return `${(a.todos || []).length} items`;
    return a.path || a.pattern || a.url || '';
  }

  // ---------- input ----------
  function submit() {
    const text = input.value.trim();
    if (!text) return;
    const cmd = text.match(/^\/compact(?:\s+([\s\S]*))?$/i);
    if (busy) {
      // While the agent works, a message is queued and delivered after the current step.
      if (cmd) return;
      input.value = '';
      vscode.postMessage({ type: 'queue', text, includeContext: $('ctx').checked });
      return;
    }
    input.value = '';
    if (cmd) { vscode.postMessage({ type: 'compact', focus: cmd[1] || '' }); return; }
    vscode.postMessage({ type: 'send', text, includeContext: $('ctx').checked });
  }
  // The button is Stop while the agent works; Enter in the box queues a message instead.
  send.onclick = () => (busy ? vscode.postMessage({ type: 'stop' }) : submit());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  $('btnNew').onclick = () => vscode.postMessage({ type: 'new' });
  $('btnCompact').onclick = () => { if (!busy) vscode.postMessage({ type: 'compact', focus: '' }); };
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
    updatePendingBar();
  }
  // Keys answer a prompt only while focus is inside its card. (Elsewhere, Esc or Enter while reading
  // a tool call must not silently deny or allow something.)
  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const box = e.target.closest ? e.target.closest('.approval') : null;
    if (!box) return;
    const inFeedback = e.target.classList.contains('fb');
    if (e.key === 'Escape') { e.preventDefault(); answer(box, 'no'); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && box.querySelector('[data-a="diff"]')) { e.preventDefault(); answer(box, 'diff'); }
    else if (e.key === 'Enter' && inFeedback) { e.preventDefault(); answer(box, e.target.value.trim() ? 'no' : 'yes'); }
  });

  // A bar above the input whenever a prompt is waiting but scrolled out of view.
  const pendingBar = $('pendingBar');
  function showCard(box) {
    box.scrollIntoView({ block: 'center' });
    box.querySelector('[data-a="yes"]').focus({ preventScroll: true });
    updatePendingBar();
  }
  function updatePendingBar() {
    const box = pendingCards()[0];
    let hidden = true;
    if (box) {
      const r = box.getBoundingClientRect(), l = log.getBoundingClientRect();
      hidden = r.bottom > l.top + 20 && r.top < l.bottom - 20;   // any real part of the card is visible
    }
    pendingBar.hidden = hidden;
  }
  pendingBar.onclick = () => { const box = pendingCards()[0]; if (box) showCard(box); };
  log.addEventListener('scroll', updatePendingBar, { passive: true });
  log.addEventListener('toggle', updatePendingBar, true);   // <details> opened or closed
  window.addEventListener('resize', updatePendingBar);

  /** Unified diff from src/diff.js: {adds, dels, hunks:[{oldStart,newStart,lines:[[op,text]]}], truncated}. */
  function renderDiff(d) {
    if (!d.hunks.length) return '<div class="diff"><div class="hunk">No changes</div></div>';
    const rows = d.hunks.map((h) => {
      let o = h.oldStart, n = h.newStart;
      const lines = h.lines.map(([op, t]) => {
        const cls = op === '+' ? 'add' : op === '-' ? 'del' : 'ctx';
        const num = op === '+' ? n++ : op === '-' ? o++ : (o++, n++);
        return `<div class="dl ${cls}"><span class="ln">${num}</span><span class="sig">${op === ' ' ? ' ' : op === '-' ? '−' : '+'}</span><span class="tx">${esc(t) || ' '}</span></div>`;
      }).join('');
      return `<div class="hunk">Line ${h.newStart}</div>${lines}`;
    }).join('');
    return `<div class="diff">${rows}${d.truncated ? '<div class="hunk">More changes not shown. Open the full diff.</div>' : ''}</div>`;
  }

  /** Adds an "Unlock API key" button (opens the gateway's unlock page in the browser) and shows the URL. */
  function unlockButton(container, url) {
    const row = document.createElement('div');
    row.className = 'unlock';
    row.innerHTML = `<button class="primary">Unlock API key</button><span class="uurl">${esc(url)}</span>`;
    row.querySelector('button').onclick = () => vscode.postMessage({ type: 'openUnlock', url });
    container.appendChild(row);
  }

  // ---------- side panel (setup / history) ----------
  function closePanel() { panel.hidden = true; panel.innerHTML = ''; delete panel.dataset.kind; }
  function showSetup(m) {
    panel.dataset.kind = 'setup'; panel.hidden = false;
    panel.innerHTML = `<div class="ptitle">${m.first ? 'Welcome. Connect a model to get started.' : 'Connection'}</div>
      <label>API<select id="sApi"><option value="chat">Chat Completions (/chat/completions)</option><option value="responses">Responses (/responses)</option></select></label>
      <label>Base URL<input id="sBase" value="${esc(m.baseUrl || '')}" placeholder="https://api.genai.mil/v1"></label>
      <label>API key<input id="sKey" type="password" placeholder="${m.hasKey ? '•••••• (saved, leave blank to keep)' : 'optional for local servers'}"></label>
      <div class="field"><label for="sModel">Model</label>
        <div class="hrow"><input id="sModel" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="sList" aria-expanded="false" value="${esc(m.model || '')}" placeholder="Type to filter, or pick from the list">
        <button id="sToggle" title="Show all models" aria-label="Show all models">▾</button><button id="sFetch" title="Reload models from the server" aria-label="Reload models">↻</button></div>
        <div id="sList" class="clist" role="listbox" hidden></div>
        <div id="sHint" class="hint"></div></div>
      <label>Context window (tokens)<input id="sCtx" type="number" value="${m.contextWindow || 1000000}"></label>
      <div class="btns"><button id="sTest">Test connection</button><button id="sSave" class="primary">Save</button><span class="sp"></span>${m.hasKey ? '<button id="sClear" title="Delete saved key">Clear key</button>' : ''}<button id="sMore">All settings</button></div>
      <pre id="sOut" hidden></pre>`;
    $('sApi').value = m.apiMode || 'chat';
    const vals = () => ({ apiMode: $('sApi').value, baseUrl: $('sBase').value.trim(), model: $('sModel').value.trim(), apiKey: $('sKey').value, contextWindow: $('sCtx').value });
    combo.models = []; combo.state = 'loading'; combo.error = '';
    const loadModels = () => { combo.state = 'loading'; updateHint(); vscode.postMessage({ type: 'fetchModels', ...vals() }); };
    combo.load = loadModels;
    $('sFetch').onclick = loadModels;
    // Reload the list when the endpoint or key changes.
    $('sBase').addEventListener('change', loadModels);
    $('sKey').addEventListener('change', loadModels);
    const inp = $('sModel');
    inp.addEventListener('focus', () => openList(true));
    inp.addEventListener('click', () => openList(true));
    inp.addEventListener('input', () => { combo.all = false; openList(false); updateHint(); });
    // Close when focus leaves the model field (the list and its buttons keep focus on the input).
    inp.addEventListener('blur', (e) => { if (!(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.field'))) closeList(); });
    ['sToggle', 'sFetch'].forEach((id) => $(id).addEventListener('mousedown', (e) => e.preventDefault()));
    inp.addEventListener('keydown', (e) => {
      const open = !$('sList').hidden;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) { openList(true); return; }
        const n = combo.shown.length; if (!n) return;
        combo.active = (combo.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        renderList();
      } else if (e.key === 'Enter' && open && combo.active >= 0 && combo.shown[combo.active]) {
        e.preventDefault(); pick(combo.shown[combo.active].id);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault(); e.stopPropagation(); closeList();
      }
    });
    $('sToggle').onclick = () => { if ($('sList').hidden) { inp.focus(); openList(true); } else closeList(); };
    // Keep the list open while it re-renders after a reload.
    $('sFetch').addEventListener('click', () => inp.focus());
    $('sTest').onclick = () => vscode.postMessage({ type: 'testSetup', ...vals() });
    $('sSave').onclick = () => vscode.postMessage({ type: 'saveSetup', ...vals() });
    if ($('sClear')) $('sClear').onclick = () => vscode.postMessage({ type: 'saveSetup', ...vals(), apiKey: null });
    $('sMore').onclick = () => vscode.postMessage({ type: 'openSettings' });
    loadModels();
  }

  // ---------- model picker (in-panel list; native <datalist> popups are mispositioned in webviews) ----------
  const combo = { models: [], shown: [], active: -1, all: true, state: 'idle', error: '', load: null };
  function sortedModels() {
    return combo.models.slice().sort((a, b) => ((a.tools === false) - (b.tools === false)) || a.id.localeCompare(b.id));
  }
  function openList(showAll) {
    if (!$('sModel')) return;
    if (showAll) combo.all = true;
    combo.active = -1;
    renderList();
  }
  function closeList() {
    const l = $('sList'); if (!l) return;
    l.hidden = true; $('sModel').setAttribute('aria-expanded', 'false');
  }
  function pick(id) {
    $('sModel').value = id; closeList(); updateHint();
  }
  function renderList() {
    const l = $('sList'), inp = $('sModel'); if (!l) return;
    const q = inp.value.trim().toLowerCase();
    const all = sortedModels();
    combo.shown = combo.all || !q ? all : all.filter((m) => m.id.toLowerCase().includes(q));
    if (combo.active >= combo.shown.length) combo.active = combo.shown.length - 1;
    if (!combo.shown.length) {
      l.innerHTML = `<div class="cempty">${combo.state === 'loading' ? 'Loading models…' : combo.error ? 'Could not load models. Type the name instead.' : combo.models.length ? 'No matching models. The name you type will be used as-is.' : 'The server listed no models. Type the name instead.'}</div>`;
    } else {
      const cur = inp.value.trim();
      l.innerHTML = combo.shown.map((m, i) => `<div class="copt${i === combo.active ? ' active' : ''}${m.id === cur ? ' current' : ''}" role="option" id="sOpt${i}" data-id="${esc(m.id)}" aria-selected="${i === combo.active}"><span class="cname">${esc(m.id)}</span>${m.tools === false ? '<span class="ctag">no tools</span>' : ''}</div>`).join('');
      l.querySelectorAll('.copt').forEach((el) => el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(el.dataset.id); }));
      const act = l.querySelector('.copt.active'); if (act) act.scrollIntoView({ block: 'nearest' });
    }
    l.hidden = false;
    inp.setAttribute('aria-expanded', 'true');
    inp.setAttribute('aria-activedescendant', combo.active >= 0 ? `sOpt${combo.active}` : '');
  }
  function updateHint() {
    const h = $('sHint'); if (!h) return;
    const id = $('sModel').value.trim();
    const m = combo.models.find((x) => x.id === id);
    h.className = 'hint';
    if (combo.state === 'loading') h.textContent = 'Loading models from the server…';
    else if (combo.error) { h.className = 'hint bad'; h.textContent = `Could not load models: ${combo.error}`; }
    else if (m && m.tools === false) { h.className = 'hint bad'; h.textContent = 'The server says this model does not support tool calling. The agent needs it.'; }
    else if (id && combo.models.length && !m) { h.className = 'hint warn'; h.textContent = 'Not in the server\'s model list.'; }
    else h.textContent = combo.models.length ? `${combo.models.length} models available` : '';
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
    try { handle(ev.data); }
    catch (e) { add('error', esc(`Display problem (${ev.data && ev.data.type}): ${e.message}. If the chat looks wrong, reopen it from History.`)); }
    updatePendingBar();
  });
  function handle(m) {
    switch (m.type) {
      case 'config':
        modelSel.innerHTML = (m.models.length ? m.models : [{ id: '' }]).map((x) => `<option value="${esc(x.id)}"${x.id === m.model ? ' selected' : ''}>${esc(x.id || '(no model set)')}${x.noTools ? ' (no tools)' : ''}</option>`).join('');
        modelSel.title = `${m.model} @ ${m.baseUrl} (api: ${m.apiMode}, approval: ${m.approvalMode})`;
        break;
      case 'status': setBusy(m.busy); break;
      case 'clear': log.innerHTML = ''; $('todos').hidden = true; $('usage').textContent = ''; toolEls.clear(); cur = null; curText = ''; curReasoning = null; break;
      case 'queued': {
        const d = add('user queued', `<div class="ut">${esc(m.text).replace(/\n/g, '<br>')}</div><div class="qnote">Queued. Sent after the current step. <button class="qx" title="Remove this message">Remove</button></div>`);
        d.dataset.qid = m.id;
        d.querySelector('.qx').onclick = () => { vscode.postMessage({ type: 'unqueue', id: m.id }); d.remove(); };
        break;
      }
      case 'queuedLeft': {
        for (const id of m.ids) { const q = log.querySelector(`.queued[data-qid="${CSS.escape(id)}"]`); if (q) q.remove(); }
        input.value = [input.value.trim(), m.text].filter(Boolean).join('\n\n');
        add('info', 'Your queued message was not sent. It is back in the input box.');
        break;
      }
      case 'toolOutput': {
        const d = toolEls.get(m.id);
        if (!d) break;
        let live = d.querySelector('.live');
        if (!live) { live = document.createElement('pre'); live.className = 'live'; d.appendChild(live); }
        const follow = nearBottom();
        live.textContent = (live.textContent + m.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-3000);
        live.scrollTop = live.scrollHeight;
        if (follow) log.scrollTop = log.scrollHeight;
        break;
      }
      case 'user': {
        if (m.queuedId) { const q = log.querySelector(`.queued[data-qid="${CSS.escape(m.queuedId)}"]`); if (q) q.remove(); }
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
        const st = d.querySelector('.st'), out = d.querySelector('.out');
        const liveOut = d.querySelector('.live'); if (liveOut) liveOut.remove();
        if (st) st.textContent = m.denied ? '⊘' : m.ok ? '✓' : '✗';
        if (m.denied) {
          d.classList.add('denied');
          const sum = d.querySelector('summary');
          if (sum && !sum.querySelector('.badge')) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'Denied by you'; sum.insertBefore(b, sum.querySelector('.arg')); sum.insertBefore(document.createTextNode(' '), sum.querySelector('.arg')); }
        }
        if (out) out.textContent = m.output;
        const ap = d.querySelector('.approval'); if (ap) ap.remove();
        break;
      }
      case 'approval': {
        const d = toolEls.get(m.id) || add('tool', '');
        const box = document.createElement('div');
        box.className = 'approval' + (m.warning ? ' danger' : '');
        box.dataset.id = m.id;
        const mod = isMac ? '⌘' : 'Ctrl';
        const title = m.name === 'run_command' ? 'Run this command?' : m.name === 'web_fetch' ? 'Fetch this URL?' : m.diff ? `${esc(m.summary)}?` : `Allow <b>${esc(m.name)}</b>?`;
        box.innerHTML = `<div class="q">${title}</div>${m.explanation ? `<div class="why">${esc(m.explanation)}</div>` : ''}${m.warning ? `<div class="warn">⚠ ${esc(m.warning)}</div>` : ''}
          ${m.diff ? renderDiff(m.diff) : `<pre>${esc(m.summary)}</pre>`}
          <input class="fb" placeholder="Feedback (Enter denies with this message)">
          <div class="btns"><button data-a="yes" class="primary">Allow</button>${m.canDiff ? '<button data-a="diff">Open in diff editor</button>' : ''}${m.allowAlways ? `<button data-a="always">${m.warning === 'This reads outside the workspace.' ? 'Always allow outside reads' : `Always allow ${esc(m.name)}`}</button>` : ''}<button data-a="no" class="deny">Deny</button></div>
          <div class="keys">Enter allow · Esc deny${m.canDiff ? ` · ${mod}+Enter diff` : ''} · from anywhere: ${mod}+Alt+Y / ${mod}+Alt+N</div>`;
        box.addEventListener('click', (e) => { const a = e.target.dataset && e.target.dataset.a; if (a) answer(box, a); });
        const old = d.querySelector('.approval'); if (old) old.remove();   // re-sent after the panel reloaded
        const follow = nearBottom();
        d.appendChild(box);
        if (follow) log.scrollTop = log.scrollHeight;
        // Only take focus if the panel already has it — never steal focus from the editor.
        if (document.hasFocus() && follow && pendingCards()[0] === box) box.querySelector('[data-a="yes"]').focus({ preventScroll: true });
        break;
      }
      case 'toolDiff': {
        const d = toolEls.get(m.id);
        if (!d) break;
        const det = d.querySelector('details');
        if (!det) break;
        d.querySelector('.arg').textContent = m.summary.replace(/^(Edit|Create|Overwrite) /, '');
        const args = det.querySelector('.args'); if (args) args.remove();
        const box = document.createElement('div');
        box.innerHTML = (m.explanation ? `<div class="why">${esc(m.explanation)}</div>` : '') + renderDiff(m.diff);
        det.insertBefore(box, det.querySelector('.out'));
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
        const fmt = (n) => Number(n).toLocaleString();
        const inS = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`);
        if (x.creditsRemaining !== undefined) {
          creditText = `${fmt(x.creditsRemaining)}${x.creditsLimit !== undefined ? ` / ${fmt(x.creditsLimit)}` : ''} credits`;
          $('usage').textContent = [ctxText, creditText].filter(Boolean).join(' · ');
          if (x.creditsLimit && x.creditsRemaining < x.creditsLimit * 0.1 && !budgetWarned) {
            budgetWarned = true;
            add('info warn', esc(`⚠ Less than 10% of today's credits left (${fmt(x.creditsRemaining)} of ${fmt(x.creditsLimit)})${x.creditsResetS !== undefined ? `; they reset in ${inS(x.creditsResetS)}` : ''}. Long conversations use the most; /compact or a new chat uses less.`));
          }
        }
        const tip = [
          x.creditsRemaining !== undefined ? `Daily credits: ${fmt(x.creditsRemaining)}${x.creditsLimit !== undefined ? ` of ${fmt(x.creditsLimit)}` : ''} left${x.creditsResetS !== undefined ? `, resets in ${inS(x.creditsResetS)}` : ''}` : '',
          x.tokensRemaining !== undefined ? `Tokens this minute: ${fmt(x.tokensRemaining)}${x.tokensLimit !== undefined ? ` of ${fmt(x.tokensLimit)}` : ''} left` : '',
          x.requestsRemaining !== undefined ? `Requests this minute: ${fmt(x.requestsRemaining)}${x.requestsLimit !== undefined ? ` of ${fmt(x.requestsLimit)}` : ''} left` : '',
        ].filter(Boolean).join('\n');
        if (tip) { limitsTip = tip; $('usage').title = tip; }
        if (x.keyExpiringSoon && !expiryWarned) {
          expiryWarned = true;
          add('info warn', esc(`⚠ Your API key expires ${x.keyExpiresAt ? new Date(x.keyExpiresAt).toLocaleString() : 'within 7 days'}. Renew it, then update it under Setup.`));
        }
        break;
      }
      case 'setup': showSetup(m); break;
      case 'setupModels': {
        if (!$('sModel')) break;
        combo.models = (m.models || []).map((x) => (typeof x === 'string' ? { id: x } : x)).filter((x) => x && x.id);
        combo.state = 'idle'; combo.error = m.error || '';
        if (!$('sList').hidden) renderList();
        updateHint();
        break;
      }
      case 'testResult': {
        const o = $('sOut'); if (!o) break;
        o.hidden = false;
        o.className = m.running ? '' : m.ok ? 'good' : 'bad';
        o.textContent = m.running ? 'Testing… (sends one or two small requests)' : m.lines.join('\n');
        const oldU = o.parentNode.querySelector('.unlock'); if (oldU) oldU.remove();
        if (m.unlockUrl) { const holder = document.createElement('div'); o.after(holder); unlockButton(holder, m.unlockUrl); holder.replaceWith(...holder.childNodes); }
        if (m.suggestMode && $('sApi')) { $('sApi').value = m.suggestMode; o.textContent += `\n\nAPI switched to "${m.suggestMode}". Click Save to keep it.`; }
        break;
      }
      case 'history': showHistory(m.items); break;
      case 'panelClose': closePanel(); break;
      case 'compacted': {
        const d = add('info compacted', `Conversation compacted: about ${Math.round(m.before / 1000)}k → ${Math.round(m.after / 1000)}k tokens. Files and Rewind for earlier edits are unaffected. <details><summary>Summary the agent kept</summary><pre></pre></details>`);
        d.querySelector('pre').textContent = m.summary;
        $('usage').textContent = '';
        break;
      }
      case 'info': add(m.warn ? 'info warn' : 'info', esc(m.text)); break;
      case 'error': {
        const d = add('error', esc(m.text));
        if (m.unlockUrl) unlockButton(d, m.unlockUrl);
        break;
      }
    }
  }

  vscode.postMessage({ type: 'ready' });
})();
