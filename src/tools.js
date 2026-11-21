const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'target', '.idea']);

// ---------- helpers ----------
function resolvePath(root, p) {
  if (!p) return root;
  if (p.startsWith('~')) p = path.join(require('os').homedir(), p.slice(1));
  return path.isAbsolute(p) ? path.normalize(p) : path.join(root, p);
}
function rel(root, p) {
  const r = path.relative(root, p);
  return r && !r.startsWith('..') ? r.split(path.sep).join('/') : p;
}
function truncate(s, max) {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6), tail = max - head;
  return `${s.slice(0, head)}\n\n... [${s.length - max} characters truncated] ...\n\n${s.slice(-tail)}`;
}
function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
function globToRegex(glob) {
  let re = '', i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) { re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = end; }
      else re += '\\{';
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    i++;
  }
  return new RegExp('^' + re + '$');
}
async function walk(dir, out, limit, signal) {
  if (out.length >= limit || (signal && signal.aborted)) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= limit) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full, out, limit, signal); }
    else if (e.isFile()) out.push(full);
  }
}

let rgPath;
function findRipgrep() {
  if (rgPath !== undefined) return rgPath;
  rgPath = null;
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const cands = [];
  try {
    const appRoot = require('vscode').env.appRoot;
    cands.push(path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe));
    cands.push(path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe));
  } catch { /* not in vscode */ }
  for (const c of cands) if (fs.existsSync(c)) return (rgPath = c);
  try { execFileSync(exe, ['--version'], { stdio: 'ignore' }); rgPath = exe; } catch { /* none */ }
  return rgPath;
}
function runProcess(cmd, args, opts, signal) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const onAbort = () => child.kill();
    signal && signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    child.on('close', (code) => { signal && signal.removeEventListener('abort', onAbort); resolve({ code, out, err }); });
  });
}
function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

