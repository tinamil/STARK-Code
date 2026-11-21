// Read-only check for PowerShell scripts, using PowerShell's own parser.
// PowerShell parses the script (never runs it) and reports what it contains; this module then
// approves it only if every command, .NET call, method, type, assignment and path is known to be
// read-only and inside the workspace. Anything unrecognized means "ask the user".
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

// Runs inside PowerShell 5.1+ / 7+. Reads the script from $env:OAI_PS_SRC (base64 UTF-8), parses it,
// and prints a JSON summary of the syntax tree. It does not execute the script.
const ANALYZER = String.raw`
$ErrorActionPreference = 'Stop'
$src = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OAI_PS_SRC))
$tokens = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errs)
$commands = New-Object System.Collections.ArrayList
$members = New-Object System.Collections.ArrayList
$types = New-Object System.Collections.ArrayList
$assigns = New-Object System.Collections.ArrayList
$vars = New-Object System.Collections.ArrayList
$paths = New-Object System.Collections.ArrayList
$banned = New-Object System.Collections.ArrayList
$fileRedirects = 0
$patternParams = @('pattern','filter','include','exclude','encoding','delimiter','property','expandproperty','value','format','separator','name','begin','process','end')
$patternOps = @('Imatch','Inotmatch','Cmatch','Cnotmatch','Ireplace','Creplace','Isplit','Csplit','Ilike','Inotlike','Clike','Cnotlike','Ieq','Ine','Ceq','Cne','Icontains','Inotcontains','Iin','Inotin','Plus','Format')
$stringMethods = @('replace','split','contains','startswith','endswith','indexof','lastindexof','trim','trimstart','trimend','padleft','padright','insert','remove','equals','compareto','match','matches','ismatch','join','format')
foreach ($n in $ast.FindAll({ $true }, $true)) {
  $t = $n.GetType().Name
  switch ($t) {
    'CommandAst' {
      $name = $n.GetCommandName()
      $nonBlockArgs = 0; $params = New-Object System.Collections.ArrayList
      foreach ($e in ($n.CommandElements | Select-Object -Skip 1)) {
        if ($e -is [System.Management.Automation.Language.CommandParameterAst]) { [void]$params.Add($e.ParameterName.ToLower()) }
        elseif (-not ($e -is [System.Management.Automation.Language.ScriptBlockExpressionAst])) { $nonBlockArgs++ }
      }
      [void]$commands.Add([ordered]@{ name = $name; op = $n.InvocationOperator.ToString(); nonBlockArgs = $nonBlockArgs; params = @($params) })
    }
    'InvokeMemberExpressionAst' {
      $mname = $null
      if ($n.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $mname = $n.Member.Value }
      $tname = $null
      if ($n.Static -and $n.Expression -is [System.Management.Automation.Language.TypeExpressionAst]) { $tname = $n.Expression.TypeName.FullName }
      $blockArgs = $true
      foreach ($a in $n.Arguments) { if (-not ($a -is [System.Management.Automation.Language.ScriptBlockExpressionAst])) { $blockArgs = $false } }
      [void]$members.Add([ordered]@{ kind = 'method'; static = $n.Static; type = $tname; name = $mname; blockArgs = $blockArgs })
    }
    'MemberExpressionAst' {
      $mname = $null
      if ($n.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $mname = $n.Member.Value }
      $tname = $null
      if ($n.Static -and $n.Expression -is [System.Management.Automation.Language.TypeExpressionAst]) { $tname = $n.Expression.TypeName.FullName }
      [void]$members.Add([ordered]@{ kind = 'property'; static = $n.Static; type = $tname; name = $mname; blockArgs = $true })
    }
    'TypeExpressionAst' { [void]$types.Add($n.TypeName.FullName) }
    'TypeConstraintAst' { [void]$types.Add($n.TypeName.FullName) }
    'AssignmentStatementAst' {
      $left = $n.Left
      while ($left -is [System.Management.Automation.Language.ConvertExpressionAst] -or $left -is [System.Management.Automation.Language.AttributedExpressionAst]) { $left = $left.Child }
      $ok = $false; $drive = $null
      if ($left -is [System.Management.Automation.Language.VariableExpressionAst]) {
        $vp = $left.VariablePath
        $drive = $vp.DriveName
        $ok = (-not $vp.IsDriveQualified) -and (-not $vp.IsGlobal) -and (-not $vp.IsScript)
      }
      [void]$assigns.Add([ordered]@{ ok = $ok; target = $n.Left.Extent.Text })
    }
    'VariableExpressionAst' {
      if ($n.VariablePath.IsDriveQualified) { [void]$vars.Add($n.VariablePath.UserPath) }
    }
    'FileRedirectionAst' { $fileRedirects++ }
    'StringConstantExpressionAst' {
      $v = $n.Value; $p = $n.Parent; $skip = $false
      if ($p -is [System.Management.Automation.Language.CommandAst]) {
        $els = @($p.CommandElements); $i = [array]::IndexOf($els, $n)
        if ($i -eq 0) { $skip = $true }
        elseif ($i -gt 0 -and $els[$i - 1] -is [System.Management.Automation.Language.CommandParameterAst] -and $patternParams -contains $els[$i - 1].ParameterName.ToLower()) { $skip = $true }
        else {
          $cn = $p.GetCommandName()
          if ($cn -and @('select-string','sls','where-object','where','?','write-host','write-output','echo') -contains $cn.ToLower()) {
            $firstPos = $null
            for ($k = 1; $k -lt $els.Count; $k++) { if (-not ($els[$k] -is [System.Management.Automation.Language.CommandParameterAst]) -and -not ($els[$k - 1] -is [System.Management.Automation.Language.CommandParameterAst] -and $k -gt 1)) { $firstPos = $k; break } }
            if ($cn.ToLower() -ne 'select-string' -and $cn.ToLower() -ne 'sls') { $skip = $true }
            elseif ($firstPos -eq $i) { $skip = $true }
          }
        }
      }
      elseif ($p -is [System.Management.Automation.Language.BinaryExpressionAst] -and $patternOps -contains $p.Operator.ToString()) { $skip = $true }
      elseif ($p -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $p.Member -ne $n) {
        $tn = ''
        if ($p.Static -and $p.Expression -is [System.Management.Automation.Language.TypeExpressionAst]) { $tn = $p.Expression.TypeName.FullName.ToLower() }
        $mn = ''
        if ($p.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $mn = $p.Member.Value.ToLower() }
        if ($tn -match 'regex$' -or ((-not $p.Static) -and $stringMethods -contains $mn) -or ($tn -match '(^|\.)string$')) { $skip = $true }
      }
      elseif ($p -is [System.Management.Automation.Language.MemberExpressionAst]) { $skip = $true }
      if (-not $skip -and ($v -match '[\\/]' -or $v -match '^[A-Za-z]:' -or $v.StartsWith('~') -or $v.StartsWith('..'))) { [void]$paths.Add($v) }
    }
    default {
      if (@('FunctionDefinitionAst','TypeDefinitionAst','UsingStatementAst','DataStatementAst','TrapStatementAst','ConfigurationDefinitionAst','DynamicKeywordStatementAst','AttributeAst','FunctionMemberAst','PropertyMemberAst','UsingExpressionAst','BlockStatementAst') -contains $t) { [void]$banned.Add($t) }
    }
  }
}
$out = [ordered]@{
  errors = @($errs | ForEach-Object { $_.Message })
  commands = @($commands); members = @($members); types = @($types); assigns = @($assigns)
  vars = @($vars); paths = @($paths); banned = @($banned); fileRedirects = $fileRedirects
}
$out | ConvertTo-Json -Depth 6 -Compress
`;

