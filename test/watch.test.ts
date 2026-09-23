import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import type { RunContext } from '../src/runner.js';
import { newTaskState, type State } from '../src/state.js';
import type { Task } from '../src/tasks.js';
import { buildWatchPrompt, pipelineSnapshot, startPipelineWatch, watchLogPath } from '../src/watch.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };

const task = (id: string, num: number): Task => ({ id, num, title: `Task ${num}`, phase: 'Phase 1', order: num - 1, meta: {} });

function makeCtx(root: string, tasks: Task[], state: State): RunContext {
  const paths = resolvePaths(root);
  return {
    paths, config: DEFAULTS, cli: {}, flags: { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false },
    log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks, state, interrupted: false, abort: new AbortController(),
  };
}

test('buildWatchPrompt and pipelineSnapshot describe the pipeline from live state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-watch-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.docs, { recursive: true });
  writeFileSync(paths.progress, '# Progress notes\n\n## T01 — first\n\n- landed the thing\n');
  const tasks = [task('T01', 1), task('T02', 2)];
  const state: State = {
    version: 1,
    tasks: {
      T01: { ...newTaskState('one'), status: 'done', attempts: 1, durationS: 60, summary: 'landed the thing', finished: new Date().toISOString() },
      T02: { ...newTaskState('two'), status: 'running', attempts: 1, durationS: 10, started: new Date().toISOString() },
    },
  };
  const ctx = makeCtx(dir, tasks, state);
  const snap = pipelineSnapshot(ctx);
  assert.match(snap, /1\/2 done/);
  assert.match(snap, /running T02/);
  const prompt = buildWatchPrompt(ctx);
  assert.match(prompt, /PIPELINE SNAPSHOT/);
  assert.match(prompt, /T01 \[done\]/);
  assert.match(prompt, /T02 \[running\]/);
  assert.match(prompt, /RECENT TASK OUTCOMES/);
  assert.match(prompt, /landed the thing/);
  assert.match(prompt, /Do NOT call tools/);
  // Recent progress leads: the current ticket and its phase are called out, and the snapshot sections
  // put recent activity ahead of the overall pipeline counts.
  assert.match(prompt, /CURRENT TASK/);
  assert.match(prompt, /T02 .*running/);
  assert.match(prompt, /CURRENT PHASE \/ GATE/);
  assert.match(prompt, /▶ Phase 1: 1\/2 done/);
  assert.ok(prompt.indexOf('CURRENT TASK') < prompt.indexOf('CURRENT PHASE / GATE'), 'current ticket precedes its phase');
  assert.ok(prompt.indexOf('CURRENT PHASE / GATE') < prompt.indexOf('RECENT TASK OUTCOMES'), 'phase precedes recent outcomes');
  assert.ok(prompt.indexOf('RECENT TASK OUTCOMES') < prompt.indexOf('PIPELINE SNAPSHOT'), 'recent outcomes precede the overall snapshot');
  // The instructions ask for an ordered 3-5 sentence read: current task, phase/gate, then only-if-relevant
  // concerns and early signals.
  assert.match(prompt, /3 to 5 short sentences/);
  assert.match(prompt, /what it has accomplished so far and what is left/);
  assert.match(prompt, /phase \/ milestone \/ gate/);
  assert.match(prompt, /If you have no concerns, say nothing/);
  assert.match(prompt, /If it is too early to tell, say nothing/);
});

test('startPipelineWatch waits one interval, then a fake check updates the panel and the watch log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-watch-run-'));
  const paths = resolvePaths(dir);
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'watch.jsonl'), `${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'w1',
    result: 'On track: T01 landed cleanly and T02 is running normally.',
  })}\n`);
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;

  const tasks = [task('T01', 1), task('T02', 2)];
  const state: State = { version: 1, tasks: { T01: { ...newTaskState('one'), status: 'done', attempts: 1, durationS: 60, summary: 'ok' }, T02: { ...newTaskState('two'), status: 'running', attempts: 1, durationS: 5, started: new Date().toISOString() } } };
  const ctx = makeCtx(dir, tasks, state);
  ctx.config = { ...DEFAULTS, watch: { ...DEFAULTS.watch, provider: 'fake', model: '' } };

  try {
    const watcher = startPipelineWatch(ctx);
    assert.ok(watcher, 'watcher starts with a usable provider');
    assert.equal(ctx.watch?.status, 'waiting', 'the panel says it is waiting before the first check');
    assert.ok((ctx.watch?.nextAt ?? 0) > Date.now(), 'the first check is scheduled one interval out');
    assert.ok(ctx.watchRefresh, 'the TUI refresh hook is bound');

    await watcher!.checkNow();
    assert.equal(ctx.watch?.status, 'ready');
    assert.match(ctx.watch?.summary ?? '', /On track/);
    assert.equal(ctx.watch?.checks, 1);
    assert.ok(ctx.watch?.updatedAt);

    const log = readFileSync(watchLogPath(paths), 'utf8');
    assert.match(log, /# Pipeline watch log/);
    assert.match(log, /check #1/);
    assert.match(log, /On track/);
    assert.match(log, /result: ready/);
    watcher!.stop();
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('startPipelineWatch is a no-op when disabled, and fails soft when the binary is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-watch-off-'));
  const ctx = makeCtx(dir, [task('T01', 1)], { version: 1, tasks: {} });
  ctx.config = { ...DEFAULTS, watch: { ...DEFAULTS.watch, enabled: false } };
  assert.equal(startPipelineWatch(ctx), undefined);
  assert.equal(ctx.watch, undefined);

  const missing = makeCtx(dir, [task('T01', 1)], { version: 1, tasks: {} });
  missing.config = { ...DEFAULTS, watch: { ...DEFAULTS.watch, provider: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash' } };
  // A provider whose binary is certainly not on PATH must disable the watcher, not throw.
  const prevPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const watcher = startPipelineWatch(missing);
    // opencode may genuinely be installed for the developer running the suite; only assert the soft path.
    if (watcher) watcher.stop();
    else {
      assert.equal(missing.watch?.status, 'error');
      assert.match(missing.watch?.error ?? '', /not found/);
    }
  } finally {
    if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
  }
});