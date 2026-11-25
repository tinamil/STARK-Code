const test = require('node:test');
const assert = require('node:assert');
const { resolveShell, decodeCliXml } = require('../src/shell');
const { findPowerShell } = require('../src/psreadonly');
const { getTool } = require('../src/tools');
const { buildSystemPrompt } = require('../src/prompt');
const { tempWorkspace, makeAgent } = require('./helpers');

test('shell choice: PowerShell by default on Windows, system shell elsewhere, setting overrides', () => {
  assert.deepStrictEqual(resolveShell({}, 'win32', () => 'pwsh.exe'), { kind: 'powershell', exe: 'pwsh.exe', name: 'PowerShell 7' });
  assert.deepStrictEqual(resolveShell({}, 'win32', () => 'powershell.exe'), { kind: 'powershell', exe: 'powershell.exe', name: 'Windows PowerShell 5.1' });
  assert.strictEqual(resolveShell({}, 'win32', () => null).kind, 'cmd');
  assert.strictEqual(resolveShell({}, 'linux', () => 'pwsh').kind, 'posix');
  assert.strictEqual(resolveShell({ shell: 'cmd.exe' }, 'win32', () => 'pwsh.exe').kind, 'cmd');
  assert.strictEqual(resolveShell({ shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }, 'win32').kind, 'powershell');
  assert.strictEqual(resolveShell({ shell: '/bin/zsh' }, 'darwin').kind, 'posix');
});

test('the system prompt tells the model which shell it has', () => {
  const root = tempWorkspace();
  assert.match(buildSystemPrompt(root, { shell: 'pwsh' }), /- Shell: Commands run in PowerShell\. Use PowerShell syntax and cmdlets\./);
  assert.match(buildSystemPrompt(root, { shell: 'cmd.exe' }), /- Shell: Commands run in cmd\.exe\./);
});

test('Windows PowerShell 5.1 error blocks (CLIXML) are turned back into plain text', () => {
  // The exact shape captured from Windows PowerShell 5.1 in CI.
  const raw = 'before\r\n#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Get-Content : Cannot find path \'C:\\t\\missing-file.txt\' because it _x000D__x000A_</S><S S="Error">does not exist &amp; &lt;gone&gt;._x000D__x000A_</S><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj></Objs>after';
  assert.strictEqual(decodeCliXml(raw), "before\r\nGet-Content : Cannot find path 'C:\\t\\missing-file.txt' because it \ndoes not exist & <gone>.\nafter");
  assert.strictEqual(decodeCliXml('plain output'), 'plain output');
  assert.strictEqual(decodeCliXml('#< CLIXML\r\n'), '');
});

// PowerShell as the command shell: every PowerShell found on this machine (CI adds Windows PowerShell 5.1).
const found = findPowerShell();
if (!found && process.env.REQUIRE_POWERSHELL === '1') throw new Error('PowerShell is required (REQUIRE_POWERSHELL=1) but was not found');
const shells = found ? [found] : [];
if (process.platform === 'win32' && !/powershell\.exe$/i.test(found || '')) shells.push('powershell.exe');
for (const exe of shells) {
  const root = tempWorkspace({ 'a b.txt': 'héllo\n' });
  const run = (command, extra = {}) => getTool('run_command').run({ command, ...extra }, { root, cfg: { shell: exe, commandTimeoutMs: 60000 }, signal: new AbortController().signal });
  const t = (name, fn) => test(`${exe}: ${name}`, fn);

  t('quotes, pipes and variables reach PowerShell unchanged', async () => {
    const out = await run(`$x = "a b"; Write-Output "$x|c" 'd "e"'; @(1,2,3) | Measure-Object | ForEach-Object { $_.Count }`);
    assert.match(out, /^Exit code: 0\r?\n/);
    assert.deepStrictEqual(out.split(/\r?\n/).slice(1).filter(Boolean), ['a b|c', 'd "e"', '3']);
  });
  t('reads a file with spaces and non-ASCII text as UTF-8', async () => {
    const out = await run(`Get-Content -Encoding UTF8 'a b.txt'`);
    assert.match(out, /^Exit code: 0\r?\nhéllo/);
  });
  t('a program\'s exit code is reported', async () => {
    assert.match(await run(`node -e "console.log('out'); console.error('err'); process.exit(3)"`), /^Exit code: 3\r?\n[\s\S]*out[\s\S]*err|^Exit code: 3\r?\n[\s\S]*err[\s\S]*out/);
    assert.match(await run(`node -e "process.exit(0)"; Write-Output done`), /^Exit code: 0\r?\ndone/);
  });
  t('a failing cmdlet gives a non-zero exit code and its error text, with no CLIXML noise', async () => {
    const out = await run(`Get-Content 'missing-file.txt'`);
    assert.match(out, /^Exit code: 1\r?\n/);
    assert.match(out, /missing-file\.txt/);
    assert.ok(!/CLIXML/.test(out), out);
  });
  t('runs in the requested working directory', async () => {
    const out = await run(`(Get-Location).Path`, { cwd: '.' });
    assert.ok(out.toLowerCase().includes(require('fs').realpathSync(root).toLowerCase().slice(-12)), out);
  });
  t('read-only scripts are recognised when PowerShell is the shell', async () => {
    const { agent, cfg } = makeAgent({ base: 'http://127.0.0.1:1/v1', root, config: { shell: exe } });
    assert.strictEqual(await agent.isReadOnlyCommand({ command: `Get-ChildItem | Where-Object { $_.Length -gt 0 } | Select-Object -ExpandProperty Name` }, cfg, root), true);
    assert.strictEqual(await agent.isReadOnlyCommand({ command: `Get-ChildItem | Remove-Item` }, cfg, root), false);
    assert.strictEqual(await agent.isReadOnlyCommand({ command: `Get-Content 'a b.txt'` }, cfg, root), true);
  });
}