// ---------------- policy ----------------
const norm = (s) => String(s || '').toLowerCase();
const normType = (s) => norm(s).replace(/^\[|\]$/g, '').replace(/^system\./, '');

// Cmdlets (and aliases) that only read or transform data in memory.
const CMDLETS = new Set([
  'get-content', 'gc', 'cat', 'type', 'get-childitem', 'gci', 'ls', 'dir', 'select-string', 'sls', 'test-path',
  'get-item', 'gi', 'get-itemproperty', 'gp', 'resolve-path', 'rvpa', 'get-location', 'gl', 'pwd', 'get-filehash',
  'split-path', 'join-path', 'measure-object', 'measure', 'select-object', 'select', 'where-object', 'where', '?',
  'foreach-object', 'foreach', '%', 'sort-object', 'sort', 'group-object', 'group', 'format-table', 'ft',
  'format-list', 'fl', 'format-wide', 'fw', 'out-string', 'write-output', 'echo', 'write', 'write-host',
  'convertto-json', 'convertfrom-json', 'convertto-csv', 'convertfrom-csv', 'compare-object', 'compare', 'diff',
  'get-date', 'get-unique', 'gu', 'get-member', 'gm', 'select-xml', 'get-command', 'gcm', 'out-null', 'get-random',
]);
// ForEach-Object with a string argument invokes that method on every item (e.g. `% Delete`): only script blocks allowed.
const BLOCK_ONLY = new Set(['foreach-object', 'foreach', '%']);
const FOREACH_PARAMS = new Set(['process', 'begin', 'end']);

