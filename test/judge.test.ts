import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, resolveJudge, type Config, type JudgeConfig } from '../src/config.js';
import { buildJudgePrompt, collectChanges, parseJudgeAnswer, runJudge, type JudgeEvidence } from '../src/judge.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import { loadProject } from '../src/project.js';
import type { RunContext, RunFlags } from '../src/runner.js';
import { runTask } from '../src/runner.js';
import { newTaskState } from '../src/state.js';
import type { Task } from '../src/tasks.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };
const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false };
const PLACEHOLDER = /\{[a-zA-Z_]\w*\}/;
const claudeResult = (status: string, summary: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: `SYMPHONY_RESULT\nstatus: ${status}\nsummary: ${summary}\nEND_SYMPHONY_RESULT` });
const judgeBlock = (verdict: string, confidence: number, summary: string, gaps?: string) =>
  JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'j', total_cost_usd: 0.002,
    result: `SYMPHONY_JUDGE\nverdict: ${verdict}\nconfidence: ${confidence}\nsummary: ${summary}${gaps ? `\ngaps: ${gaps}` : ''}\nEND_SYMPHONY_JUDGE`,
  });

const cfg = (over: Partial<JudgeConfig> = {}): Config => ({ ...DEFAULTS, judge: { ...DEFAULTS.judge, ...over } });

/** A git project with a ROADMAP.md and fixture helpers, for the runner-level tests. */
function project(roadmap: string, files: Record<string, string> = {}): { dir: string; paths: Paths } {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-judge-'));
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
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  process.env.SYMPHONY_FAKE_FIXTURES = join(dir, 'fixtures');
  return { dir, paths };
}

test('parseJudgeAnswer reads the block and a bare verdict line, mapping pass/fail words', () => {
  const block = 'thinking…\nSYMPHONY_JUDGE\nverdict: fail\nconfidence: 0.82\nsummary: the export path is missing\ngaps: no CSV writer\nEND_SYMPHONY_JUDGE\n';
  assert.deepEqual(parseJudgeAnswer(block), { verdict: 'fail', confidence: 0.82, summary: 'the export path is missing', gaps: 'no CSV writer' });
  assert.deepEqual(parseJudgeAnswer('verdict: pass\nconfidence: 0.9\nsummary: matches scope'), { verdict: 'pass', confidence: 0.9, summary: 'matches scope', gaps: undefined });
  assert.equal(parseJudgeAnswer('verdict: passed')?.verdict, 'pass');
  assert.equal(parseJudgeAnswer('verdict: failed')?.verdict, 'fail');
  assert.equal(parseJudgeAnswer('verdict: maybe'), undefined);
  assert.equal(parseJudgeAnswer('no verdict here'), undefined);
  // An out-of-range confidence is dropped rather than trusted.
  assert.equal(parseJudgeAnswer('verdict: fail\nconfidence: 7\nsummary: x')?.confidence, undefined);
  // A missing summary still yields a usable verdict.
  assert.equal(parseJudgeAnswer('SYMPHONY_JUDGE\nverdict: pass\nEND_SYMPHONY_JUDGE')?.summary, 'judge passed the completion');
  // A malformed block with no usable verdict still falls back to a verdict written just outside it.
  assert.equal(parseJudgeAnswer('SYMPHONY_JUDGE\n(no fields)\nEND_SYMPHONY_JUDGE\nverdict: fail\nsummary: missed scope')?.verdict, 'fail');
  // The bare-line fallback prefers the last verdict, so an echoed example cannot override the answer.
  assert.equal(parseJudgeAnswer('For example "verdict: pass".\nverdict: fail\nsummary: missed scope')?.verdict, 'fail');
});

test('buildJudgePrompt is self-contained and leaks no placeholder', () => {
  const ev: JudgeEvidence = {
    taskId: 'T05', taskTitle: 'Add CSV export', taskPhase: 'Phase 1', status: 'done', attempts: 2,
    taskBody: '## Goal\nAdd a CSV export.\n', acceptance: [{ text: 'export button works', checked: true, blocking: true }, { text: 'ships a schema doc', checked: false, blocking: false }],
    verifyCommand: 'npm test', verifyOk: true, verifyOutput: '3 passing',
    sessionSummary: 'wired the export and its test', diff: 'diff --git a/x b/x\n+export', changedFiles: ['src/x.ts', 'docs/ROADMAP.md'],
    harnessFiles: ['docs/ROADMAP.md'],
    progressNote: '- wrote src/x.ts',
  };
  const text = buildJudgePrompt(ev);
  assert.doesNotMatch(text, PLACEHOLDER);
  assert.match(text, /Add a CSV export/);
  assert.match(text, /- \[x\] export button works/);
  assert.match(text, /- \[ \] ships a schema doc \[deferrable\]/);
  assert.match(text, /npm test/);
  assert.match(text, /3 passing/);
  assert.match(text, /wired the export and its test/);
  assert.match(text, /src\/x\.ts/);
  // Harness bookkeeping is labelled so the judge does not read it as task scope.
  assert.match(text, /- docs\/ROADMAP\.md \[harness\]/);
  assert.match(text, /ignore them when deciding/);
  assert.match(text, /SYMPHONY_JUDGE/);
  assert.match(text, /END_SYMPHONY_JUDGE/);
});

