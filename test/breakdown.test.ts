import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { breakdownGate, buildBreakdownPrompt, decideBreakdown, parseBreakdownAnswer, rulesVerdict, type BreakdownEvidence } from '../src/breakdown.js';
import { DEFAULTS, type BreakdownConfig, type Config } from '../src/config.js';
import { parseBreakdownDecision } from '../src/jev.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import { loadProject } from '../src/project.js';
import type { RunContext, RunFlags } from '../src/runner.js';
import { runCommand, runTask } from '../src/runner.js';
import { splitTask } from '../src/split.js';
import { loadState } from '../src/state.js';
import type { Task } from '../src/tasks.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };
const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false };
const claudeResult = (status: string, summary: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: `SYMPHONY_RESULT\nstatus: ${status}\nsummary: ${summary}\nEND_SYMPHONY_RESULT` });
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const task = (id = 'T05'): Task => ({ id, num: 5, title: 'Build the whole pipeline', phase: 'Phase 1', order: 0, meta: {} });
const evidence = (over: Partial<BreakdownEvidence> = {}): BreakdownEvidence => ({ stage: 'failure', task: task(), status: 'failed', attempts: 2, continuations: 0, ...over });
const cfg = (over: Partial<BreakdownConfig> = {}): Config => ({ ...DEFAULTS, breakdown: { ...DEFAULTS.breakdown, ...over } });
const rules = (over: Partial<BreakdownConfig['rules']> = {}): BreakdownConfig['rules'] => ({ ...DEFAULTS.breakdown.rules, ...over });

/** A git project with a ROADMAP.md and fixture helpers, for the runner-level tests. */
function project(roadmap: string, files: Record<string, string> = {}): { dir: string; paths: Paths } {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-breakdown-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(join(dir, 'fixtures'), { recursive: true });
  writeFileSync(paths.roadmap, roadmap);
  writeFileSync(paths.progress, '# Progress notes\n');
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  process.env.SYMPHONY_FAKE_FIXTURES = join(dir, 'fixtures');
  return { dir, paths };
}

test('breakdownGate opens per stage from the switch and the rules thresholds', () => {
  assert.equal(breakdownGate(DEFAULTS.breakdown, evidence()).open, false, 'off by default');

  const on = cfg({ enabled: true }).breakdown;
  assert.match(breakdownGate(on, evidence({ stage: 'start', taskBytes: 20000 })).why, /onStart is off/);
  assert.equal(breakdownGate(on, evidence({ stage: 'start', taskBytes: 20000 })).open, false);

  const withStart = cfg({ enabled: true, onStart: true }).breakdown;
  assert.match(breakdownGate(withStart, evidence({ stage: 'start', taskBytes: 100 })).why, /minTaskBytes 16384/);
  assert.equal(breakdownGate(withStart, evidence({ stage: 'start', taskBytes: 20000 })).open, true);
  assert.equal(breakdownGate(withStart, evidence({ stage: 'start', taskBytes: 20000, taskBody: undefined })).open, true);

  assert.equal(breakdownGate(on, evidence({ stage: 'continue', continuations: 0 })).open, false, 'afterContinuations defaults to 1');
  assert.equal(breakdownGate(on, evidence({ stage: 'continue', continuations: 1 })).open, true);
  assert.equal(breakdownGate(cfg({ enabled: true, rules: rules({ afterContinuations: 2 }) }).breakdown, evidence({ stage: 'continue', continuations: 1 })).open, false);

  assert.equal(breakdownGate(on, evidence({ category: 'network' })).open, false, 'infrastructure categories do not open it');
  assert.equal(breakdownGate(on, evidence({ category: 'verify' })).open, true);
  assert.equal(breakdownGate(on, evidence({ category: 'task', attempts: 0 })).open, false, 'afterFailedAttempts defaults to 1');
  assert.equal(breakdownGate(on, evidence({ category: 'task', attempts: 1 })).open, true);
  assert.match(breakdownGate(cfg({ enabled: true, onFailure: false }).breakdown, evidence()).why, /onFailure is off/);
});

test('rulesVerdict splits at start/continue and prefers the split over escalation on failure', () => {
  const b = cfg({ enabled: true }).breakdown;
  assert.equal(rulesVerdict(b, evidence({ stage: 'start' }), 'why').action, 'split');
  assert.equal(rulesVerdict(b, evidence({ stage: 'continue' }), 'why').action, 'split');
  assert.equal(rulesVerdict(b, evidence({ stage: 'failure' }), 'why').action, 'split');
  assert.match(rulesVerdict(b, evidence({ stage: 'failure' }), 'why').reason, /instead of escalating/);
  assert.equal(rulesVerdict({ ...b, preferOverEscalation: false }, evidence({ stage: 'failure' }), 'why').action, 'proceed');
});

