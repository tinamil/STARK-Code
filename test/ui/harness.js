// Loads the real panel (media/main.js + main.css + src/panelhtml.js) in headless Chromium with a
// stand-in for VS Code's webview API. Messages the panel posts are collected in window.sent.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { panelBody } = require('../../src/panelhtml');

let playwright = null;
try { playwright = require('playwright'); } catch { /* not installed */ }
if (!playwright && process.env.REQUIRE_UI === '1') throw new Error('Playwright is required (REQUIRE_UI=1) but is not installed. Run: npm ci && npx playwright install chromium');
const skip = playwright ? false : 'Playwright not installed (npm ci && npx playwright install chromium)';

const THEME = `:root{--vscode-font-family:sans-serif;--vscode-font-size:13px;--vscode-foreground:#ccc;--vscode-panel-border:#2b2b2b;
--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;
--vscode-button-secondaryHoverBackground:#3c3c3c;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-input-border:#3c3c3c;
--vscode-focusBorder:#0078d4;--vscode-errorForeground:#f85149;--vscode-editor-font-family:monospace;--vscode-textCodeBlock-background:#2b2b2b;}
html,body{background:#181818}`;

let browser = null, dir = null;
async function openPanel({ width = 520, height = 700 } = {}) {
  if (!browser) browser = await playwright.chromium.launch();
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stark-ui-'));
    const media = path.join(__dirname, '..', '..', 'media');
    fs.copyFileSync(path.join(media, 'main.js'), path.join(dir, 'main.js'));
    fs.copyFileSync(path.join(media, 'main.css'), path.join(dir, 'main.css'));
    fs.writeFileSync(path.join(dir, 'index.html'), `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${THEME}</style>
<link rel="stylesheet" href="main.css"></head><body>${panelBody()}
<script>window.sent=[];window.acquireVsCodeApi=()=>({postMessage(m){window.sent.push(m)}});</script><script src="main.js"></script></body></html>`);
  }
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + path.join(dir, 'index.html'));
  return {
    page, errors,
    /** Deliver a message from the extension to the panel. */
    send: (m) => page.evaluate((x) => window.dispatchEvent(new MessageEvent('message', { data: x })), m),
    /** Messages the panel posted to the extension since the last call (without the initial "ready"). */
    sent: () => page.evaluate(() => window.sent.splice(0).filter((m) => m.type !== 'ready')),
    close: () => page.close(),
  };
}
async function closeBrowser() { if (browser) { await browser.close(); browser = null; } }

module.exports = { openPanel, closeBrowser, skip };
