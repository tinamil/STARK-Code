#!/usr/bin/env node
// Runs the agent on a fixed set of small coding tasks against a real model and reports, per task:
// pass/fail, steps, tokens, tool calls, failed tool calls and repeated file reads.
//
//   EVAL_BASE_URL  OpenAI-compatible base URL   (default https://api.anthropic.com/v1)
//   EVAL_API_KEY   API key (falls back to ANTHROPIC_API_KEY)
//   EVAL_MODEL     model name                   (default claude-haiku-5-5)
//
//   node eval/run.js                 run every task
//   node eval/run.js fix-bug         run the named tasks
//   node eval/run.js --self-test     check the task checkers only (no model, no key)
//
// Each task runs in its own temporary folder with approvals set to automatic. Destructive commands
// and anything outside that folder still ask, and the eval denies them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/agent');
const { tasks } = require('./tasks');

function workspace(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stark-eval-${task.id}-`));
  for (const [f, content] of Object.entries(task.files)) fs.writeFileSync(path.join(dir, f), content);
  return dir;
}

/** Proves each checker fails on the untouched task and passes on its reference solution. */
async function selfTest() {
  let bad = 0;
  for (const task of tasks) {
    const dir = workspace(task);
    const before = await task.check(dir, task.files, '');
    const answer = task.solve(dir) || '';
    const after = await task.check(dir, task.files, answer);
    const ok = before !== null && after === null;
    if (!ok) bad++;
    console.log(`${ok ? 'ok    ' : 'NOT OK'} ${task.id}${ok ? '' : `  (untouched: ${before === null ? 'passed, should fail' : 'fails'}; solved: ${after === null ? 'passes' : after})`}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return bad;
}

async function runTask(task, cfg, apiKey) {
  const dir = workspace(task);
  const s = { steps: 0, toolCalls: 0, toolErrors: 0, denied: 0, compactions: 0, promptTokens: 0, outputTokens: 0, reads: {}, tools: {}, errors: [] };
  const names = new Map();
  const agent = new Agent({
    getConfig: () => cfg, getApiKey: async () => apiKey, getRoot: () => dir,
    ui: {
      registerProposal() {}, log() {},
      approve: async () => { s.denied++; return { decision: 'no', feedback: 'Not allowed in this evaluation. Stay inside the project folder and avoid destructive commands.' }; },
      post(m) {
        if (m.type === 'assistantStart') s.steps++;
        else if (m.type === 'tool') {
          s.toolCalls++; names.set(m.id, m.name); s.tools[m.name] = (s.tools[m.name] || 0) + 1;
          if (m.name === 'read_file' && m.args && m.args.path) s.reads[m.args.path] = (s.reads[m.args.path] || 0) + 1;
        } else if (m.type === 'toolResult' && !m.ok && !m.denied) s.toolErrors++;
        else if (m.type === 'usage' && m.usage) { s.promptTokens += m.usage.prompt_tokens || 0; s.outputTokens += m.usage.completion_tokens || 0; }
        else if (m.type === 'info' && /Summarized earlier steps|Trimmed old tool output/.test(m.text)) s.compactions++;
        else if (m.type === 'error') s.errors.push(m.text);
      },
    },
  });
  const t0 = Date.now();
  await agent.run(task.prompt);
  const answer = [...agent.messages].reverse().find((m) => m.role === 'assistant' && m.content)?.content || '';
  let problem;
  try { problem = s.errors.length ? `agent error: ${s.errors[0].slice(0, 200)}` : await task.check(dir, task.files, answer); }
  catch (e) { problem = `check crashed: ${e.message}`; }
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    id: task.id, pass: problem === null, problem, seconds: Math.round((Date.now() - t0) / 1000), steps: s.steps, toolCalls: s.toolCalls,
    toolErrors: s.toolErrors, denied: s.denied, rereads: Object.values(s.reads).reduce((n, c) => n + Math.max(0, c - 1), 0),
    compactions: s.compactions, promptTokens: s.promptTokens, outputTokens: s.outputTokens, tools: s.tools,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit((await selfTest()) ? 1 : 0);

  const apiKey = process.env.EVAL_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const cfg = {
    baseUrl: process.env.EVAL_BASE_URL || 'https://api.anthropic.com/v1',
    model: process.env.EVAL_MODEL || 'claude-haiku-5-5',
    approvalMode: 'auto', maxSteps: 40, contextWindow: 200000, compactAt: 50000, compactTo: 10000,
    commandTimeoutMs: 60000, maxToolOutputChars: 20000, autoApproveCommands: [], extraHeaders: {}, extraBody: {},
  };
  if (!apiKey) { console.error('Set EVAL_API_KEY (or ANTHROPIC_API_KEY). Use --self-test to check the tasks without a model.'); process.exit(2); }
  const wanted = args.filter((a) => !a.startsWith('--'));
  const chosen = wanted.length ? tasks.filter((t) => wanted.includes(t.id)) : tasks;
  if (!chosen.length) { console.error(`No such task. Tasks: ${tasks.map((t) => t.id).join(', ')}`); process.exit(2); }

  console.log(`Model ${cfg.model} at ${cfg.baseUrl}\n`);
  const results = [];
  for (const task of chosen) {
    process.stdout.write(`${task.id} … `);
    const r = await runTask(task, cfg, apiKey);
    results.push(r);
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.steps} steps, ${r.toolCalls} tool calls (${r.toolErrors} failed), ${r.rereads} re-reads, ${r.promptTokens + r.outputTokens} tokens, ${r.seconds}s${r.pass ? '' : `\n    ${r.problem}`}`);
  }
  const sum = (k) => results.reduce((n, r) => n + r[k], 0);
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed · ${sum('steps')} steps · ${sum('toolCalls')} tool calls, ${sum('toolErrors')} failed · ${sum('promptTokens')} input + ${sum('outputTokens')} output tokens`);
  const out = path.join(process.cwd(), 'eval-results.json');
  fs.writeFileSync(out, JSON.stringify({ model: cfg.model, baseUrl: cfg.baseUrl, date: new Date().toISOString(), results }, null, 2));
  console.log(`Details written to ${out}`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
