// Launches a real VS Code with this extension and runs test/vscode/suite.js inside it.
// Usage: node test/vscode/run.js   (CI runs it under xvfb on Linux)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'stark-vscode-ws-'));
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'one\ntwo\nthree\n');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stark-vscode-user-'));
  // A setting saved by a version before 0.14.0, to check it is moved to the new prefix.
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'oaiAgent.commandTimeoutMs': 54321 }));
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite.js'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`],
    });
  } catch (e) {
    console.error('VS Code tests failed:', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
