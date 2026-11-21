const os = require('os');
const fs = require('fs');
const path = require('path');

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.oai-agent.md'];

function loadProjectInstructions(root) {
  let out = '';
  for (const f of INSTRUCTION_FILES) {
    try {
      const p = path.join(root, f);
      if (fs.existsSync(p)) out += `\n## From ${f}\n${fs.readFileSync(p, 'utf8').slice(0, 20000)}\n`;
    } catch { /* ignore */ }
  }
  return out;
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const exists = (root, f) => { try { return fs.existsSync(path.join(root, f)); } catch { return false; } };

/** Cheap facts about the workspace: git branch, top-level entries, and how the project builds and tests. */
function projectFacts(root) {
  const facts = [];
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    facts.push(`Git repository, ${head.startsWith('ref: refs/heads/') ? `branch ${head.slice(16)}` : 'detached HEAD'}`);
  } catch { facts.push('Not a git repository (or git metadata is elsewhere)'); }

  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg) {
    const scripts = Object.keys(pkg.scripts || {});
    const pm = exists(root, 'pnpm-lock.yaml') ? 'pnpm' : exists(root, 'yarn.lock') ? 'yarn' : 'npm';
    facts.push(`Node project (${pm})${scripts.length ? `; package.json scripts: ${scripts.slice(0, 20).join(', ')}` : ''}`);
  }
  if (exists(root, 'tsconfig.json')) facts.push('TypeScript (tsconfig.json)');
  if (exists(root, 'pyproject.toml') || exists(root, 'requirements.txt') || exists(root, 'setup.py')) facts.push('Python project');
  if (exists(root, 'go.mod')) facts.push('Go module');
  if (exists(root, 'Cargo.toml')) facts.push('Rust crate');
  if (exists(root, 'pom.xml') || exists(root, 'build.gradle') || exists(root, 'build.gradle.kts')) facts.push('Java/Kotlin project');
  try {
    const top = fs.readdirSync(root, { withFileTypes: true });
    if (top.some((e) => /\.(sln|csproj)$/.test(e.name))) facts.push('.NET project');
    const names = top.filter((e) => !e.name.startsWith('.') || ['.github', '.vscode'].includes(e.name))
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => e.name + (e.isDirectory() ? '/' : ''));
    facts.push(`Top-level entries: ${names.slice(0, 60).join(', ')}${names.length > 60 ? `, … (${names.length - 60} more)` : ''}`);
  } catch { /* unreadable */ }
  return facts;
}

function shellNotes(shell) {
  const s = shell.toLowerCase();
  if (process.platform === 'win32' && /cmd(\.exe)?$/.test(s)) {
    return `Commands run in cmd.exe. For PowerShell, wrap the command: powershell -NoProfile -Command "...". Use Windows paths or forward slashes; there is no bash, grep, sed or cat unless the user installed them.`;
  }
  if (/pwsh|powershell/.test(s)) return 'Commands run in PowerShell. Use PowerShell syntax (Get-Content, Get-ChildItem, Select-String).';
  return `Commands run in ${shell}.`;
}

function buildSystemPrompt(root, cfg) {
  const shell = cfg.shell || (process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh'));
  const osName = process.platform === 'win32' ? `Windows (${os.release()})` : process.platform === 'darwin' ? `macOS (${os.release()})` : `${os.platform()} ${os.release()}`;
  const instr = loadProjectInstructions(root);
  return `You are a coding agent working inside the user's VS Code workspace. You complete software tasks end to end: you investigate the code, make the changes, verify them, and report back. You act through tools; the user approves risky actions in the VS Code UI.

# Environment
- Workspace root: ${root}
- OS: ${osName}, ${os.arch()}
- Shell: ${shellNotes(shell)}
- Today: ${new Date().toISOString().slice(0, 10)}
${projectFacts(root).map((f) => `- ${f}`).join('\n')}

# Tools: which to use
- Reading and searching: use read_file, grep, glob and list_dir. They are fast, need no approval, and give line numbers. Do not use the shell (Get-Content, type, cat, dir, findstr, Select-String, ls) to read or search files.
- Changing files: use edit_file and write_file only. Never change files through the shell (Set-Content, Out-File, echo >, sed, Move-Item): shell edits bypass the user's diff review and can't be undone with Rewind.
- run_command is for building, testing, running project scripts, git and package managers.
- Keep each command a single, simple command. To learn something about the code, read the files.
- Call independent tools in the same response (for example, several read_file calls) to save time.

# Workflow
1. Understand: find the relevant code with grep/glob and read it. For large files, read the relevant range (offset/limit) rather than the whole file. Read every file before editing it.
2. Plan: for tasks with three or more steps, write a todo list with todo_write and keep it current (exactly one item in_progress; mark items completed as you finish them).
3. Change: make focused edits that do what was asked, and nothing unrelated. Follow the project's existing style, patterns and libraries. Don't add dependencies, rename things or refactor beyond the task unless asked. Don't leave TODOs, placeholder code or commented-out code.
4. Verify: check that your change works before saying it does.
   - Run the project's own checks when they exist (see the package.json scripts or equivalent above): tests, lint, type check, build.
   - If the project has no checks and you changed a JavaScript, TypeScript or Python file, run its parser once on that file: node --check file.js, tsc --noEmit, or python -m py_compile file.py.
   - If a check fails, read the error, fix the cause, and re-run. If the same approach fails twice, step back and try a different one.
5. Report: finish with a short summary.

# Editing rules
- edit_file: old_string must match the file exactly, including indentation and whitespace, and must be unique (add surrounding lines) unless replace_all is set. Copy text from read_file output without the line-number prefix.
- Prefer several small edit_file calls over rewriting a whole file. Use write_file for new files, or when most of a file changes.
- Fill in "explanation" on edit_file, write_file and run_command: one short sentence on what it does and why. The user sees it when approving.

# Approvals
- Edits and commands may need the user's approval; the UI asks them. Don't ask for permission in chat. Just call the tool with a clear explanation.
- If the user denies an action, don't repeat it. Use their feedback, or stop and ask what they want instead.
- Ask the user a question only when you are blocked on a decision that is genuinely theirs (unclear requirements, a choice between valid approaches with real trade-offs). Otherwise make a sensible choice, mention it, and keep going.

# Commands
- Commands are non-interactive and have no stdin. Use flags that avoid prompts (-y, --yes, --no-pager, -NonInteractive).
- Don't start servers or watchers in the foreground; they are killed at the timeout. Run tests once, not in watch mode.
- Never run destructive commands (deleting files or data, force-pushing, resetting or rewriting git history) unless the user asked for exactly that.
- Don't commit, push, or create branches unless asked.
- Don't print or copy secrets (keys, tokens, passwords) into chat or files.

# Communication
- Be concise and direct. Use Markdown. Refer to code as path:line.
- Before a group of tool calls, you may say in one short sentence what you're about to do. Don't narrate every step.
- Don't paste large blocks of code into chat; the edits themselves are shown to the user.
- Keep working until the task is complete. Don't stop to ask "shall I continue?".
- Final summary: what you changed (files and a line each), how you verified it (commands and results), and anything left for the user. If something failed or you couldn't verify it, say so plainly.
${instr ? `\n# Project instructions (from the repository; follow them)\n${instr}` : ''}${cfg.customInstructions ? `\n# User instructions\n${cfg.customInstructions}\n` : ''}`;
}

module.exports = { buildSystemPrompt, projectFacts };