// Static .NET members allowed per type ('*' = any member).
const STATIC = {
  regex: ['matches', 'match', 'ismatch', 'replace', 'split', 'escape', 'unescape'],
  'text.regularexpressions.regex': ['matches', 'match', 'ismatch', 'replace', 'split', 'escape', 'unescape'],
  math: '*', string: ['join', 'format', 'isnullorempty', 'isnullorwhitespace', 'concat', 'compare', 'equals', 'empty'],
  char: '*', int: ['parse', 'tryparse', 'maxvalue', 'minvalue'], int32: ['parse', 'tryparse', 'maxvalue', 'minvalue'],
  int64: ['parse', 'tryparse', 'maxvalue', 'minvalue'], long: ['parse', 'tryparse', 'maxvalue', 'minvalue'], double: ['parse', 'tryparse'],
  datetime: ['now', 'utcnow', 'today', 'parse', 'tryparse', 'parseexact'], timespan: ['fromseconds', 'fromminutes', 'fromhours', 'fromdays', 'frommilliseconds'],
  convert: ['tostring', 'toint32', 'toint64', 'todouble', 'toboolean', 'tobase64string', 'frombase64string'],
  'io.path': ['getfilename', 'getfilenamewithoutextension', 'getextension', 'getdirectoryname', 'combine', 'join', 'getfullpath', 'ispathrooted', 'getrelativepath', 'directoryseparatorchar', 'altdirectoryseparatorchar'],
  'io.file': ['readalltext', 'readalllines', 'exists'], 'io.directory': ['exists', 'getfiles', 'getdirectories', 'enumeratefiles', 'enumeratedirectories'],
  environment: ['newline'], 'text.encoding': ['utf8', 'ascii', 'unicode', 'default'],
};
// Instance methods allowed on any object: string/collection operations with no side effects.
const METHODS = new Set([
  'tostring', 'trim', 'trimstart', 'trimend', 'split', 'replace', 'substring', 'contains', 'startswith', 'endswith',
  'indexof', 'lastindexof', 'indexofany', 'tolower', 'toupper', 'tolowerinvariant', 'toupperinvariant', 'padleft',
  'padright', 'equals', 'compareto', 'insert', 'normalize', 'match', 'matches', 'ismatch', 'gettype', 'tochararray',
  'getbytes', 'getstring', 'where', 'foreach', 'containskey', 'containsvalue', 'getenumerator', 'tostring', 'tryparse',
  'add', 'remove', 'clear', 'toarray', 'gethashcode', 'getvalue', 'tryget', 'trygetvalue',
]);
// .Where()/.ForEach() with a string argument also invoke members: script blocks only.
const METHODS_BLOCK_ONLY = new Set(['where', 'foreach']);
// Types allowed in casts and type constraints.
const CAST_TYPES = new Set(['string', 'int', 'int32', 'int64', 'long', 'double', 'decimal', 'float', 'single', 'bool', 'boolean',
  'char', 'byte', 'array', 'object', 'psobject', 'pscustomobject', 'hashtable', 'ordered', 'regex', 'text.regularexpressions.regex',
  'datetime', 'timespan', 'version', 'guid', 'xml', 'string[]', 'int[]', 'object[]', 'char[]', 'byte[]', 'collections.arraylist',
  'collections.generic.list[string]', 'collections.generic.list[object]', 'collections.generic.list[int]', 'math', 'convert',
  'io.path', 'io.file', 'io.directory', 'environment', 'text.encoding']);

