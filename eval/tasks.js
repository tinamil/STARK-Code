// Tasks for eval/run.js. Each task has:
//   files   - the starting workspace
//   prompt  - what the user asks
//   check   - async (dir, run) => string|null; null means pass, a string says what is wrong
//   solve   - a reference solution, used only to prove the check accepts a correct result
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
// NODE_TEST_CONTEXT is set when this runs under `node --test`; a nested test run that inherits it
// always exits 0, which would make every "tests pass" check succeed.
const cleanEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };
const node = (dir, args) => {
  try { return { code: 0, out: execFileSync(process.execPath, args, { cwd: dir, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};

const tasks = [
  {
    id: 'fix-bug',
    prompt: 'The tests in sum.test.js fail. Find the bug and fix it. Do not change the tests.',
    files: {
      'sum.js': 'function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n\nmodule.exports = { sumTo };\n',
      'sum.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sumTo } = require('./sum');\n\ntest('sums 1..n', () => {\n  assert.strictEqual(sumTo(1), 1);\n  assert.strictEqual(sumTo(4), 10);\n  assert.strictEqual(sumTo(0), 0);\n});\n",
    },
    check(dir, start) {
      if (read(dir, 'sum.test.js') !== start['sum.test.js']) return 'the test file was changed';
      const r = node(dir, ['--test', 'sum.test.js']);
      return r.code === 0 ? null : 'tests still fail';
    },
    solve(dir) { fs.writeFileSync(path.join(dir, 'sum.js'), read(dir, 'sum.js').replace('i < n', 'i <= n')); },
  },
  {
    id: 'add-function',
    prompt: 'Add a function slugify(text) to strings.js and export it. It lowercases the text, replaces each run of characters that are not letters or digits with a single hyphen, and removes hyphens from the start and end. Keep the existing function working.',
    files: {
      'strings.js': 'function capitalize(text) {\n  return text.charAt(0).toUpperCase() + text.slice(1);\n}\n\nmodule.exports = { capitalize };\n',
    },
    check(dir) {
      const script = "const s = require('./strings'); const a = require('node:assert');" +
        "a.strictEqual(s.capitalize('abc'), 'Abc'); a.strictEqual(s.slugify('Hello, World!'), 'hello-world');" +
        "a.strictEqual(s.slugify('  A  b__C  '), 'a-b-c'); a.strictEqual(s.slugify('already-ok'), 'already-ok');";
      const r = node(dir, ['-e', script]);
      return r.code === 0 ? null : `slugify is missing or wrong: ${r.out.split('\n').find((l) => /Error|expected|actual/.test(l)) || ''}`.trim();
    },
    solve(dir) {
      fs.writeFileSync(path.join(dir, 'strings.js'), read(dir, 'strings.js').replace('module.exports = { capitalize };',
        "function slugify(text) {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n}\n\nmodule.exports = { capitalize, slugify };"));
    },
  },
  {
    id: 'rename-across-files',
    prompt: 'Rename the function getUser to fetchUser everywhere in this project. The program must still work.',
    files: {
      'users.js': "const USERS = { 1: 'Ada', 2: 'Linus' };\n\nfunction getUser(id) {\n  return USERS[id] || null;\n}\n\nmodule.exports = { getUser };\n",
      'greet.js': "const { getUser } = require('./users');\n\nfunction greet(id) {\n  const name = getUser(id);\n  return name ? `Hello, ${name}!` : 'Hello, stranger!';\n}\n\nmodule.exports = { greet };\n",
      'main.js': "const { greet } = require('./greet');\nconst { getUser } = require('./users');\n\nconsole.log(greet(1));\nconsole.log(greet(9));\nconsole.log(getUser(2));\n",
    },
    check(dir) {
      for (const f of ['users.js', 'greet.js', 'main.js']) if (/getUser/.test(read(dir, f))) return `getUser is still used in ${f}`;
      if (!/fetchUser/.test(read(dir, 'users.js'))) return 'fetchUser is not defined in users.js';
      const r = node(dir, ['main.js']);
      return r.code === 0 && r.out === 'Hello, Ada!\nHello, stranger!\nLinus\n' ? null : 'main.js no longer prints the same output';
    },
    solve(dir) { for (const f of ['users.js', 'greet.js', 'main.js']) fs.writeFileSync(path.join(dir, f), read(dir, f).replace(/getUser/g, 'fetchUser')); },
  },
  {
    id: 'explain-no-edit',
    prompt: 'What does parseList in parser.js return when it is given an empty string? Answer in one sentence. Do not change any files.',
    files: {
      'parser.js': "function parseList(text) {\n  return text.split(',').map((s) => s.trim()).filter((s) => s.length > 0);\n}\n\nmodule.exports = { parseList };\n",
    },
    check(dir, start, answer) {
      if (read(dir, 'parser.js') !== start['parser.js'] || fs.readdirSync(dir).length !== 1) return 'files were changed';
      return /empty (array|list)|\[\s*\]/i.test(answer) ? null : 'the answer does not say it returns an empty array';
    },
    solve() { return 'It returns an empty array ([]).'; },
  },
  {
    id: 'feature-two-files',
    prompt: 'Add a --json flag to report.js. With the flag it prints the report as JSON: an object with "items" (the array of {name, price}) and "total" (the sum of the prices). Without the flag the output must stay exactly as it is now. Put the JSON formatting in format.js next to the existing formatter.',
    files: {
      'data.js': "module.exports = [\n  { name: 'pen', price: 2 },\n  { name: 'book', price: 12 },\n];\n",
      'format.js': "function formatText(items) {\n  const lines = items.map((i) => `${i.name}: ${i.price}`);\n  const total = items.reduce((sum, i) => sum + i.price, 0);\n  return [...lines, `total: ${total}`].join('\\n');\n}\n\nmodule.exports = { formatText };\n",
      'report.js': "const items = require('./data');\nconst { formatText } = require('./format');\n\nconsole.log(formatText(items));\n",
    },
    check(dir) {
      const plain = node(dir, ['report.js']);
      if (plain.code !== 0 || plain.out !== 'pen: 2\nbook: 12\ntotal: 14\n') return 'output without the flag changed';
      const j = node(dir, ['report.js', '--json']);
      let parsed;
      try { parsed = JSON.parse(j.out); } catch { return '--json does not print valid JSON'; }
      if (parsed.total !== 14 || !Array.isArray(parsed.items) || parsed.items.length !== 2 || parsed.items[1].name !== 'book' || parsed.items[1].price !== 12) return '--json prints the wrong data';
      return /json/i.test(read(dir, 'format.js')) ? null : 'the JSON formatting is not in format.js';
    },
    solve(dir) {
      fs.writeFileSync(path.join(dir, 'format.js'), read(dir, 'format.js').replace('module.exports = { formatText };',
        "function formatJson(items) {\n  return JSON.stringify({ items, total: items.reduce((sum, i) => sum + i.price, 0) });\n}\n\nmodule.exports = { formatText, formatJson };"));
      fs.writeFileSync(path.join(dir, 'report.js'), "const items = require('./data');\nconst { formatText, formatJson } = require('./format');\n\nconsole.log(process.argv.includes('--json') ? formatJson(items) : formatText(items));\n");
    },
  },
];

module.exports = { tasks };
