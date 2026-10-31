import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateResultsPath, readGateResults } from '../src/acceptance.js';
import { approveCommand } from '../src/commands.js';
import { DEFAULTS } from '../src/config.js';
import { headSha } from '../src/git.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import { runCommand, runTask, type RunContext, type RunFlags } from '../src/runner.js';
import { loadState, newTaskState, type State } from '../src/state.js';
import { appendSteering, pendingSteering } from '../src/steering.js';
import type { Task } from '../src/tasks.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };
const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false };
const fence = '```';

const claudeResult = (status: string, summary: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: `SYMPHONY_RESULT\nstatus: ${status}\nsummary: ${summary}\nEND_SYMPHONY_RESULT` });

function v2Block(verifyCommand: string): string {
  return [
    `${fence}symphony-acceptance`,
    JSON.stringify({
      version: 2,
      criteria: [
        {
          id: 'tests',
          text: 'Tests pass',
          blocking: true,
          gates: [{ kind: 'verify', command: verifyCommand }],
        },
        {
          id: 'feature',
          text: 'Feature implemented',
          blocking: true,
          gates: [{ kind: 'diff', paths: ['part1.txt'] }],
        },
      ],
    }, null, 2),
    fence,
  ].join('\n');
}

function humanBlock(): string {
  return [
    `${fence}symphony-acceptance`,
    JSON.stringify({
      version: 2,
      criteria: [
        { id: 'feature', text: 'Feature implemented', blocking: true, gates: [{ kind: 'diff', paths: ['part1.txt'] }] },
        { id: 'review', text: 'Human review', blocking: true, gates: [{ kind: 'human', approver: 'dan' }] },
      ],
    }, null, 2),
    fence,
  ].join('\n');
}

function project(acceptance: string | undefined): { dir: string; paths: ReturnType<typeof resolvePaths>; task: Task } {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-acc-run-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(paths.adrDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — Do the thing → [tasks/01-thing.md](tasks/01-thing.md)\n');
  const taskFile = join(paths.tasksDir, '01-thing.md');
  writeFileSync(taskFile, [
    '# T01 — Do the thing',
    '',
    '## Goal',
    'x',
    '',
    '## Scope',
    '- a',
    '',
    '## Done when',
    '- [ ] tests pass',
    '',
    acceptance ?? '',
    '',
    '## Hand-off',
    '_(tbd)_',
    '',
  ].join('\n'));
  writeFileSync(paths.progress, '# Progress notes\n');

  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_write', path: 'part1.txt', content: 'the feature' }),
    claudeResult('done', 'the task is done'),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;

  const task: Task = {
    id: 'T01',
    num: 1,
    title: 'Do the thing',
    phase: 'Phase 1',
    order: 0,
    taskFile,
    taskFileRel: 'docs/tasks/01-thing.md',
    meta: { provider: 'fake' },
  };
  return { dir, paths, task };
}

function ctxFor(paths: ReturnType<typeof resolvePaths>, task: Task): { ctx: RunContext; state: State } {
  const state = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxContinuations: 2, watch: { ...DEFAULTS.watch, enabled: false } };
  return {
    state,
    ctx: { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() },
  };
}