test('decideBreakdown is silent while the gate is closed and answers with the rules when nothing else can', async () => {
  assert.equal(await decideBreakdown(cfg(), evidence()), undefined);
  const v = await decideBreakdown(cfg({ enabled: true }), evidence(), { env: {} });
  assert.equal(v?.source, 'rules');
  assert.equal(v?.action, 'split');
});

test('decideBreakdown asks Jev first, then the fallback LLM, then the rules', async () => {
  const config: Config = { ...cfg({ enabled: true, decision: 'auto' }), jev: { ...DEFAULTS.jev, enabled: true } };
  const answer = (choice: string, confidence: number) => (async () =>
    jsonResponse({ model: 'typesafe/jev-1.13', answers: { decision: { type: 'choice', choice, confidence } }, usage: { cost: 0.00002 } })) as unknown as typeof fetch;
  let askedLlm = 0;
  const askLlm = async () => { askedLlm += 1; return { action: 'proceed' as const, reason: 'another slice is fine' }; };

  const byJev = await decideBreakdown(config, evidence(), { fetchImpl: answer('escalate', 0.9), env: { OPENROUTER_API_KEY: 'k' }, askLlm });
  assert.equal(byJev?.source, 'jev');
  assert.equal(byJev?.action, 'escalate');
  assert.equal(byJev?.costUsd, 0.00002);
  assert.equal(askedLlm, 0, 'a confident Jev answer ends the chain');

  const lowConfidence = await decideBreakdown(config, evidence(), { fetchImpl: answer('split', 0.3), env: { OPENROUTER_API_KEY: 'k' }, askLlm });
  assert.equal(lowConfidence?.source, 'llm');
  assert.equal(lowConfidence?.action, 'proceed');
  assert.match(lowConfidence?.reason ?? '', /another slice is fine/);

  const noAnswer = await decideBreakdown(config, evidence(), { fetchImpl: answer('made_up', 0.9), env: { OPENROUTER_API_KEY: 'k' }, askLlm: async () => undefined });
  assert.equal(noAnswer?.source, 'rules');
  assert.equal(noAnswer?.action, 'split');

  const noKey = await decideBreakdown(config, evidence(), { env: {}, askLlm });
  assert.equal(noKey?.source, 'llm', 'without a Jev key the fallback LLM answers');
});

test('decideBreakdown pins a source when asked to', async () => {
  let asked = 0;
  const noopFetch = (async () => { asked += 1; return jsonResponse({}); }) as unknown as typeof fetch;
  const pinnedRules = { ...cfg({ enabled: true, decision: 'rules' }), jev: { ...DEFAULTS.jev, enabled: true } };
  const v = await decideBreakdown(pinnedRules, evidence(), { fetchImpl: noopFetch, env: { OPENROUTER_API_KEY: 'k' }, askLlm: async () => { asked += 1; return { action: 'stop' as const }; } });
  assert.equal(v?.source, 'rules');
  assert.equal(asked, 0, 'neither Jev nor the LLM is asked');

  // `jev` mode falls straight to the rules when Jev is unavailable (it does not ask the LLM).
  const pinnedJev = cfg({ enabled: true, decision: 'jev' });
  const v2 = await decideBreakdown(pinnedJev, evidence(), { env: {}, askLlm: async () => { asked += 1; return { action: 'stop' as const }; } });
  assert.equal(v2?.source, 'rules');
  assert.equal(asked, 0);
});

test('parseBreakdownDecision reads the Jev choice and rejects unknown words', () => {
  assert.equal(parseBreakdownDecision({ answers: { decision: { type: 'choice', choice: 'split', confidence: 0.8 } } })?.action, 'split');
  assert.equal(parseBreakdownDecision({ answers: { decision: { type: 'choice', choice: 'stop', confidence: 0.8 } } })?.action, 'stop');
  assert.equal(parseBreakdownDecision({ answers: { decision: { type: 'choice', choice: 'sleep', confidence: 0.8 } } }), undefined);
  assert.equal(parseBreakdownDecision(null), undefined);
});

