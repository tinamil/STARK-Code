// Uses PowerShell's real parser. Skipped when PowerShell isn't installed, unless REQUIRE_POWERSHELL=1 (CI).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { classifyPowerShell, extractScript, evaluate, findPowerShell } = require('../src/psreadonly');

const root = path.resolve('/work/proj');
const have = !!findPowerShell();
if (!have && process.env.REQUIRE_POWERSHELL === '1') throw new Error('PowerShell is required (REQUIRE_POWERSHELL=1) but was not found');
const opts = { skip: have ? false : 'PowerShell not installed' };

const bracketScript = `@('cdap-website/js/main.js','cdap-website/js/catalog-grouping.js') | ForEach-Object { $txt = Get-Content -Raw $_; $b1 = ([regex]::Matches($txt, '\\{')).Count - ([regex]::Matches($txt, '\\}')).Count; Write-Host ($_ + ' => {}:' + $b1) }`;
const allowed = [
  bracketScript,
  'Get-ChildItem -Recurse -Filter *.js src | Select-Object -ExpandProperty FullName',
  "Get-Content src/app.ts | Select-String 'TODO' | Measure-Object | Select-Object -ExpandProperty Count",
  "$files = Get-ChildItem src -Recurse -Include *.ts; foreach ($f in $files) { '{0}: {1}' -f $f.Name, (Get-Content $f.FullName).Count }",
  'Get-Content package.json -Raw | ConvertFrom-Json | Select-Object -ExpandProperty scripts',
  '(Get-Content README.md).Length',
  'Get-ChildItem src | Where-Object { $_.Length -gt 1000 } | Sort-Object Length -Descending | Format-Table Name, Length',
  "Select-String -Path src/*.js -Pattern '/api/v1' | ForEach-Object { $_.LineNumber }",
  "[System.IO.Path]::GetExtension('src/a.ts')",
  "$t = Get-Content -Raw 'a.txt'; $t.Split([Environment]::NewLine).Count",
  'Get-ChildItem 2>&1 | Out-String',
];
const asks = [
  'Get-ChildItem *.tmp | Remove-Item', 'Get-ChildItem *.tmp | ForEach-Object Delete', 'Get-ChildItem *.tmp | % { $_.Delete() }',
  "(Get-ChildItem *.tmp).ForEach('Delete')", 'Get-Content a.txt > b.txt', 'Get-Content a.txt | Out-File b.txt',
  'Get-Content a.txt | Set-Content b.txt', 'Get-Content a.txt | Tee-Object b.txt', "Invoke-Expression 'x'", 'iex (Get-Content cmd.txt -Raw)',
  '& { Remove-Item x }', '. ./script.ps1', "$c = 'Remove-Item'; & $c x", "[scriptblock]::Create('x').Invoke()",
  "$ExecutionContext.InvokeCommand.InvokeScript('x')", "[System.IO.File]::WriteAllText('x', 'y')", "[System.IO.File]::Delete('x')",
  "[Diagnostics.Process]::Start('calc')", 'Start-Process calc', "${C:\\work\\proj\\x.txt} = 'y'", "$env:PATH = 'x'", '$global:x = 1',
  'function Get-Content { Remove-Item x }; Get-Content a', 'Get-Content ../other/secret.txt', 'Get-Content C:\\Users\\me\\.ssh\\id_rsa',
  'Get-Content \\\\server\\share\\x', 'Get-Content ~/.ssh/id_rsa', 'New-Item -ItemType File x.txt', 'Copy-Item a b',
  "$x = New-Object System.Net.WebClient; $x.DownloadString('http://example.invalid')", 'Get-Content (', "[System.Reflection.Assembly]::Load('x')",
  "Add-Type -TypeDefinition 'class X {}'", 'class X { }', "$a = Get-ChildItem x; $a.MoveTo('y')",
  "Get-ChildItem | Select-Object @{n='x'; e={ Remove-Item y }}", '$s = { Remove-Item x }; $s.Invoke()',
];
for (const s of allowed) test(`read-only script: ${s.slice(0, 70)}`, opts, async () => { const r = await classifyPowerShell(s, { root }); assert.ok(r.ok, r.reason); });
for (const s of asks) test(`asks: ${s.slice(0, 70)}`, opts, async () => assert.strictEqual((await classifyPowerShell(s, { root })).ok, false));

test('script extraction: only cleanly quoted -Command arguments', () => {
  const ok = (cmd, platform, shell) => extractScript(cmd, { platform, shell }) !== null;
  assert.ok(ok(`powershell -NoProfile -Command "${bracketScript}"`, 'win32', 'cmd.exe'));
  assert.ok(!ok('powershell -NoProfile -Command "Get-Content a \\" & del x \\""', 'win32', 'cmd.exe'), 'cmd.exe \\" escape');
  assert.ok(!ok('powershell -Command Get-Content a & del x', 'win32', 'cmd.exe'), 'unquoted');
  assert.ok(ok("pwsh -c 'Get-Content a | Measure-Object'", 'linux', '/bin/sh'));
  assert.ok(!ok('pwsh -c "Get-Content $(rm -rf x)"', 'linux', '/bin/sh'), 'bash expansion');
  assert.ok(ok('Get-Content a | Measure-Object', 'win32', 'pwsh.exe'), 'shell is PowerShell');
  assert.ok(!ok('powershell -EncodedCommand ZQBjAGgAbwA=', 'win32', 'cmd.exe'));
});

test('aliases that are native programs off Windows (sort, cat, ls, diff, compare) only pass on Windows', () => {
  const r = { errors: [], banned: [], fileRedirects: 0, members: [], types: [], assigns: [], vars: [], paths: [],
    commands: [{ name: 'Get-ChildItem', op: 'Unknown', nonBlockArgs: 0, params: [] }, { name: 'sort', op: 'Unknown', nonBlockArgs: 1, params: [] }] };
  assert.ok(evaluate(r, { root, cwd: root, platform: 'win32' }).ok);
  assert.strictEqual(evaluate(r, { root, cwd: root, platform: 'linux' }).ok, false);
  assert.strictEqual(evaluate(r, { root, cwd: root, platform: 'darwin' }).ok, false);
});