test('a v2 task is accepted only when its verify and diff gates pass at one revision', async () => {
  const { paths, task } = project(v2Block('git --version'));
  const { ctx, state } = ctxFor(paths, task);
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.acceptance?.status, 'accepted');
    assert.equal(state.tasks.T01.verify?.ok, true);
    const results = readGateResults(paths, 'T01');
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === 'pass'));
    assert.equal(new Set(results.map((r) => r.revision.tree)).size, 1, 'all gates use one revision');
    assert.ok(gateResultsPath(paths, 'T01').includes('evidence'));
    assert.ok(results.find((r) => r.gate === 'verify')?.evidence[0]?.path);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a failing v2 verify gate fails the task instead of accepting it', async () => {
  const { paths, task } = project(v2Block('git --definitely-not-a-real-option'));
  const { ctx, state } = ctxFor(paths, task);
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'failed');
    assert.equal(state.tasks.T01.acceptance?.status, 'failed');
    const results = readGateResults(paths, 'T01');
    const verify = results.find((r) => r.gate === 'verify');
    assert.equal(verify?.status, 'fail');
    assert.equal(state.tasks.T01.verify?.ok, false);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a legacy task keeps the old verify path and has no v2 acceptance record', async () => {
  const { paths, task } = project(undefined);
  const { ctx, state } = ctxFor(paths, task);
  ctx.config = { ...ctx.config, verifyCommand: 'git --version' };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.acceptance, undefined);
    assert.equal(state.tasks.T01.verify?.ok, true);
    assert.equal(readGateResults(paths, 'T01').length, 0);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('ref checkpoint mode isolates a failed task and keeps the next task clean', async () => {
  const { dir, paths, task } = project(v2Block('git --version'));
  writeFileSync(paths.roadmap, [
    '# R',
    '',
    '## Phase 1',
    '',
    '- [ ] T01 — Do the thing → [tasks/01-thing.md](tasks/01-thing.md)',
    '- [ ] T02 — Other work',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'fixtures', 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_write', path: 'impl.txt', content: 'unverified implementation' }),
    claudeResult('failed', 'workhorse gave up'),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'fixtures', 'T02.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    JSON.stringify({ type: 'fake_write', path: 'other.txt', content: 'independent work' }),
    claudeResult('done', 'other task done'),
  ].join('\n') + '\n');
  const task2: Task = { id: 'T02', num: 2, title: 'Other work', phase: 'Phase 1', order: 1, meta: { provider: 'fake' } };
  const { ctx, state } = ctxFor(paths, task);
  ctx.tasks = [task, task2];
  ctx.config = { ...ctx.config, git: { ...ctx.config.git, checkpointMode: 'ref' } };
  try {
    const out1 = await runTask(ctx, task);
    assert.equal(out1.status, 'failed');
    assert.ok(state.tasks.T01.checkpointRef, 'unverified work is in a checkpoint ref');
    assert.ok(!existsSync(join(dir, 'impl.txt')), 'the failed implementation was removed from the worktree');
    assert.equal(headSha(dir), undefined, 'a failed task does not commit to the branch');
    assert.match(state.tasks.T01.commit ?? '', /checkpoint/);

    const out2 = await runTask(ctx, task2);
    assert.equal(out2.status, 'done');
    const committed = execFileSync('git', ['-C', dir, 'show', '--name-only', '--pretty=format:', 'HEAD'], { encoding: 'utf8' })
      .split('\n').map((f) => f.trim()).filter(Boolean);
    assert.ok(committed.includes('other.txt'), committed.join('\n'));
    assert.ok(!committed.includes('impl.txt'), 'the next task did not inherit the failed implementation');
    assert.ok(existsSync(join(dir, 'other.txt')));
    assert.ok(!existsSync(join(dir, 'impl.txt')));
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a verification crash resumes acceptance without reimplementing the task', async () => {
  const { paths, task } = project(v2Block('git --version'));
  writeFileSync(join(paths.root, 'part1.txt'), 'already implemented');
  const { ctx, state } = ctxFor(paths, task);
  state.tasks.T01 = {
    ...newTaskState(task.title),
    status: 'running',
    phase: 'verifying',
    attempts: 1,
    pid: 999999,
  };
  try {
    const code = await runCommand(ctx);
    assert.equal(code, 0);
    assert.equal(state.tasks.T01.acceptance?.status, 'accepted');
    assert.equal(state.tasks.T01.logs.length, 0, 'no new implementation session ran');
    assert.equal(state.tasks.T01.phase, undefined);
    assert.ok(existsSync(join(paths.root, 'part1.txt')));
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a failed verify runs a focused repair session and re-verifies', async () => {
  const { dir, paths, task } = project(v2Block('node verify.js'));
  writeFileSync(join(dir, 'verify.js'), "const fs = require('node:fs'); process.exit(fs.existsSync('fixed.txt') ? 0 : 1);\n");
  writeFileSync(join(dir, 'fixtures', 'T01.repair.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-repair' }),
    JSON.stringify({ type: 'fake_write', path: 'fixed.txt', content: 'repaired' }),
    claudeResult('done', 'the failing check was repaired'),
  ].join('\n') + '\n');
  const { ctx, state } = ctxFor(paths, task);
  ctx.config = { ...ctx.config, verifyRepair: true, verifyRepairAttempts: 1, verifyRetries: 0 };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.acceptance?.status, 'accepted');
    assert.ok(existsSync(join(dir, 'fixed.txt')), 'the repair session wrote the fix');
    assert.ok(state.tasks.T01.logs.some((l) => l.kind === 'repair'), 'the repair session is recorded');
    assert.equal(state.tasks.T01.repairAttempts, undefined);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a human gate parks the task; approving re-validates without a new implementation session', async () => {
  const { paths, task } = project(humanBlock());
  const { ctx, state } = ctxFor(paths, task);
  try {
    const first = await runTask(ctx, task);
    assert.equal(first.status, 'blocked');
    assert.equal(state.tasks.T01.acceptance?.status, 'pending_human');
    assert.equal(state.tasks.T01.phase, 'needs_attention');
    assert.ok(existsSync(join(paths.root, 'part1.txt')), 'the implementation is kept for review');
    const sessions = state.tasks.T01.logs.length;
    assert.equal(sessions, 1);

    approveCommand(paths, state, [task], 'T01', 'review', { approver: 'dan', note: 'looks good', log: silent });

    const second = await runTask(ctx, task);
    assert.equal(second.status, 'done');
    assert.equal(state.tasks.T01.acceptance?.status, 'accepted');
    assert.equal(state.tasks.T01.phase, undefined);
    assert.equal(state.tasks.T01.logs.length, sessions, 'no new implementation session ran');
    assert.ok(readGateResults(paths, 'T01').some((r) => r.gate === 'human' && r.status === 'pass'));
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('inconclusive acceptance evidence parks the task instead of reimplementing or accepting', async () => {
  const block = [
    `${fence}symphony-acceptance`,
    JSON.stringify({
      version: 2,
      criteria: [{ id: 'perf', text: 'Perf', blocking: true, gates: [{ kind: 'metric', command: 'node -e "console.log(\'no number\')"', target: 1 }] }],
    }, null, 2),
    fence,
  ].join('\n');
  const { paths, task } = project(block);
  const { ctx, state } = ctxFor(paths, task);
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'blocked');
    assert.equal(state.tasks.T01.acceptance?.status, 'inconclusive');
    assert.equal(state.tasks.T01.phase, 'needs_attention');
    assert.equal(state.tasks.T01.logs.length, 1);
    assert.ok(existsSync(join(paths.root, 'part1.txt')));
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('operator steering is delivered to the next session prompt and consumed', async () => {
  const { paths, task } = project(v2Block('git --version'));
  const { ctx, state } = ctxFor(paths, task);
  appendSteering(paths, 'T01', 'keep the public API stable', 'dan');
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    const promptRef = state.tasks.T01.logs.find((l) => l.kind === 'task');
    assert.ok(promptRef);
    const prompt = readFileSync(join(paths.root, promptRef.prompt), 'utf8');
    assert.match(prompt, /Operator steering/);
    assert.match(prompt, /dan: keep the public API stable/);
    assert.equal(pendingSteering(paths, 'T01').length, 0, 'the note was consumed');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});
