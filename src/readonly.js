// Decides whether a shell command is read-only and safe to run without asking.
// Conservative: anything it does not fully understand is "not read-only" (so the user is asked).
const path = require('path');
const os = require('os');

// Characters that chain commands, substitute, redirect, run code or expand variables
// (cmd, PowerShell and POSIX shells). Any of these -> ask.
const META = /[;&|`$<>(){}@%^\r\n!]/;

// Commands that only read. Flags are allowed unless listed in BAD_FLAGS.
const READ_COMMANDS = new Set([
  // PowerShell cmdlets and aliases
  'get-content', 'gc', 'get-childitem', 'gci', 'select-string', 'sls', 'test-path', 'get-item', 'gi',
  'get-location', 'gl', 'resolve-path', 'rvpa', 'get-filehash', 'get-command', 'gcm',
  // cmd.exe
  'type', 'dir', 'findstr', 'where', 'tree',
  // POSIX / Git Bash
  'cat', 'head', 'tail', 'wc', 'ls', 'pwd', 'grep', 'egrep', 'fgrep', 'rg', 'file', 'stat', 'which', 'echo', 'diff', 'du',
]);
// Flags that make an otherwise read-only command write, delete or run things.
const BAD_FLAGS = {
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'],
  rg: ['--pre'],
};

// git subcommands that only read, with flags that would change that.
const GIT_READ = {
  status: [], diff: ['--output', '--ext-diff'], log: ['--output', '--ext-diff'], show: ['--output', '--ext-diff'],
  blame: [], 'rev-parse': [], 'ls-files': [], describe: [], shortlog: [], grep: ['-O', '--open-files-in-pager'],
  branch: 'list', tag: 'list', remote: 'list', stash: 'stash-list', config: 'config-get',
};
const GIT_LIST_FLAGS = new Set(['-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '-vv', '--verbose', '--show-current', '--merged', '--no-merged', '--contains', '--sort', '-n']);

// `<tool> --version` style checks.
const VERSION_TOOLS = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'python3', 'py', 'pip', 'pip3', 'git', 'dotnet', 'java', 'javac', 'tsc', 'go', 'cargo', 'rustc', 'deno', 'bun', 'code', 'pwsh', 'powershell']);
const VERSION_FLAGS = new Set(['--version', '-v', '-V', 'version', '-version', '/?']);

/** Split a command line into words, honoring '...' and "..." quotes. Returns null on unbalanced quotes. */
function tokenize(s) {
  const out = [];
  let cur = '', q = null, has = false;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += ch;
  }
  if (q) return null;
  if (cur || has) out.push(cur);
  return out;
}

/** Unwrap `powershell -NoProfile -Command "..."`, `pwsh -c ...` and `cmd /c ...` (one level). */
function unwrap(cmd) {
  const ps = cmd.match(/^\s*(?:powershell|pwsh)(?:\.exe)?((?:\s+-(?:NoProfile|NonInteractive|NoLogo|ExecutionPolicy\s+\w+|InputFormat\s+\w+|OutputFormat\s+\w+))*)\s+-(?:c|command)\s+([\s\S]+)$/i);
  if (ps) return { shell: 'powershell', inner: stripQuotes(ps[2].trim()) };
  const c = cmd.match(/^\s*cmd(?:\.exe)?\s+\/[cC]\s+([\s\S]+)$/);
  if (c) return { shell: 'cmd', inner: stripQuotes(c[1].trim()) };
  return { shell: null, inner: cmd.trim() };
}
function stripQuotes(s) {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0] && s.indexOf(s[0], 1) === s.length - 1) return s.slice(1, -1);
  return s;
}

/** True if p (relative to cwd) stays inside root. */
function inside(root, cwd, p) {
  if (/^~/.test(p)) p = path.join(os.homedir(), p.slice(1));
  // Drive-letter and UNC paths are absolute Windows paths, whatever platform this runs on.
  if (/^[a-zA-Z]:[\\/]|^\\\\|^\/\//.test(p) && process.platform !== 'win32') return false;
  const abs = path.resolve(cwd, p);
  const r = path.relative(root, abs);
  return !(r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r));
}
const isFlag = (t, cmdStyle) => t.startsWith('-') || (cmdStyle && /^\/[a-z?]{1,3}(?::\S*)?$/i.test(t));

/**
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function classify(command, { root, cwd = root } = {}) {
  const { shell, inner } = unwrap(String(command || ''));
  if (!inner) return { ok: false, reason: 'empty' };
  if (META.test(inner)) return { ok: false, reason: 'contains shell operators or code' };
  const t = tokenize(inner);
  if (!t || !t.length) return { ok: false, reason: 'could not parse' };
  if (!inside(root, root, cwd)) return { ok: false, reason: 'runs outside the workspace' };

  const name = t[0].toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const args = t.slice(1);
  const cmdStyle = shell === 'cmd' || ['dir', 'type', 'findstr', 'where', 'tree'].includes(name);
  const checkPaths = (list) => {
    for (const a of list) {
      if (isFlag(a, cmdStyle)) continue;
      // PowerShell -Param:value / --flag=value carry a value after the separator.
      if (!inside(root, cwd, a)) return { ok: false, reason: `reads outside the workspace (${a})` };
    }
    return { ok: true };
  };

  // Version checks: exactly `<tool> <version-flag>`.
  if (VERSION_TOOLS.has(name) && args.length === 1 && VERSION_FLAGS.has(args[0])) return { ok: true };

  // Syntax checks that only parse.
  if (name === 'node' && args.length >= 2 && (args[0] === '--check' || args[0] === '-c')) return checkPaths(args.slice(1));
  if (name === 'tsc' && args.includes('--noEmit') && args.every((a) => ['--noEmit', '-p', '--project', '--pretty', '--skipLibCheck'].includes(a) || !a.startsWith('-'))) return checkPaths(args.filter((a) => a !== '--noEmit'));

  if (name === 'git') {
    if (!args.length) return { ok: false, reason: 'git without a subcommand' };
    let i = 0;
    while (args[i] === '--no-pager') i++;
    const sub = (args[i] || '').toLowerCase();
    const rest = args.slice(i + 1);
    const rule = GIT_READ[sub];
    if (rule === undefined) return { ok: false, reason: `git ${sub} is not read-only` };
    if (Array.isArray(rule)) {
      if (rest.some((a) => rule.some((f) => a === f || a.startsWith(f + '=')))) return { ok: false, reason: `git ${sub} with a flag that writes or runs programs` };
      return checkPaths(rest.filter((a) => a !== '--'));
    }
    if (rule === 'list') {
      // branch/tag/remote: listing only (no names to create, delete or rename).
      if (rest.every((a) => GIT_LIST_FLAGS.has(a.split('=')[0]))) return { ok: true };
      return { ok: false, reason: `git ${sub} that may modify refs` };
    }
    if (rule === 'stash-list') return rest[0] === 'list' ? { ok: true } : { ok: false, reason: 'git stash that modifies the stash' };
    if (rule === 'config-get') return rest.length && rest.every((a) => ['--get', '--get-all', '--list', '-l', '--show-origin', '--local', '--global'].includes(a) || !a.startsWith('-')) && rest.some((a) => /^(--get|--get-all|--list|-l)$/.test(a)) ? { ok: true } : { ok: false, reason: 'git config that may write' };
  }

  if (name === 'find') {
    if (args.some((a) => BAD_FLAGS.find.includes(a))) return { ok: false, reason: 'find with an action that writes or runs programs' };
    // find's first non-flag args are paths; predicates' values are patterns.
    const paths = [];
    for (const a of args) { if (a.startsWith('-')) break; paths.push(a); }
    return checkPaths(paths);
  }

  if (READ_COMMANDS.has(name)) {
    if ((BAD_FLAGS[name] || []).some((f) => args.some((a) => a === f || a.startsWith(f + '=')))) return { ok: false, reason: `${name} with a flag that runs programs` };
    // grep/rg/findstr/select-string: the first positional is a pattern, not a path.
    let list = args;
    if (['grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls'].includes(name)) {
      const firstPos = args.findIndex((a) => !isFlag(a, cmdStyle));
      const named = args.findIndex((a) => /^-pattern$/i.test(a));
      if (named >= 0) list = args.filter((_, k) => k !== named + 1);
      else if (firstPos >= 0) list = args.filter((_, k) => k !== firstPos);
    }
    if (name === 'echo') return { ok: true };
    return checkPaths(list);
  }

  return { ok: false, reason: `${t[0]} is not on the read-only list` };
}

module.exports = { classify, tokenize, unwrap };