// ---------- tools ----------
// category: read (never asks), edit (file changes), exec (commands / network), meta
const TOOLS = [
  {
    name: 'read_file', category: 'read',
    description: 'Read a text file. Returns lines prefixed with line numbers ("  12\\t..."). Use offset/limit for large files. Line-number prefixes are NOT part of the file content.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'File path (relative to workspace root or absolute)' },
      offset: { type: 'integer', description: '1-based line to start from' },
      limit: { type: 'integer', description: 'Max lines to return (default 2000)' },
    }, required: ['path'] },
    async run(a, ctx) {
      const p = resolvePath(ctx.root, a.path);
      const buf = await fsp.readFile(p);
      if (isBinary(buf)) return `${a.path} is a binary file (${buf.length} bytes).`;
      const lines = buf.toString('utf8').split(/\r?\n/);
      const start = Math.max(1, a.offset || 1);
      const limit = a.limit || 2000;
      const slice = lines.slice(start - 1, start - 1 + limit);
      ctx.readFiles.add(p);
      let s = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
      if (start - 1 + limit < lines.length) s += `\n... (${lines.length} lines total; use offset=${start + limit} to continue)`;
      return s || '(empty file)';
    },
  },
  {
    name: 'write_file', category: 'edit',
    description: 'Create a new file or completely overwrite an existing one. Creates parent directories. Prefer edit_file for modifying existing files.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' }, content: { type: 'string', description: 'Full file content' },
      explanation: { type: 'string', description: 'One short sentence for the user: what this change does and why. Shown in the approval prompt.' },
    }, required: ['path', 'content'] },
    async prepare(a, ctx) {
      const p = resolvePath(ctx.root, a.path);
      const exists = fs.existsSync(p);
      const oldContent = exists ? await fsp.readFile(p, 'utf8') : null;
      return { path: p, oldContent, newContent: a.content, summary: `${exists ? 'Overwrite' : 'Create'} ${rel(ctx.root, p)}` };
    },
    async run(a, ctx, prep) {
      await fsp.mkdir(path.dirname(prep.path), { recursive: true });
      await fsp.writeFile(prep.path, prep.newContent, 'utf8');
      ctx.readFiles.add(prep.path);
      return `Wrote ${prep.newContent.split('\n').length} lines to ${rel(ctx.root, prep.path)}`;
    },
  },
  {
    name: 'edit_file', category: 'edit',
    description: 'Replace exact text in a file. old_string must match exactly (whitespace included) and be unique unless replace_all is true. Read the file first. Include enough surrounding context in old_string to make it unique.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace (no line-number prefixes)' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence' },
      explanation: { type: 'string', description: 'One short sentence for the user: what this change does and why. Shown in the approval prompt.' },
    }, required: ['path', 'old_string', 'new_string'] },
    async prepare(a, ctx) {
      const p = resolvePath(ctx.root, a.path);
      if (!fs.existsSync(p)) throw new Error(`File not found: ${a.path}. Use write_file to create it.`);
      let text = await fsp.readFile(p, 'utf8');
      const oldContent = text;
      const crlf = text.includes('\r\n');
      if (crlf) text = text.replace(/\r\n/g, '\n');
      const oldS = a.old_string.replace(/\r\n/g, '\n'), newS = a.new_string.replace(/\r\n/g, '\n');
      if (oldS === newS) throw new Error('old_string and new_string are identical.');
      if (oldS === '') throw new Error('old_string is empty. Use write_file to create or overwrite files.');
      const count = text.split(oldS).length - 1;
      if (count === 0) throw new Error('old_string not found in file. Re-read the file and copy the text exactly (without line-number prefixes).');
      if (count > 1 && !a.replace_all) throw new Error(`old_string occurs ${count} times. Add more context to make it unique, or set replace_all.`);
      let out = a.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
      if (crlf) out = out.replace(/\n/g, '\r\n');
      return { path: p, oldContent, newContent: out, count: a.replace_all ? count : 1, summary: `Edit ${rel(ctx.root, p)}` };
    },
    async run(a, ctx, prep) {
      await fsp.writeFile(prep.path, prep.newContent, 'utf8');
      return `Edited ${rel(ctx.root, prep.path)} (${prep.count} replacement${prep.count > 1 ? 's' : ''}).`;
    },
  },
  {
    name: 'list_dir', category: 'read',
    description: 'List entries of a directory. Directories end with "/".',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory (default: workspace root)' } } },
    async run(a, ctx) {
      const p = resolvePath(ctx.root, a.path || '.');
      const entries = await fsp.readdir(p, { withFileTypes: true });
      entries.sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
      const lines = entries.slice(0, 1000).map((e) => e.name + (e.isDirectory() ? '/' : ''));
      if (entries.length > 1000) lines.push(`... ${entries.length - 1000} more`);
      return lines.join('\n') || '(empty directory)';
    },
  },
  {
    name: 'glob', category: 'read',
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py". Respects .gitignore when ripgrep is available. Returns paths relative to the workspace root.',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string' }, path: { type: 'string', description: 'Directory to search in (default: workspace root)' },
    }, required: ['pattern'] },
    async run(a, ctx) {
      const base = resolvePath(ctx.root, a.path || '.');
      const limit = 500;
      let files;
      const rg = findRipgrep();
      if (rg) {
        const r = await runProcess(rg, ['--files', '--hidden', '-g', '!.git', '-g', a.pattern], { cwd: base }, ctx.signal);
        files = r.out.split(/\r?\n/).filter(Boolean).map((f) => path.join(base, f));
      } else {
        const all = []; await walk(base, all, 50000, ctx.signal);
        const re = globToRegex(a.pattern), basenameOnly = !a.pattern.includes('/');
        files = all.filter((f) => re.test(basenameOnly ? path.basename(f) : path.relative(base, f).split(path.sep).join('/')));
      }
      files.sort();
      const out = files.slice(0, limit).map((f) => rel(ctx.root, f));
      if (files.length > limit) out.push(`... ${files.length - limit} more (narrow the pattern)`);
      return out.join('\n') || 'No files found.';
    },
  },
  {
    name: 'grep', category: 'read',
    description: 'Search file contents with a regular expression (ripgrep syntax). Returns "path:line:text". Use glob to filter files (e.g. "*.py").',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'File or directory (default: workspace root)' },
      glob: { type: 'string', description: 'File filter, e.g. "*.{ts,tsx}"' },
      ignore_case: { type: 'boolean' },
      context: { type: 'integer', description: 'Lines of context around matches' },
      files_only: { type: 'boolean', description: 'Only list matching files' },
    }, required: ['pattern'] },
    async run(a, ctx) {
      const base = resolvePath(ctx.root, a.path || '.');
      const max = 300;
      const rg = findRipgrep();
      let lines;
      if (rg) {
        const args = ['--line-number', '--no-heading', '--color', 'never', '--hidden', '-g', '!.git', '--max-columns', '400'];
        if (a.ignore_case) args.push('-i');
        if (a.glob) args.push('-g', a.glob);
        if (a.context) args.push('-C', String(a.context));
        if (a.files_only) args.push('-l');
        args.push('-e', a.pattern, path.relative(ctx.root, base) || '.');
        const r = await runProcess(rg, args, { cwd: ctx.root }, ctx.signal);
        if (r.code === 2 && !r.out) throw new Error(r.err.trim());
        lines = r.out.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^\.[\\/]/, ''));
      } else {
        const re = new RegExp(a.pattern, a.ignore_case ? 'i' : '');
        const files = [];
        if (fs.statSync(base).isFile()) files.push(base); else await walk(base, files, 20000, ctx.signal);
        const fre = a.glob ? globToRegex(a.glob) : null;
        lines = [];
        for (const f of files) {
          if (lines.length > max) break;
          if (fre && !fre.test(path.basename(f))) continue;
          let buf; try { buf = await fsp.readFile(f); } catch { continue; }
          if (buf.length > 2e6 || isBinary(buf)) continue;
          const ls = buf.toString('utf8').split(/\r?\n/);
          for (let i = 0; i < ls.length; i++) {
            if (re.test(ls[i])) {
              if (a.files_only) { lines.push(rel(ctx.root, f)); break; }
              lines.push(`${rel(ctx.root, f)}:${i + 1}:${ls[i].slice(0, 400)}`);
            }
          }
        }
      }
      const out = lines.slice(0, max);
      if (lines.length > max) out.push(`... more results truncated (narrow the search)`);
      return out.join('\n') || 'No matches.';
    },
  },
  {
    name: 'run_command', category: 'exec',
    description: 'Run one shell command in the workspace (non-interactive, no stdin). Returns combined stdout/stderr and the exit code. Use for builds, tests, project scripts, git, package managers and syntax checks (e.g. node --check file.js). Do not use it to read, search or edit files: use read_file, grep, glob, list_dir, edit_file and write_file. Keep it to a single simple command, not a multi-line script.',
    parameters: { type: 'object', properties: {
      command: { type: 'string' },
      cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
      timeout_ms: { type: 'integer', description: 'Timeout in ms (default from settings)' },
      explanation: { type: 'string', description: 'One short sentence for the user: what this command does and why. Shown in the approval prompt.' },
    }, required: ['command'] },
    async prepare(a, ctx) { return { summary: a.command, command: a.command }; },
    async run(a, ctx) {
      const cwd = resolvePath(ctx.root, a.cwd || '.');
      const timeout = a.timeout_ms || ctx.cfg.commandTimeoutMs || 120000;
      ctx.log && ctx.log(`\n$ ${a.command}   (cwd: ${cwd})\n`);
      return await new Promise((resolve) => {
        const child = spawn(a.command, {
          cwd, shell: ctx.cfg.shell || true, detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', CI: process.env.CI || '1', FORCE_COLOR: '0', NO_COLOR: '1' },
        });
        let out = '', timedOut = false, done = false;
        const onData = (d) => { const s = d.toString(); out += s; ctx.log && ctx.log(s); if (out.length > 5e6) out = out.slice(-2e6); };
        child.stdout.on('data', onData); child.stderr.on('data', onData);
        const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
        const onAbort = () => killTree(child);
        ctx.signal && ctx.signal.addEventListener('abort', onAbort, { once: true });
        const finish = (code, extra) => {
          if (done) return; done = true;
          clearTimeout(timer); ctx.signal && ctx.signal.removeEventListener('abort', onAbort);
          const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
          let status = timedOut ? `Timed out after ${timeout}ms (process killed)` : ctx.signal && ctx.signal.aborted ? 'Interrupted by user' : `Exit code: ${code}`;
          if (extra) status += ` (${extra})`;
          resolve(`${status}\n${clean.trim() ? clean : '(no output)'}`);
        };
        child.on('error', (e) => finish(-1, String(e)));
        child.on('close', (code) => finish(code));
      });
    },
  },
  {
    name: 'web_fetch', category: 'exec',
    description: 'Fetch a URL (HTTP GET) and return its text content (HTML is converted to plain text).',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async prepare(a) { return { summary: `GET ${a.url}` }; },
    async run(a, ctx) {
      const res = await fetch(a.url, { signal: ctx.signal, headers: { 'User-Agent': 'oai-agent', Accept: 'text/html,text/plain,application/json,*/*' } });
      let t = await res.text();
      if ((res.headers.get('content-type') || '').includes('html')) {
        t = t.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
          .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n');
      }
      return `HTTP ${res.status}\n${t.trim()}`;
    },
  },
  {
    name: 'todo_write', category: 'meta',
    description: 'Create or update the task list for the current work. Send the FULL list every time. Use for any task with 3+ steps.',
    parameters: { type: 'object', properties: {
      todos: { type: 'array', items: { type: 'object', properties: {
        content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
      }, required: ['content', 'status'] } },
    }, required: ['todos'] },
    async run(a, ctx) {
      ctx.post({ type: 'todos', todos: a.todos });
      return 'Todo list updated.';
    },
  },
];

function toolDefs() {
  return TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}
function getTool(name) { return TOOLS.find((t) => t.name === name); }

module.exports = { toolDefs, getTool, truncate, resolvePath, rel };