function evaluate(r, { root, cwd }) {
  if (r.errors && r.errors.length) return { ok: false, reason: `PowerShell parse error: ${r.errors[0]}` };
  if (r.banned.length) return { ok: false, reason: `contains ${r.banned[0].replace(/Ast$/, '')}` };
  if (r.fileRedirects) return { ok: false, reason: 'redirects output to a file' };
  for (const c of r.commands) {
    if (!c.name) return { ok: false, reason: 'calls a command whose name is computed' };
    if (c.op !== 'Unknown') return { ok: false, reason: `invokes with ${c.op === 'Ampersand' ? '&' : '.'}` };
    const n = norm(c.name);
    if (!CMDLETS.has(n)) return { ok: false, reason: `${c.name} is not a read-only command` };
    if (BLOCK_ONLY.has(n) && (c.nonBlockArgs > 0 || c.params.some((p) => !FOREACH_PARAMS.has(p)))) return { ok: false, reason: `${c.name} with a member name runs methods` };
  }
  for (const m of r.members) {
    if (!m.name) return { ok: false, reason: 'uses a computed member name' };
    const name = norm(m.name);
    if (m.static) {
      const allowed = STATIC[normType(m.type)];
      if (!allowed || (allowed !== '*' && !allowed.includes(name))) return { ok: false, reason: `uses [${m.type}]::${m.name}` };
    } else if (m.kind === 'method') {
      if (!METHODS.has(name)) return { ok: false, reason: `calls .${m.name}()` };
      if (METHODS_BLOCK_ONLY.has(name) && !m.blockArgs) return { ok: false, reason: `.${m.name}() with a member name runs methods` };
    }
  }
  for (const t of r.types) if (!CAST_TYPES.has(normType(t)) && !STATIC[normType(t)]) return { ok: false, reason: `uses type [${t}]` };
  for (const a of r.assigns) if (!a.ok) return { ok: false, reason: `assigns to ${a.target}` };
  for (const v of r.vars) if (!/^env:/i.test(v)) return { ok: false, reason: `uses provider variable \${${v}}` };
  for (const p of r.paths) if (!inside(root, cwd, p)) return { ok: false, reason: `reads outside the workspace (${p})` };
  return { ok: true };
}

function inside(root, cwd, p) {
  if (/^~/.test(p)) p = path.join(os.homedir(), p.slice(1));
  if (/^[a-zA-Z]:[\\/]|^\\\\|^\/\//.test(p) && process.platform !== 'win32') return false;
  const r = path.relative(root, path.resolve(cwd, p));
  return !(r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r));
}

// ---------------- running PowerShell ----------------
let psExe;
function findPowerShell() {
  if (psExe !== undefined) return psExe;
  psExe = null;
  const cands = [process.env.OAI_AGENT_PWSH, ...(process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'])].filter(Boolean);
  for (const c of cands) {
    try { execFileSync(c, ['-NoProfile', '-NonInteractive', '-Command', '1'], { stdio: 'ignore', timeout: 10000, windowsHide: true }); psExe = c; break; } catch { /* next */ }
  }
  return psExe;
}

function analyze(script, timeoutMs = 8000) {
  const exe = findPowerShell();
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    const encoded = Buffer.from(ANALYZER, 'utf16le').toString('base64');
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', encoded], {
      env: { ...process.env, OAI_PS_SRC: Buffer.from(script, 'utf8').toString('base64') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split(/\r?\n/).pop())); } catch { resolve(null); }
    });
  });
}

/**
 * Extract the PowerShell script from a run_command command line, or null if it can't be isolated safely.
 * The outer shell must not be able to see or alter any part of the script:
 * - cmd.exe (Windows default): exactly one "..." argument with no inner double quotes. cmd does not
 *   understand \" escapes, so an inner quote would let & | run outside PowerShell.
 * - POSIX shells: '...' with no inner single quotes, or "..." without $ ` \ ! (which the shell expands).
 * - If the configured shell is PowerShell itself, the whole command is the script.
 */
function extractScript(command, { shell = '', platform = process.platform } = {}) {
  if (/pwsh|powershell/i.test(shell)) return command;
  const m = String(command).match(/^\s*(?:powershell|pwsh)(?:\.exe)?((?:\s+-(?:NoProfile|NonInteractive|NoLogo|ExecutionPolicy\s+\w+))*)\s+-(?:c|command)\s+([\s\S]+?)\s*$/i);
  if (!m) return null;
  const arg = m[2];
  const posix = platform !== 'win32' && !/cmd(\.exe)?$/i.test(shell);
  if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) {
    const inner = arg.slice(1, -1);
    if (inner.includes('"')) return null;
    if (posix && /[$`\\!]/.test(inner)) return null;
    return inner;
  }
  if (posix && arg.length >= 2 && arg.startsWith("'") && arg.endsWith("'") && !arg.slice(1, -1).includes("'")) return arg.slice(1, -1);
  return null;
}

const cache = new Map();
/**
 * Is this PowerShell script read-only? Resolves {ok, reason}. Fails closed (ok:false) when PowerShell
 * isn't available, the analysis fails or times out, or the script is too long.
 */
async function classifyPowerShell(script, { root, cwd = root }) {
  if (!script || script.length > 8000) return { ok: false, reason: 'script too long to check' };
  const key = `${root}\n${cwd}\n${script}`;
  if (cache.has(key)) return cache.get(key);
  const r = await analyze(script);
  const res = r ? evaluate(r, { root, cwd }) : { ok: false, reason: 'PowerShell analysis unavailable' };
  if (cache.size > 200) cache.clear();
  cache.set(key, res);
  return res;
}

module.exports = { classifyPowerShell, extractScript, evaluate, analyze, findPowerShell };