test('collectChanges names untracked files and captures tracked edits', () => {
  const { dir } = project('# R\n');
  writeFileSync(join(dir, 'new.txt'), 'hello');
  const tracked = join(dir, 'tracked.txt');
  writeFileSync(tracked, 'one\n');
  execFileSync('git', ['-C', dir, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  writeFileSync(tracked, 'one\ntwo\n');
  const changes = collectChanges(dir, 20_000);
  assert.ok(changes.files.some((f) => f.includes('tracked.txt')), changes.files.join(', '));
  assert.ok(changes.files.some((f) => f.includes('new.txt')), changes.files.join(', '));
  // Paths are clean: no porcelain status code or separator whitespace.
  assert.ok(changes.files.includes('tracked.txt'), changes.files.join(', '));
  assert.ok(changes.files.includes('new.txt'), changes.files.join(', '));
  assert.match(changes.diff, /\+two/);
  assert.match(changes.diff, /untracked files .*read them directly/);
  assert.equal(changes.truncated, false);
});

test('runJudge runs a read-only fake session and reads its verdict and cost', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do it\n');
  writeFileSync(join(dir, 'fixtures', 'judge-T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'j' }), judgeBlock('fail', 0.9, 'scope missed', 'no audit trail')].join('\n') + '\n');
  const config = cfg({ enabled: true, provider: 'fake', model: 'fake-model' });
  try {
    const v = await runJudge(config, { taskId: 'T01', taskTitle: 'Do it', taskPhase: 'P', status: 'done', attempts: 1 }, { paths, log: silent });
    assert.equal(v?.verdict, 'fail');
    assert.equal(v?.ok, false);
    assert.equal(v?.confidence, 0.9);
    assert.equal(v?.gaps, 'no audit trail');
    assert.equal(v?.provider, 'fake');
    assert.equal(v?.costUsd, 0.002);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('runJudge hands the session to onLog so the run can be tracked', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do it\n');
  writeFileSync(join(dir, 'fixtures', 'judge-T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'j' }), judgeBlock('pass', 0.9, 'matches scope')].join('\n') + '\n');
  const config = cfg({ enabled: true, provider: 'fake', model: 'fake-model' });
  const refs: Array<{ status?: string; jsonl: string; provider?: string }> = [];
  try {
    const v = await runJudge(config, { taskId: 'T01', taskTitle: 'Do it', taskPhase: 'P', status: 'done', attempts: 1 }, { paths, log: silent, onLog: (r) => refs.push(r) });
    assert.equal(v?.verdict, 'pass');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].status, 'pass 90%');
    assert.match(refs[0].jsonl, /judge-T01/);
    assert.equal(refs[0].provider, 'fake');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('runJudge returns undefined when the session omits a verdict, so the done is accepted', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do it\n');
  writeFileSync(join(dir, 'fixtures', 'judge-T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'j' }), claudeResult('done', 'I will not answer')].join('\n') + '\n');
  const config = cfg({ enabled: true, provider: 'fake', model: 'fake-model' });
  const warnings: string[] = [];
  const log: Logger = { info() {}, warn: (m) => warnings.push(m), error() {}, plain() {}, banner() {} };
  try {
    const v = await runJudge(config, { taskId: 'T01', taskTitle: 'Do it', taskPhase: 'P', status: 'done', attempts: 1 }, { paths, log });
    assert.equal(v, undefined);
    assert.ok(warnings.some((w) => /no usable verdict/.test(w)), warnings.join('\n'));
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

function runnerCtx(dir: string, paths: Paths, config: Config): RunContext {
  const loaded = loadProject(paths, silent);
  return {
    paths, config, cli: {}, flags, log: silent, roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state,
    interrupted: false, abort: new AbortController(), judgeCounts: new Map(),
  };
}

test('a confident failing judge demotes the done to failed and records an enforced verdict', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do it → [tasks/01-thing.md](tasks/01-thing.md)\n', { 'docs/tasks/01-thing.md': '# T01 — Do it\n\n## Goal\nShip the export.\n' });
  writeFileSync(join(dir, 'fixtures', 'T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }), JSON.stringify({ type: 'fake_write', path: 'work.txt', content: 'done' }), claudeResult('done', 'shipped it')].join('\n') + '\n');
  writeFileSync(join(dir, 'fixtures', 'judge-T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'j' }), judgeBlock('fail', 0.9, 'export path not implemented', 'no writer')].join('\n') + '\n');
  const config: Config = { ...DEFAULTS, provider: 'fake', nudge: false, watch: { ...DEFAULTS.watch, enabled: false }, judge: { ...DEFAULTS.judge, enabled: true, provider: 'fake', model: 'm' } };
  const ctx = runnerCtx(dir, paths, config);
  try {
    const out = await runTask(ctx, ctx.tasks[0]);
    assert.equal(out.status, 'failed');
    assert.equal(ctx.state.tasks.T01.status, 'failed');
    assert.equal(ctx.state.tasks.T01.judge?.verdict, 'fail');
    assert.equal(ctx.state.tasks.T01.judge?.enforced, true);
    assert.match(ctx.state.tasks.T01.summary ?? '', /judge rejected the completion/);
    // The judge run is recorded as a step with the enforced marker for the rerun.
    const judgeLog = ctx.state.tasks.T01.logs.find((l) => l.kind === 'judge');
    assert.ok(judgeLog, 'the judge session is recorded as a step');
    assert.match(judgeLog!.status ?? '', /^fail 90% enforced$/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('an escalated re-do after a judge rejection is judged again (maxPerTask is per terminal done)', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do it → [tasks/01-thing.md](tasks/01-thing.md)\n', { 'docs/tasks/01-thing.md': '# T01\n\n## Goal\nShip it.\n' });
  writeFileSync(join(dir, 'fixtures', 'T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }), JSON.stringify({ type: 'fake_write', path: 'work.txt', content: 'done' }), claudeResult('done', 'shipped it')].join('\n') + '\n');
  writeFileSync(join(dir, 'fixtures', 'judge-T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'j' }), judgeBlock('fail', 0.9, 'still missing', 'no audit trail')].join('\n') + '\n');
  const config: Config = {
    ...DEFAULTS, provider: 'fake', nudge: false, watch: { ...DEFAULTS.watch, enabled: false },
    judge: { ...DEFAULTS.judge, enabled: true, provider: 'fake', model: 'm', maxPerTask: 1 },
    escalation: { ...DEFAULTS.escalation, enabled: true, provider: 'fake', model: 'm', maxAttempts: 1, onCategories: ['judge'] },
  };
  const ctx = runnerCtx(dir, paths, config);
  try {
    const out = await runTask(ctx, ctx.tasks[0]);
    assert.equal(out.status, 'failed');
    assert.equal(ctx.judgeCounts?.size, 2, 'both terminal done attempts were judged');
    assert.equal(ctx.state.tasks.T01.logs.filter((l) => l.kind === 'judge').length, 2, 'each judge run is recorded');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('judge.onFail warn records the verdict but lets the done stand', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do it → [tasks/01-thing.md](tasks/01-thing.md)\n', { 'docs/tasks/01-thing.md': '# T01\n' });
  writeFileSync(join(dir, 'fixtures', 'T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }), JSON.stringify({ type: 'fake_write', path: 'work.txt', content: 'done' }), claudeResult('done', 'shipped it')].join('\n') + '\n');
  writeFileSync(join(dir, 'fixtures', 'judge-T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'j' }), judgeBlock('fail', 0.95, 'looks short')].join('\n') + '\n');
  const config: Config = { ...DEFAULTS, provider: 'fake', nudge: false, watch: { ...DEFAULTS.watch, enabled: false }, judge: { ...DEFAULTS.judge, enabled: true, provider: 'fake', model: 'm', onFail: 'warn' } };
  const ctx = runnerCtx(dir, paths, config);
  try {
    const out = await runTask(ctx, ctx.tasks[0]);
    assert.equal(out.status, 'done');
    assert.equal(ctx.state.tasks.T01.judge?.verdict, 'fail');
    assert.equal(ctx.state.tasks.T01.judge?.enforced, undefined);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a failing verdict below minConfidence is advisory, so the done stands', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do it → [tasks/01-thing.md](tasks/01-thing.md)\n', { 'docs/tasks/01-thing.md': '# T01\n' });
  writeFileSync(join(dir, 'fixtures', 'T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }), JSON.stringify({ type: 'fake_write', path: 'work.txt', content: 'done' }), claudeResult('done', 'shipped it')].join('\n') + '\n');
  writeFileSync(join(dir, 'fixtures', 'judge-T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'j' }), judgeBlock('fail', 0.3, 'not sure')].join('\n') + '\n');
  const config: Config = { ...DEFAULTS, provider: 'fake', nudge: false, watch: { ...DEFAULTS.watch, enabled: false }, judge: { ...DEFAULTS.judge, enabled: true, provider: 'fake', model: 'm', minConfidence: 0.7 } };
  const ctx = runnerCtx(dir, paths, config);
  try {
    const out = await runTask(ctx, ctx.tasks[0]);
    assert.equal(out.status, 'done');
    assert.equal(ctx.state.tasks.T01.judge?.verdict, 'fail');
    assert.equal(ctx.state.tasks.T01.judge?.enforced, undefined);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('judge.maxPerTask bounds judge sessions and clears a stale verdict when the done stands', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do it → [tasks/01-thing.md](tasks/01-thing.md)\n', { 'docs/tasks/01-thing.md': '# T01\n' });
  writeFileSync(join(dir, 'fixtures', 'T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }), JSON.stringify({ type: 'fake_write', path: 'work.txt', content: 'done' }), claudeResult('done', 'shipped it')].join('\n') + '\n');
  writeFileSync(join(dir, 'fixtures', 'judge-T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'j' }), judgeBlock('fail', 0.9, 'nope')].join('\n') + '\n');
  const config: Config = { ...DEFAULTS, provider: 'fake', nudge: false, watch: { ...DEFAULTS.watch, enabled: false }, judge: { ...DEFAULTS.judge, enabled: true, provider: 'fake', model: 'm', maxPerTask: 1 } };
  const ctx = runnerCtx(dir, paths, config);
  // The cap is keyed by task id + attempt; this done runs as attempt 2, so its budget was spent.
  ctx.judgeCounts!.set('T01#2', 1);
  // A prior attempt left a demoted verdict behind; the done must not inherit it.
  ctx.state.tasks.T01 = { ...newTaskState('Do it'), status: 'running', attempts: 1, judge: { verdict: 'fail', ok: false, summary: 'from a prior attempt', enforced: true, at: '2026-01-01T00:00:00Z' } };
  try {
    const out = await runTask(ctx, ctx.tasks[0]);
    assert.equal(out.status, 'done', 'over maxPerTask the done is accepted as reported');
    assert.equal(ctx.state.tasks.T01.judge, undefined, 'the stale demoted verdict is cleared');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a passing judge leaves the done standing and records the pass', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do it → [tasks/01-thing.md](tasks/01-thing.md)\n', { 'docs/tasks/01-thing.md': '# T01 — Do it\n\n## Goal\nShip it.\n' });
  writeFileSync(join(dir, 'fixtures', 'T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }), JSON.stringify({ type: 'fake_write', path: 'work.txt', content: 'done' }), claudeResult('done', 'shipped it')].join('\n') + '\n');
  writeFileSync(join(dir, 'fixtures', 'judge-T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'j' }), judgeBlock('pass', 0.9, 'matches scope')].join('\n') + '\n');
  const config: Config = { ...DEFAULTS, provider: 'fake', nudge: false, watch: { ...DEFAULTS.watch, enabled: false }, judge: { ...DEFAULTS.judge, enabled: true, provider: 'fake', model: 'm' } };
  const ctx = runnerCtx(dir, paths, config);
  try {
    const out = await runTask(ctx, ctx.tasks[0]);
    assert.equal(out.status, 'done');
    assert.equal(ctx.state.tasks.T01.judge?.verdict, 'pass');
    assert.equal(ctx.state.tasks.T01.judge?.enforced, undefined);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a failing verdict that reports no confidence is advisory, so the done stands', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do it → [tasks/01-thing.md](tasks/01-thing.md)\n', { 'docs/tasks/01-thing.md': '# T01\n' });
  writeFileSync(join(dir, 'fixtures', 'T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }), JSON.stringify({ type: 'fake_write', path: 'work.txt', content: 'done' }), claudeResult('done', 'shipped it')].join('\n') + '\n');
  const noConfidence = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'j', result: 'SYMPHONY_JUDGE\nverdict: fail\nsummary: not sure\nEND_SYMPHONY_JUDGE' });
  writeFileSync(join(dir, 'fixtures', 'judge-T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'j' }), noConfidence].join('\n') + '\n');
  const config: Config = { ...DEFAULTS, provider: 'fake', nudge: false, watch: { ...DEFAULTS.watch, enabled: false }, judge: { ...DEFAULTS.judge, enabled: true, provider: 'fake', model: 'm', minConfidence: 0.1 } };
  const ctx = runnerCtx(dir, paths, config);
  try {
    const out = await runTask(ctx, ctx.tasks[0]);
    assert.equal(out.status, 'done', 'with no confidence the failure cannot demote the done');
    assert.equal(ctx.state.tasks.T01.judge?.verdict, 'fail');
    assert.equal(ctx.state.tasks.T01.judge?.enforced, undefined);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a judge session that yields no verdict still charges its cost to the task', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T01 — Do it → [tasks/01-thing.md](tasks/01-thing.md)\n', { 'docs/tasks/01-thing.md': '# T01\n' });
  writeFileSync(join(dir, 'fixtures', 'T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }), JSON.stringify({ type: 'fake_write', path: 'work.txt', content: 'done' }), claudeResult('done', 'shipped it')].join('\n') + '\n');
  // The judge session answers with no usable verdict but reports a cost: it was still paid for, so
  // the run/task cost must include it even though the done is accepted.
  const noVerdict = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'j', total_cost_usd: 0.005, result: 'I cannot tell from here' });
  writeFileSync(join(dir, 'fixtures', 'judge-T01.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'j' }), noVerdict].join('\n') + '\n');
  const config: Config = { ...DEFAULTS, provider: 'fake', nudge: false, watch: { ...DEFAULTS.watch, enabled: false }, judge: { ...DEFAULTS.judge, enabled: true, provider: 'fake', model: 'm' } };
  const ctx = runnerCtx(dir, paths, config);
  try {
    const out = await runTask(ctx, ctx.tasks[0]);
    assert.equal(out.status, 'done', 'no verdict means the done stands');
    assert.equal(ctx.state.tasks.T01.judge, undefined);
    assert.equal(ctx.state.tasks.T01.costUsd, 0.005, 'the unverdicting judge session is still charged');
    assert.equal(ctx.runCostUsd, 0.005);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('resolveJudge falls back to the watch block and pins read-only', () => {
  const config: Config = {
    ...DEFAULTS,
    watch: { ...DEFAULTS.watch, provider: 'opencode', model: 'sonnet', modelProvider: 'up' },
    judge: { ...DEFAULTS.judge, enabled: true },
  };
  const { spec, warnings } = resolveJudge(config);
  assert.equal(spec.providerName, 'opencode');
  assert.equal(spec.autoApprove, false);
  assert.equal(spec.readOnly, true);
  assert.equal(spec.model, 'up/sonnet');
  assert.deepEqual(warnings, []);

  const own = resolveJudge({ ...config, judge: { ...config.judge, provider: 'fake', model: 'own-model', modelProvider: 'ignored' } });
  assert.equal(own.spec.providerName, 'fake');
  assert.equal(own.spec.model, 'own-model');
  assert.ok(own.warnings.some((w) => /modelProvider is only used by opencode/.test(w)));
});

test('collectChanges caps the diff by bytes without splitting code points', () => {
  const { dir } = project('# R\n');
  const tracked = join(dir, 'u.txt');
  writeFileSync(tracked, 'x\n');
  execFileSync('git', ['-C', dir, 'add', 'u.txt']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  writeFileSync(tracked, `x\n${'é'.repeat(5000)}\n`);
  const changes = collectChanges(dir, 500);
  assert.equal(changes.truncated, true);
  assert.ok(Buffer.byteLength(changes.diff, 'utf8') <= 500, `diff is ${Buffer.byteLength(changes.diff, 'utf8')} bytes`);
});

test('collectChanges keeps whole files and marks the rest omitted rather than cutting a hunk', () => {
  const { dir } = project('# R\n');
  for (const name of ['a.txt', 'b.txt']) {
    writeFileSync(join(dir, name), 'x\n');
    execFileSync('git', ['-C', dir, 'add', name]);
  }
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  writeFileSync(join(dir, 'a.txt'), 'x\ny\n');
  writeFileSync(join(dir, 'b.txt'), `x\n${'y'.repeat(4000)}\n`);
  const changes = collectChanges(dir, 800);
  assert.equal(changes.truncated, true);
  assert.ok(Buffer.byteLength(changes.diff, 'utf8') <= 800, `diff is ${Buffer.byteLength(changes.diff, 'utf8')} bytes`);
  assert.match(changes.diff, /omitted \(diff exceeded judge\.maxDiffBytes\)/);
  assert.match(changes.diff, /a\.txt/);
});