test('parseBreakdownAnswer reads the block or a bare line, and respects the stage', () => {
  const block = 'thinking…\nSYMPHONY_BREAKDOWN\ndecision: split\nreason: several jobs in one task\nEND_SYMPHONY_BREAKDOWN\n';
  assert.deepEqual(parseBreakdownAnswer(block, 'failure'), { action: 'split', reason: 'several jobs in one task' });
  assert.equal(parseBreakdownAnswer('decision: run', 'start')?.action, 'proceed');
  assert.equal(parseBreakdownAnswer('decision: continue', 'continue')?.action, 'proceed');
  assert.equal(parseBreakdownAnswer('decision: split', 'failure')?.action, 'split');
  assert.equal(parseBreakdownAnswer('decision: probe', 'start'), undefined);
  assert.equal(parseBreakdownAnswer('no decision here', 'failure'), undefined);
  // `escalate` only exists at the failure stage.
  assert.equal(parseBreakdownAnswer('SYMPHONY_BREAKDOWN\ndecision: escalate\nEND_SYMPHONY_BREAKDOWN', 'start'), undefined);
});

test('buildBreakdownPrompt is self-contained and stage-specific', () => {
  const b = cfg({ enabled: true }).breakdown;
  const ev = evidence({ stage: 'continue', reason: 'first slice landed', continuations: 2, taskBody: '## Goal\nShip it.' });
  const text = buildBreakdownPrompt(ev, breakdownGate(b, ev).why);
  assert.doesNotMatch(text, /\{[a-zA-Z_]\w*\}/);
  assert.match(text, /## Goal\nShip it\./);
  assert.match(text, /- continue: the work is converging/);
  assert.match(text, /first slice landed/);
  assert.match(text, /SYMPHONY_BREAKDOWN/);
  const failure = buildBreakdownPrompt(evidence({ stage: 'failure', category: 'verify', reason: 'verify failed (exit 1)' }), 'why');
  assert.match(failure, /- escalate: a more capable model/);
  assert.match(failure, /verify failed \(exit 1\)/);
});

test('a continue boundary breaks the task down instead of starting another slice', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do the thing → [tasks/01-thing.md](tasks/01-thing.md)\n', { 'docs/tasks/01-thing.md': '# T01\n' });
  writeFileSync(join(dir, 'fixtures', 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    claudeResult('continue', 'first slice landed'),
  ].join('\n') + '\n');
  const loaded = loadProject(paths, silent);
  const config: Config = {
    ...DEFAULTS, provider: 'fake', maxContinuations: 3, nudge: false, watch: { ...DEFAULTS.watch, enabled: false },
    slack: { ...DEFAULTS.slack, enabled: true, channel: 'C123ABC', project: 'symphony' },
    breakdown: { ...DEFAULTS.breakdown, enabled: true, decision: 'rules', rules: rules({ afterContinuations: 0 }) },
  };
  const seen: string[] = [];
  const texts: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const text = new URLSearchParams(String(init?.body)).get('text');
    if (text) texts.push(text);
    return new Response(JSON.stringify({ ok: true, ts: '1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  let splits = 0;
  const ctx: RunContext = {
    paths, config, cli: {}, flags, log: silent, roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state,
    interrupted: false, abort: new AbortController(), autoSplits: new Map(), fetchImpl,
    performSplit: async (id) => { splits += 1; return { code: 0, parentId: id, children: ['T01a', 'T01b'] }; },
    onPlanChanged: (id, kids) => seen.push(`${id} → ${kids.join(', ')}`),
  };
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  try {
    const out = await runTask(ctx, loaded.tasks[0]);
    assert.equal(out.split, true);
    assert.equal(splits, 1);
    assert.equal(ctx.state.tasks.T01.attempts, 1, 'the second session never starts');
    assert.deepEqual(seen, ['T01 → T01a, T01b']);
    // The split is announced, naming the subtasks it was replaced with.
    const split = texts.find((t) => t.includes('T01 split'));
    assert.ok(split, `expected a taskSplit message, got: ${texts.join(' | ')}`);
    assert.match(split!, /T01a, T01b/);
  } finally {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a failure breaks the task down instead of failing it, and falls through when the split fails', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do the thing → [tasks/01-thing.md](tasks/01-thing.md)\n', { 'docs/tasks/01-thing.md': '# T01\n' });
  writeFileSync(join(dir, 'fixtures', 'T01.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    claudeResult('failed', 'the task is too large'),
  ].join('\n') + '\n');
  const config: Config = {
    ...DEFAULTS, provider: 'fake', nudge: false, watch: { ...DEFAULTS.watch, enabled: false },
    breakdown: { ...DEFAULTS.breakdown, enabled: true, decision: 'rules', rules: rules({ afterFailedAttempts: 1, onCategories: ['task'] }) },
  };
  const loaded = loadProject(paths, silent);
  let splits = 0;
  const ctx: RunContext = {
    paths, config, cli: {}, flags, log: silent, roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state,
    interrupted: false, abort: new AbortController(), autoSplits: new Map(),
    performSplit: async (id) => { splits += 1; return { code: 0, parentId: id, children: ['T01a', 'T01b'] }; },
  };
  try {
    const out = await runTask(ctx, loaded.tasks[0]);
    assert.equal(out.split, true);
    assert.equal(splits, 1);
    assert.equal(ctx.state.tasks.T01.status, 'running', 'the task is not finalised as failed');

    // The same failure with a split that cannot complete falls back to the ordinary failure path.
    const failing = loadProject(paths, silent);
    const ctx2: RunContext = {
      ...ctx, roadmap: failing.roadmap, tasks: failing.tasks, state: failing.state, autoSplits: new Map(),
      performSplit: async (id) => { splits += 1; return { code: 2, parentId: id, children: [], error: 'the rewrite failed validation' }; },
    };
    const out2 = await runTask(ctx2, failing.tasks[0]);
    assert.equal(out2.split, undefined);
    assert.equal(out2.status, 'failed');
    assert.equal(ctx2.state.tasks.T01.status, 'failed');
    assert.equal(splits, 2, 'the second attempt was made but did not split');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('decideBreakdown runs the fallback LLM session and reads its decision block', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Big\n');
  writeFileSync(join(dir, 'fixtures', 'breakdown-failure.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', total_cost_usd: 0.001, result: 'SYMPHONY_BREAKDOWN\ndecision: split\nreason: too many jobs in one task\nEND_SYMPHONY_BREAKDOWN' }),
  ].join('\n') + '\n');
  const config: Config = {
    ...DEFAULTS, provider: 'fake', watch: { ...DEFAULTS.watch, enabled: false },
    breakdown: { ...DEFAULTS.breakdown, enabled: true, decision: 'llm', provider: 'fake', model: '' },
  };
  try {
    const v = await decideBreakdown(config, evidence({ stage: 'failure', category: 'task' }), { paths, log: silent, env: {} });
    assert.equal(v?.source, 'llm');
    assert.equal(v?.action, 'split');
    assert.match(v?.reason ?? '', /too many jobs in one task/);
    assert.equal(v?.costUsd, 0.001);

    // A session with no usable block falls through to the rules.
    writeFileSync(join(dir, 'fixtures', 'breakdown-failure.jsonl'), [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
      claudeResult('done', 'I would rather not answer'),
    ].join('\n') + '\n');
    const fallback = await decideBreakdown(config, evidence({ stage: 'failure', category: 'task' }), { paths, log: silent, env: {} });
    assert.equal(fallback?.source, 'rules');
    assert.equal(fallback?.action, 'split');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('run: an on-start breakdown rewrites the plan and the run continues on the subtasks', async () => {
  const { dir, paths } = project(
    '# Roadmap\n\n## Phase 1\n\n- [ ] T02 — Big → [tasks/02-big.md](tasks/02-big.md)\n- [ ] T03 — Later\n',
    { 'docs/tasks/02-big.md': '# T02 — Big\n\n## Goal\ntoo big\n' },
  );
  const fixtures = join(dir, 'fixtures');
  const newRoadmap = '# Roadmap\n\n## Phase 1\n\n- [ ] T02a — Schema → [tasks/02a-schema.md](tasks/02a-schema.md)\n- [ ] T02b — API → [tasks/02b-api.md](tasks/02b-api.md)\n- [ ] T03 — Later\n';
  writeFileSync(join(fixtures, 'split-T02.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_rm', path: 'docs/tasks/02-big.md' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/tasks/02a-schema.md', content: '# T02a\n' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/tasks/02b-api.md', content: '# T02b\n' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/ROADMAP.md', content: newRoadmap }),
    claudeResult('done', 'T02 → T02a, T02b'),
  ].join('\n') + '\n');
  for (const id of ['T02a', 'T02b', 'T03']) {
    writeFileSync(join(fixtures, `${id}.jsonl`), [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: `s-${id}` }),
      JSON.stringify({ type: 'fake_write', path: `${id}.txt`, content: id }),
      claudeResult('done', `${id} finished`),
    ].join('\n') + '\n');
  }
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;

  const loaded = loadProject(paths, silent);
  const config: Config = {
    ...DEFAULTS, provider: 'fake', nudge: false, watch: { ...DEFAULTS.watch, enabled: false },
    breakdown: { ...DEFAULTS.breakdown, enabled: true, onStart: true, decision: 'rules', rules: rules({ minTaskBytes: 20 }) },
  };
  // Wired exactly like the CLI: the automatic breakdown shares the run's lock.
  const ctx: RunContext = {
    paths, config, cli: {}, flags, log: silent, roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state,
    interrupted: false, abort: new AbortController(),
  };
  ctx.performSplit = (id) => splitTask(ctx, { id, dryRun: false, keepLock: true });
  try {
    const code = await runCommand(ctx);
    assert.equal(code, 0);
    const roadmap = readFileSync(paths.roadmap, 'utf8');
    assert.doesNotMatch(roadmap, /T02 — Big/);
    assert.match(roadmap, /- \[x\] T02a — Schema/);
    assert.match(roadmap, /- \[x\] T02b — API/);
    assert.match(roadmap, /- \[x\] T03 — Later/);
    assert.equal(ctx.state.tasks.T02, undefined, 'the parent state row is gone');
    assert.equal(ctx.state.tasks.T02a.status, 'done');
    assert.equal(ctx.state.tasks.T02b.status, 'done');
    assert.equal(loadState(paths).tasks.T02, undefined, 'the split is persisted to disk');
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(log, /docs: split T02 into T02a, T02b \[split\]/);
    assert.match(log, /T02a: Schema \[done\]/);
    assert.match(log, /T03: Later \[done\]/);
    // The children's work is committed; the only possible straggler is the run-end refresh of the
    // ROADMAP status block, whose timestamp is not part of any task commit.
    const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    assert.ok(dirty === '' || dirty === 'M docs/ROADMAP.md', `unexpected dirty files: ${dirty}`);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('run: a continue boundary breaks the task down and the run resumes on the children', async () => {
  const { dir, paths } = project(
    '# Roadmap\n\n## Phase 1\n\n- [ ] T01 — Big → [tasks/01-big.md](tasks/01-big.md)\n',
    { 'docs/tasks/01-big.md': '# T01 — Big\n\n## Goal\nstill too big\n' },
  );
  const fixtures = join(dir, 'fixtures');
  writeFileSync(join(fixtures, 'T01.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_write', path: 'slice.txt', content: 'one slice landed' }),
    claudeResult('continue', 'one slice landed, more remains'),
  ].join('\n') + '\n');
  const newRoadmap = '# Roadmap\n\n## Phase 1\n\n- [ ] T01a — First → [tasks/01a-first.md](tasks/01a-first.md)\n- [ ] T01b — Second → [tasks/01b-second.md](tasks/01b-second.md)\n';
  writeFileSync(join(fixtures, 'split-T01.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    JSON.stringify({ type: 'fake_rm', path: 'docs/tasks/01-big.md' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/tasks/01a-first.md', content: '# T01a\n' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/tasks/01b-second.md', content: '# T01b\n' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/ROADMAP.md', content: newRoadmap }),
    claudeResult('done', 'T01 → T01a, T01b'),
  ].join('\n') + '\n');
  for (const id of ['T01a', 'T01b']) {
    writeFileSync(join(fixtures, `${id}.jsonl`), [JSON.stringify({ type: 'system', subtype: 'init', session_id: `s-${id}` }), claudeResult('done', `${id} finished`)].join('\n') + '\n');
  }
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;

  const loaded = loadProject(paths, silent);
  const config: Config = {
    ...DEFAULTS, provider: 'fake', nudge: false, maxContinuations: 4, watch: { ...DEFAULTS.watch, enabled: false },
    breakdown: { ...DEFAULTS.breakdown, enabled: true, decision: 'rules', rules: rules({ afterContinuations: 0 }) },
  };
  const ctx: RunContext = {
    paths, config, cli: {}, flags, log: silent, roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state,
    interrupted: false, abort: new AbortController(),
  };
  ctx.performSplit = (id) => splitTask(ctx, { id, dryRun: false, keepLock: true });
  try {
    const code = await runCommand(ctx);
    assert.equal(code, 0);
    const roadmap = readFileSync(paths.roadmap, 'utf8');
    assert.doesNotMatch(roadmap, /T01 — Big/);
    assert.match(roadmap, /- \[x\] T01a — First/);
    assert.match(roadmap, /- \[x\] T01b — Second/);
    assert.equal(ctx.state.tasks.T01, undefined);
    assert.equal(ctx.state.tasks.T01a.attempts, 1, 'the children needed one session each');
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(log, /T01: Big \[continue\]/, 'the finished slice was committed first');
    assert.match(log, /docs: split T01 into T01a, T01b \[split\]/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});
