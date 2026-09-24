import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { currentBranch } from '../src/git.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import { haltBanner, runCommand, runTask, type RunContext, type RunFlags } from '../src/runner.js';
import { loadState, newTaskState, type State } from '../src/state.js';
import type { Task } from '../src/tasks.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };
const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false };

const claudeResult = (status: string, summary: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: `SYMPHONY_RESULT\nstatus: ${status}\nsummary: ${summary}\nEND_SYMPHONY_RESULT` });

function project(): { dir: string; paths: ReturnType<typeof resolvePaths>; task: Task } {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-run-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(paths.adrDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — Do the thing → [tasks/01-thing.md](tasks/01-thing.md)\n');
  writeFileSync(join(paths.tasksDir, '01-thing.md'), '# T01 — Do the thing\n\n## Goal\nx\n\n## Scope\n- a\n\n## Done when\n- tests pass\n\n## Hand-off\n_(tbd)_\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_write', path: 'part1.txt', content: 'part 1' }),
    claudeResult('continue', 'first half done'),
  ].join('\n') + '\n');
  writeFileSync(join(fixtures, 'T01.continue.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    JSON.stringify({ type: 'fake_write', path: 'part2.txt', content: 'part 2' }),
    claudeResult('done', 'all done'),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;
  const task: Task = { id: 'T01', num: 1, title: 'Do the thing', phase: 'Phase 1', order: 0, meta: { provider: 'fake' } };
  return { dir, paths, task };
}

test('a task that reports continue is re-run in a fresh session until done, committing each slice', async () => {
  const { dir, paths, task } = project();
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxContinuations: 3 };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.status, 'done');
    assert.equal(state.tasks.T01.attempts, 2);
    assert.ok(readFileSync(join(dir, 'part1.txt'), 'utf8').includes('part 1'));
    assert.ok(readFileSync(join(dir, 'part2.txt'), 'utf8').includes('part 2'));
    assert.match(readFileSync(paths.roadmap, 'utf8'), /\[x\] T01/);
    // Per-task run log captures each session's reported status + summary.
    const taskLog = readFileSync(join(paths.logsDir, 'T01.md'), 'utf8');
    assert.match(taskLog, /# T01 — Do the thing/);
    assert.match(taskLog, /Status: done/);
    assert.match(taskLog, /summary: first half done/);
    assert.match(taskLog, /summary: all done/);
    // ROADMAP.md carries the pipeline status block at the end.
    const roadmapText = readFileSync(paths.roadmap, 'utf8');
    assert.match(roadmapText, /<!-- symphony:status -->/);
    assert.match(roadmapText, /1\/1 done/);
    assert.match(roadmapText, /- Completed: T01/);
    assert.match(roadmapText, /- Remaining: none/);
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(log, /T01: Do the thing \[continue\]/);
    assert.match(log, /T01: Do the thing \[done\]/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a task ending triggers a pipeline-watch refresh (in addition to the interval)', async () => {
  const { paths, task } = project();
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxContinuations: 3 };
  let refreshes = 0;
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController(), watchRefresh: () => { refreshes += 1; } };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(refreshes, 1, 'one watch refresh fires when the ticket ends');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('continuation is bounded by maxContinuations and ends failed', async () => {
  const { dir, paths, task } = project();
  // Both the first and every continuation session report continue, so the bound is reached.
  writeFileSync(join(dir, 'fixtures', 'T01.continue.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    claudeResult('continue', 'still not finished'),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxContinuations: 1, nudge: false };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'failed');
    assert.equal(state.tasks.T01.status, 'failed');
    assert.match(state.tasks.T01.summary ?? '', /continuation/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('maxIterationsPerTask stops a task that keeps continuing, with a clear summary', async () => {
  const { dir, paths, task } = project();
  writeFileSync(join(dir, 'fixtures', 'T01.continue.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    claudeResult('continue', 'still not finished'),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxContinuations: 9, maxIterationsPerTask: 2, nudge: false };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'failed');
    assert.equal(state.tasks.T01.attempts, 2);
    assert.match(state.tasks.T01.summary ?? '', /maxIterationsPerTask/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('STOP pauses at a continuation boundary and the next run resumes the next slice', async () => {
  const { dir, paths, task } = project();
  // The first (task) session lands slice one and drops the .stop sentinel before reporting continue.
  writeFileSync(join(dir, 'fixtures', 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_write', path: 'part1.txt', content: 'part 1' }),
    JSON.stringify({ type: 'fake_write', path: '.stop', content: '' }),
    claudeResult('continue', 'first half done'),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxContinuations: 3 };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    // First invocation: the task session reports continue, the slice commits, then STOP pauses it.
    const first = await runTask(ctx, task);
    assert.equal(first.stopped, true);
    assert.equal(state.tasks.T01.status, 'running');
    assert.equal(state.tasks.T01.continuation, 1);
    assert.match(state.tasks.T01.summary ?? '', /paused at continuation 1\/3/);
    assert.ok(readFileSync(join(dir, 'part1.txt'), 'utf8').includes('part 1'));
    assert.ok(!existsSync(join(dir, 'part2.txt'))); // the next slice did not run
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(log, /T01: Do the thing \[continue\]/); // the finished slice is committed

    // After the sentinel is removed, re-running resumes as continuation 1 (the T01.continue fixture).
    rmSync(paths.stop, { force: true });
    const second = await runTask(ctx, task);
    assert.equal(second.status, 'done');
    assert.equal(state.tasks.T01.status, 'done');
    assert.equal(state.tasks.T01.attempts, 2);
    assert.equal(state.tasks.T01.continuation, undefined); // cleared on the terminal result
    assert.ok(readFileSync(join(dir, 'part2.txt'), 'utf8').includes('part 2'));
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a queued pauseAt stops the run before the chosen task, placing the sentinel there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-run-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — One\n- [ ] T02 — Two\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_write', path: 'one.txt', content: 'one' }),
    claudeResult('done', 'one done'),
  ].join('\n') + '\n');
  writeFileSync(join(fixtures, 'T02.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    JSON.stringify({ type: 'fake_write', path: 'two.txt', content: 'two' }),
    claudeResult('done', 'two done'),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;
  const tasks: Task[] = [
    { id: 'T01', num: 1, title: 'One', phase: 'Phase 1', order: 0, meta: { provider: 'fake' } },
    { id: 'T02', num: 2, title: 'Two', phase: 'Phase 1', order: 1, meta: { provider: 'fake' } },
  ];
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks, state, interrupted: false, abort: new AbortController(), pauseAt: 'T02' };
  try {
    const code = await runCommand(ctx);
    assert.equal(code, 0, 'the run pauses cleanly');
    assert.equal(state.tasks.T01.status, 'done', 'the task before the target ran');
    assert.equal(state.tasks.T02, undefined, 'the target task never started');
    assert.ok(existsSync(paths.stop), 'the sentinel is placed when the pipeline reaches the target');
    assert.equal(ctx.pauseAt, undefined, 'the target is cleared once it fires');

    // Removing the sentinel and re-running starts at the target task.
    rmSync(paths.stop, { force: true });
    const second = await runCommand(ctx);
    assert.equal(second, 0);
    assert.equal(state.tasks.T02.status, 'done');
    assert.ok(readFileSync(join(dir, 'two.txt'), 'utf8').includes('two'));
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('run retries a task left "running" by a crash (stale pid) instead of losing it', async () => {
  const { dir, paths, task } = project();
  writeFileSync(join(dir, 'fixtures', 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    claudeResult('done', 'recovered'),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  // Simulate a harness crash mid-session: the row is running with a pid that is no longer alive.
  state.tasks.T01 = { ...newTaskState('Do the thing'), status: 'running', attempts: 1, started: new Date().toISOString(), pid: 2147483647, logs: [] };
  const config = { ...DEFAULTS, provider: 'fake' as const };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    const code = await runCommand(ctx);
    assert.equal(code, 0);
    assert.equal(state.tasks.T01.status, 'done');
    assert.equal(state.tasks.T01.pid, undefined); // the stale pid is gone
    assert.equal(state.tasks.T01.attempts, 2);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a done result is demoted to failed when the harness verify command fails', async () => {
  const { dir, paths, task } = project();
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, verifyCommand: `node -e "process.exit(1)"` };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'failed');
    assert.equal(state.tasks.T01.verify?.ok, false);
    assert.match(state.tasks.T01.summary ?? '', /verify failed/);
    assert.match(readFileSync(paths.roadmap, 'utf8'), /\[~\] T01/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a done result stands when the verify command passes', async () => {
  const { dir, paths, task } = project();
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, verifyCommand: `node -e "process.exit(0)"` };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.verify?.ok, true);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('run caps at maxTasksPerRun and fires afterTask hooks per finished task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-run2-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — One\n- [ ] T02 — Two\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  for (const id of ['T01', 'T02']) {
    writeFileSync(join(fixtures, `${id}.task.jsonl`), [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: `s-${id}` }),
      claudeResult('done', `${id} done`),
    ].join('\n') + '\n');
  }
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;
  const tasks: Task[] = [
    { id: 'T01', num: 1, title: 'One', phase: 'Phase 1', order: 0, meta: { provider: 'fake' } },
    { id: 'T02', num: 2, title: 'Two', phase: 'Phase 1', order: 1, meta: { provider: 'fake' } },
  ];
  const state: State = loadState(paths);
  const config = {
    ...DEFAULTS,
    provider: 'fake' as const,
    maxTasksPerRun: 1,
    hooks: { afterTask: `node -e "require('fs').writeFileSync('hook-'+process.env.SYMPHONY_TASK+'.txt','x')"` },
  };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks, state, interrupted: false, abort: new AbortController() };
  try {
    const code = await runCommand(ctx);
    assert.equal(code, 0);
    assert.equal(state.tasks.T01.status, 'done');
    assert.equal(state.tasks.T02, undefined);
    assert.ok(existsSync(join(dir, 'hook-T01.txt')));
    assert.ok(!existsSync(join(dir, 'hook-T02.txt')));
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a done task whose commit keeps failing is retried and then demoted to failed', async () => {
  const { dir, paths, task } = project();
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController(), startBranch: currentBranch(dir) };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'failed');
    assert.equal(state.tasks.T01.status, 'failed');
    assert.match(state.tasks.T01.summary ?? '', /commit failed/);
    assert.match(readFileSync(paths.roadmap, 'utf8'), /\[~\] T01/);
    assert.equal(state.tasks.T01.commitSha, undefined);
    // No commit exists: git add staged the files, but the failing hook aborted every commit.
    assert.throws(() => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { stdio: 'ignore' }));
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a session that switches branches fails the task instead of committing elsewhere', async () => {
  const { dir, paths, task } = project();
  writeFileSync(join(dir, 'fixtures', 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_run', command: 'git checkout -q -b sidebranch' }),
    JSON.stringify({ type: 'fake_write', path: 'x.txt', content: 'x' }),
    claudeResult('done', 'did it'),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController(), startBranch: currentBranch(dir) };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'failed');
    assert.match(state.tasks.T01.summary ?? '', /branch changed/);
    assert.equal(currentBranch(dir), 'sidebranch');
    assert.equal(execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).trim(), '');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('run halts when reported session cost crosses maxCostUsdPerRun', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-cost-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — One\n- [ ] T02 — Two\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  const costResult = (id: string) => JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: `s-${id}`, total_cost_usd: 1,
    result: `SYMPHONY_RESULT\nstatus: done\nsummary: ${id} done\nEND_SYMPHONY_RESULT`,
  });
  for (const id of ['T01', 'T02']) {
    writeFileSync(join(fixtures, `${id}.task.jsonl`), [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: `s-${id}` }),
      costResult(id),
    ].join('\n') + '\n');
  }
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;
  const tasks: Task[] = [
    { id: 'T01', num: 1, title: 'One', phase: 'Phase 1', order: 0, meta: { provider: 'fake' } },
    { id: 'T02', num: 2, title: 'Two', phase: 'Phase 1', order: 1, meta: { provider: 'fake' } },
  ];
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxCostUsdPerRun: 1 };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks, state, interrupted: false, abort: new AbortController() };
  try {
    const code = await runCommand(ctx);
    assert.equal(code, 3);
    assert.equal(state.halted?.category, 'budget');
    assert.equal(state.tasks.T01.status, 'done');
    assert.equal(state.tasks.T02, undefined);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('--dry-run previews the plan while halted without clearing the halt or running', async () => {
  const { paths, task } = project();
  const state: State = loadState(paths);
  state.halted = { at: new Date().toISOString(), category: 'auth', reason: 'nope' };
  const config = { ...DEFAULTS, provider: 'fake' as const };
  const ctx: RunContext = { paths, config, cli: {}, flags: { ...flags, dryRun: true }, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    const code = await runCommand(ctx);
    assert.equal(code, 0);
    assert.ok(state.halted, 'dry-run must not clear the sticky halt');
    assert.equal(state.tasks.T01, undefined);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a Ctrl-C does not consume the task attempt budget, so it cannot trigger the attempts halt', async () => {
  const { paths, task } = project();
  const state: State = loadState(paths);
  // maxAttemptsPerTask: 1 makes the regression sharp: a single counted interrupt would halt the run.
  const config = { ...DEFAULTS, provider: 'fake' as const, halt: { ...DEFAULTS.halt, maxAttemptsPerTask: 1 } };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: true, signalName: 'SIGINT', abort: new AbortController() };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.interrupted, true);
    assert.equal(state.tasks.T01.status, 'failed');
    assert.equal(state.tasks.T01.lastError?.category, 'interrupted');
    // The attempt the interrupted session consumed is given back.
    assert.equal(state.tasks.T01.attempts, 0);

    // A subsequent run must not re-halt on the attempts gate; it retries and finishes normally.
    ctx.interrupted = false;
    ctx.signalName = undefined;
    const code = await runCommand(ctx);
    assert.equal(code, 0);
    assert.equal(state.halted, undefined);
    assert.equal(state.tasks.T01.status, 'done');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('the halt banner points at --retry for an attempts halt (clear-halt alone would re-halt)', () => {
  const seen: string[] = [];
  const capture: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner(_title, lines) { seen.push(...lines); } };
  const ctx = { log: capture } as RunContext;
  haltBanner(ctx, { at: 'now', taskId: 'T03', category: 'attempts', reason: 'T03 has failed 3 times' });
  const attemptsBanner = seen.join('\n');
  assert.match(attemptsBanner, /--retry --only T03/);
  assert.match(attemptsBanner, /symphony run --clear-halt/);
  seen.length = 0;
  haltBanner(ctx, { at: 'now', category: 'auth', reason: 'bad key' });
  const authBanner = seen.join('\n');
  assert.doesNotMatch(authBanner, /--retry/);
  assert.match(authBanner, /symphony clear-halt/);
});

test('preflight fails when a later task uses a provider whose binary is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-pre-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — One\n- [ ] T02 — Two\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  const tasks: Task[] = [
    { id: 'T01', num: 1, title: 'One', phase: 'Phase 1', order: 0, meta: { provider: 'fake' } },
    { id: 'T02', num: 2, title: 'Two', phase: 'Phase 1', order: 1, meta: { provider: 'gemini' } },
  ];
  const state: State = loadState(paths);
  const config = {
    ...DEFAULTS,
    provider: 'fake' as const,
    providers: { ...DEFAULTS.providers, gemini: { ...DEFAULTS.providers.gemini, bin: 'symphony-no-such-binary-xyz' } },
  };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks, state, interrupted: false, abort: new AbortController() };
  const code = await runCommand(ctx);
  assert.equal(code, 4);
  assert.equal(state.tasks.T01, undefined);
});

test('a task the workhorse fails is escalated to the configured model and can then finish', async () => {
  const { dir, paths, task } = project();
  // The primary model reports failed; the escalated session (a distinct kind) does the work.
  writeFileSync(join(dir, 'fixtures', 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    claudeResult('failed', 'gave up'),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'fixtures', 'T01.escalate.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    JSON.stringify({ type: 'fake_write', path: 'escalated.txt', content: 'done by the strong model' }),
    claudeResult('done', 'finished after escalation'),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  const config = {
    ...DEFAULTS,
    provider: 'fake' as const,
    nudge: false,
    escalation: { ...DEFAULTS.escalation, enabled: true, provider: 'fake' as const, model: 'strong-model', onCategories: ['task'] },
  };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.status, 'done');
    assert.equal(state.tasks.T01.attempts, 2);
    assert.equal(state.tasks.T01.model, 'strong-model');
    assert.ok(readFileSync(join(dir, 'escalated.txt'), 'utf8').includes('strong model'));
    assert.match(readFileSync(paths.roadmap, 'utf8'), /\[x\] T01/);
    // The committed run log records which model ran each session.
    const taskLog = readFileSync(join(paths.logsDir, 'T01.md'), 'utf8');
    assert.match(taskLog, /summary: gave up/);
    assert.match(taskLog, /summary: finished after escalation/);
    assert.match(taskLog, /- model: fake · strong-model/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('escalation is bounded by maxAttempts and still fails when the strong model also fails', async () => {
  const { dir, paths, task } = project();
  writeFileSync(join(dir, 'fixtures', 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    claudeResult('failed', 'weak failed'),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'fixtures', 'T01.escalate.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    claudeResult('failed', 'strong failed too'),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  const config = {
    ...DEFAULTS,
    provider: 'fake' as const,
    nudge: false,
    escalation: { ...DEFAULTS.escalation, enabled: true, provider: 'fake' as const, model: 'strong-model', maxAttempts: 1, onCategories: ['task'] },
  };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'failed');
    assert.equal(state.tasks.T01.status, 'failed');
    assert.equal(state.tasks.T01.attempts, 2); // one workhorse session, one escalation, then stop
    assert.match(state.tasks.T01.summary ?? '', /strong failed too/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('an infrastructure failure is not escalated even when escalation is enabled', async () => {
  const { dir, paths, task } = project();
  // A fatal auth error: classifyFailure halts the run rather than handing it to a stronger model.
  writeFileSync(join(dir, 'fixtures', 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1', result: 'Invalid API key' }),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  const config = {
    ...DEFAULTS,
    provider: 'fake' as const,
    nudge: false,
    escalation: { ...DEFAULTS.escalation, enabled: true, provider: 'fake' as const, model: 'strong-model', onCategories: ['task'] },
  };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'failed');
    assert.equal(out.halt?.category, 'auth');
    assert.equal(state.tasks.T01.attempts, 1); // never escalated
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

/** A fetch double for the Jev System One call. */
function jevFetch(choice: string, confidence: number): typeof fetch {
  return (async () => new Response(JSON.stringify({
    model: 'typesafe/jev-1.13',
    answers: { disposition: { type: 'choice', choice, confidence } },
    usage: { cost: 0.00002 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

/** A session that ended cleanly but never emitted its SYMPHONY_RESULT block. */
function blocklessTaskFixture(dir: string): void {
  writeFileSync(join(dir, 'fixtures', 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'I believe I am finished.' }),
  ].join('\n') + '\n');
}

test('a session without a result block is settled by Jev instead of a nudge session', async () => {
  const { dir, paths, task } = project();
  blocklessTaskFixture(dir);
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, jev: { ...DEFAULTS.jev, enabled: true } };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController(), fetchImpl: jevFetch('done', 0.95) };
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.attempts, 1); // the nudge session never ran
    assert.equal(state.tasks.T01.nudged, undefined);
    assert.match(readFileSync(join(paths.logsDir, 'T01.md'), 'utf8'), /Jev classified the session as done/);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a low-confidence Jev answer falls back to the nudge session', async () => {
  const { dir, paths, task } = project();
  blocklessTaskFixture(dir);
  writeFileSync(join(dir, 'fixtures', 'T01.nudge.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    claudeResult('done', 'reported after nudge'),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, jev: { ...DEFAULTS.jev, enabled: true } };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController(), fetchImpl: jevFetch('done', 0.3) };
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.nudged, true); // the nudge ran (within the same attempt)
    assert.match(readFileSync(join(paths.logsDir, 'T01.md'), 'utf8'), /summary: reported after nudge/);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('Jev may not end a task as failed by default; the nudge runs instead', async () => {
  const { dir, paths, task } = project();
  blocklessTaskFixture(dir);
  writeFileSync(join(dir, 'fixtures', 'T01.nudge.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    claudeResult('done', 'actually finished'),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, jev: { ...DEFAULTS.jev, enabled: true } };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController(), fetchImpl: jevFetch('failed', 0.99) };
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done'); // the nudge settled it, not Jev's "failed"
    assert.equal(state.tasks.T01.nudged, true);
    assert.match(state.tasks.T01.summary ?? '', /actually finished/);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

/** A fetch double for the Jev error-classification call. */
function jevErrorFetch(category: string, confidence: number): typeof fetch {
  return (async () => new Response(JSON.stringify({
    model: 'typesafe/jev-1.13',
    answers: { category: { type: 'choice', choice: category, confidence } },
    usage: { cost: 0.00001 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

/** A session that failed with error text no classifyFailure rule matches. */
function unclassifiedFailureFixture(dir: string): void {
  writeFileSync(join(dir, 'fixtures', 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1', result: 'The widget subsystem returned an odd state.' }),
  ].join('\n') + '\n');
}

test('an unclassified failure is retried when Jev reads it as transient', async () => {
  const { dir, paths, task } = project();
  unclassifiedFailureFixture(dir);
  writeFileSync(join(dir, 'fixtures', 'T01.resume.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    claudeResult('done', 'recovered on retry'),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, retry: { maxAttempts: 2, backoffSec: [0] }, jev: { ...DEFAULTS.jev, enabled: true } };
  const warnings: string[] = [];
  const log: Logger = { info() {}, warn: (m) => warnings.push(m), error() {}, plain() {}, banner() {} };
  const ctx: RunContext = { paths, config, cli: {}, flags, log, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController(), fetchImpl: jevErrorFetch('server', 0.9) };
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.attempts, 2); // the unknown failure became a retry
    assert.ok(warnings.some((l) => /Jev reads it as server/.test(l)), warnings.join('\n'));
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('the same unclassified failure stays terminal when Jev is off', async () => {
  const { dir, paths, task } = project();
  unclassifiedFailureFixture(dir);
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, retry: { maxAttempts: 2, backoffSec: [0] } };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController(), fetchImpl: jevErrorFetch('server', 0.9) };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'failed');
    assert.equal(state.tasks.T01.attempts, 1); // no tie-breaker, no retry
    assert.equal(state.tasks.T01.lastError?.category, 'unknown');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

/** A fetch double for the Jev escalation-decision call. */
function jevEscalationFetch(choice: string, confidence: number): typeof fetch {
  return (async () => new Response(JSON.stringify({
    model: 'typesafe/jev-1.13',
    answers: { decision: { type: 'choice', choice, confidence } },
    usage: { cost: 0.00001 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

/** A fetch double that fails the test if Jev is called at all. */
const throwingFetch = (async () => { throw new Error('Jev must not be called for this workflow'); }) as unknown as typeof fetch;

/** Escalation enabled on the `task` category, with the escalation session's fixture written. */
function escalationProject(): { dir: string; paths: ReturnType<typeof resolvePaths>; task: Task; config: typeof DEFAULTS } {
  const { dir, paths, task } = project();
  writeFileSync(join(dir, 'fixtures', 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    claudeResult('failed', 'workhorse gave up'),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'fixtures', 'T01.escalate.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    claudeResult('done', 'strong model finished'),
  ].join('\n') + '\n');
  const config = {
    ...DEFAULTS,
    provider: 'fake' as const,
    nudge: false,
    escalation: { ...DEFAULTS.escalation, enabled: true, provider: 'fake' as const, model: 'strong-model', onCategories: ['task'] },
  };
  return { dir, paths, task, config };
}

test('Jev can decline an escalation the category list would otherwise allow', async () => {
  const { paths, task, config } = escalationProject();
  const state: State = loadState(paths);
  const ctx: RunContext = { paths, config: { ...config, jev: { ...DEFAULTS.jev, enabled: true } }, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController(), fetchImpl: jevEscalationFetch('stay', 0.9) };
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'failed');
    assert.equal(state.tasks.T01.attempts, 1); // the escalation session was skipped
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('Jev can approve an escalation, which then runs on the escalation model', async () => {
  const { paths, task, config } = escalationProject();
  const state: State = loadState(paths);
  const ctx: RunContext = { paths, config: { ...config, jev: { ...DEFAULTS.jev, enabled: true } }, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController(), fetchImpl: jevEscalationFetch('escalate', 0.9) };
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.attempts, 2);
    assert.equal(state.tasks.T01.model, 'strong-model');
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('with escalationDecision off, escalation stays deterministic and Jev is not consulted', async () => {
  const { paths, task, config } = escalationProject();
  const state: State = loadState(paths);
  const ctx: RunContext = { paths, config: { ...config, jev: { ...DEFAULTS.jev, enabled: true, escalationDecision: false } }, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController(), fetchImpl: throwingFetch };
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done'); // escalated without asking Jev
    assert.equal(state.tasks.T01.attempts, 2);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('with resultFallback off, a block-less session still nudges and Jev is not consulted', async () => {
  const { dir, paths, task } = project();
  blocklessTaskFixture(dir);
  writeFileSync(join(dir, 'fixtures', 'T01.nudge.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    claudeResult('done', 'reported after nudge'),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, jev: { ...DEFAULTS.jev, enabled: true, resultFallback: false } };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController(), fetchImpl: throwingFetch };
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.nudged, true); // the nudge ran
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('run halts when Jev is enabled but its API key is missing', async () => {
  const { paths, task } = project();
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, jev: { ...DEFAULTS.jev, enabled: true } };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const code = await runCommand(ctx);
    assert.equal(code, 3);
    assert.equal(state.halted?.category, 'config');
    assert.match(state.halted?.reason ?? '', /Jev is enabled but/);
    assert.equal(state.tasks.T01, undefined); // no session ran
  } finally {
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('--dry-run previews while Jev is misconfigured without leaving a halt', async () => {
  const { paths, task } = project();
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, jev: { ...DEFAULTS.jev, enabled: true } };
  const ctx: RunContext = { paths, config, cli: {}, flags: { ...flags, dryRun: true }, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const code = await runCommand(ctx);
    assert.equal(code, 0);
    assert.equal(state.halted, undefined);
    assert.equal(state.tasks.T01, undefined);
  } finally {
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});
