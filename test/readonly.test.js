const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { classify } = require('../src/readonly');

const root = path.resolve('/work/proj');
const allowed = [
  'powershell -NoProfile -Command "Get-Content src/app.ts"', 'powershell -Command Get-Content -Raw cdap-website/js/main.js',
  'pwsh -c "Get-ChildItem -Recurse -Filter *.js src"', 'Select-String -Pattern "TODO" -Path src/*.js', 'cmd /c type README.md',
  'dir /s /b src', 'findstr /s /i "password" *.config', 'git status', 'git --no-pager diff --stat', 'git log -n 5 --oneline',
  'git branch -a', 'git branch --show-current', 'git stash list', 'git config --get user.name', 'node --check cdap-website/js/main.js',
  'tsc --noEmit -p tsconfig.json', 'node --version', 'python -V', 'grep -rn fetch src', 'rg -n useState src', 'find src -name "*.ts"',
  'cat package.json', 'ls -la', 'cat ..foo/x',
];
const asks = [
  'grep -rn "fetch(" src', 'powershell -NoProfile -Command "@(\'a.js\') | ForEach-Object { $t = Get-Content -Raw $_ }"',
  'Get-Content a.txt; Remove-Item b.txt', 'Get-Content ../other/secret.txt', 'type C:\\Users\\me\\.ssh\\id_rsa', 'cat /etc/passwd',
  'cat ~/.ssh/id_rsa', 'type \\\\server\\share\\x.txt', 'Get-Content D:/other/x.txt', 'git branch -D main', 'git branch newbranch', 'git push',
  'git diff --output=x.patch', 'git config user.name evil', 'git stash', 'git checkout .', 'git tag v1', 'find . -delete',
  'find . -exec rm {} ;', 'rg --pre sh x', 'Remove-Item x', 'del x', 'npm install', 'npm test', 'node script.js',
  'node -e "require(\'fs\').rmSync(\'x\')"', 'echo hi > file.txt', 'Get-Content x.txt | Out-File y.txt', 'Get-Content "unterminated',
  'powershell -File evil.ps1', 'powershell -EncodedCommand ZQBjAGgAbwA=', 'cmd /c "type a.txt & del a.txt"', 'echo %USERPROFILE%',
  'git log --format=%H', 'git status\npython evil.py',
];
for (const c of allowed) test(`read-only: ${c}`, () => assert.ok(classify(c, { root }).ok, classify(c, { root }).reason));
for (const c of asks) test(`asks: ${c.replace(/\n/g, '\\n')}`, () => assert.strictEqual(classify(c, { root }).ok, false));
test('working directory outside the workspace asks', () => {
  assert.strictEqual(classify('git status', { root, cwd: path.resolve('/tmp') }).ok, false);
});
