// Which shell run_command uses, and how to start it.
// Windows: PowerShell by default (PowerShell 7 if installed, else the built-in Windows PowerShell 5.1).
// Elsewhere: the system shell. The oaiAgent.shell setting overrides both.
const { findPowerShell } = require('./psreadonly');

/**
 * @returns {{kind: 'powershell'|'cmd'|'posix', exe: string|null, name: string}}
 *   exe is null for "the system default shell".
 */
function resolveShell(cfg = {}, platform = process.platform, findPs = findPowerShell) {
  const custom = (cfg.shell || '').trim();
  if (custom) {
    if (/(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(custom)) return { kind: 'powershell', exe: custom, name: 'PowerShell' };
    if (/(^|[\\/])cmd(\.exe)?$/i.test(custom)) return { kind: 'cmd', exe: custom, name: 'cmd.exe' };
    return { kind: 'posix', exe: custom, name: custom };
  }
  if (platform === 'win32') {
    const ps = findPs();
    if (ps) return { kind: 'powershell', exe: ps, name: /pwsh/i.test(ps) ? 'PowerShell 7' : 'Windows PowerShell 5.1' };
    return { kind: 'cmd', exe: null, name: 'cmd.exe' };
  }
  return { kind: 'posix', exe: null, name: process.env.SHELL || '/bin/sh' };
}

/**
 * Arguments that run `command` in PowerShell. The script is passed base64-encoded, so no quoting
 * or escaping by an outer shell can change it. The wrapper turns off progress output, makes output
 * UTF-8, and makes the process exit code reflect the command (a program's exit code, or 1 after a
 * failed cmdlet).
 */
function powerShellArgs(command) {
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
    command,
    '$__ok = $?',
    'if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $__ok) { exit 1 }',
  ].join('\n');
  return ['-NoProfile', '-NonInteractive', '-NoLogo', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

module.exports = { resolveShell, powerShellArgs };
