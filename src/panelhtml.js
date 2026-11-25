// The panel's static markup, shared by the extension and the panel tests (test/ui).
function panelBody() {
  return `<div id="top"><select id="model" title="Model"></select><span class="sp"></span>
<button id="btnNew" title="New chat">New</button><button id="btnHistory" title="Past chats">History</button><button id="btnSetup" title="Connection setup">Setup</button></div>
<div id="panel" hidden></div>
<div id="log"></div>
<button id="pendingBar" hidden>Waiting for your approval. Show the prompt ↓</button>
<div id="todos" hidden></div>
<div id="bottom">
<textarea id="input" rows="3" placeholder="Ask the agent… (Enter to send, Shift+Enter for newline, /compact to summarize)"></textarea>
<div id="row"><label><input type="checkbox" id="ctx" checked> Include file/selection</label><span class="sp"></span><span id="usage"></span><button id="btnCompact" title="Summarize the conversation to free up context. Tip: type /compact followed by what to keep.">Compact</button><button id="send">Send</button></div>
</div>`;
}

module.exports = { panelBody };
