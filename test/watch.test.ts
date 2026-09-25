import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import type { RunContext } from '../src/runner.js';
import { newTaskState, type State } from '../src/state.js';
import type { Task } from '../src/tasks.js';
import { buildWatchPrompt, cleanWatchSummary, pipelineSnapshot, progressSectionCount, startPipelineWatch, watchLogPath } from '../src/watch.js';

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
  assert.match(prompt, /permitted action is reading the file named under LATEST TASK LOG/);
  // The snapshot still leads with the current ticket and its phase, but frames them as context the
  // operator can already see.
  assert.match(prompt, /CURRENTLY RUNNING/);
  assert.match(prompt, /already visible to the operator/);
  assert.match(prompt, /T02 .*running/);
  assert.match(prompt, /PHASES \/ GATES/);
  assert.match(prompt, /▶ Phase 1: 1\/2 done/);
  assert.ok(prompt.indexOf('CURRENTLY RUNNING') < prompt.indexOf('PHASES / GATES'), 'current ticket precedes its phase');
  assert.ok(prompt.indexOf('PHASES / GATES') < prompt.indexOf('RECENT TASK OUTCOMES'), 'phase precedes recent outcomes');
  assert.ok(prompt.indexOf('RECENT TASK OUTCOMES') < prompt.indexOf('PIPELINE SNAPSHOT'), 'recent outcomes precede the overall snapshot');
  // The instructions ask for interpretation, forbid narrating the visible status, and allow a silent
  // reply only at the very start rather than hedging.
  assert.match(prompt, /interpretation, not narration/);
  assert.match(prompt, /2 to 4 short sentences/);
  assert.match(prompt, /Never narrate raw status or timing/);
  assert.match(prompt, /Never say it is too early to tell/);
  assert.match(prompt, /Reply with exactly NO_UPDATE/);
  assert.match(prompt, /only at the very start of a run/);
  assert.match(prompt, /Once any task has finished, always give/);
  assert.match(prompt, /Begin directly with the observation/);
  assert.match(prompt, /LATEST TASK LOG/);
  assert.match(prompt, /Is the task in flight healthy, or struggling/);
  assert.match(prompt, /do not march through a checklist/);
  assert.doesNotMatch(prompt, /what it has accomplished so far and what is left/);
});

test('buildWatchPrompt references the latest task session log by path instead of inlining it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-watch-log-'));
  const paths = resolvePaths(dir);
  mkdirSync(join(dir, 'runs'), { recursive: true });
  writeFileSync(join(dir, 'runs', 'T02-1.log'), 'older line\n\nlatest line: retrying the failing test\n');
  const tasks = [task('T01', 1), task('T02', 2)];
  const state: State = {
    version: 1,
    tasks: {
      T01: { ...newTaskState('one'), status: 'done', attempts: 1, finished: new Date().toISOString(), summary: 'ok' },
      T02: {
        ...newTaskState('two'), status: 'running', attempts: 2, started: new Date().toISOString(),
        logs: [{ kind: 'task', jsonl: 'runs/T02-1.jsonl', log: 'runs/T02-1.log', prompt: 'runs/T02-1.prompt.md' }],
      },
    },
  };
  const ctx = makeCtx(dir, tasks, state);
  const prompt = buildWatchPrompt(ctx);
  // The prompt carries a path, not the log text, so its size never grows with the session.
  assert.match(prompt, /LATEST TASK LOG \(T02's latest session\)/);
  assert.match(prompt, /Read this file \(relative to the project root\): runs\/T02-1\.log/);
  assert.doesNotMatch(prompt, /latest line: retrying the failing test/);
  // An unavailable log degrades to a placeholder instead of a dangling path.
  const noLog = buildWatchPrompt(makeCtx(dir, [task('T01', 1)], { version: 1, tasks: {} }));
  assert.match(noLog, /\(no session log yet — nothing to read\)/);
});

test('cleanWatchSummary strips conversational openers but keeps real analysis', () => {
  // The filler the user complained about: a meta opener separated from the point by "and" or a comma.
  assert.equal(cleanWatchSummary('I looked into that and the pipeline should finish on time.'), 'the pipeline should finish on time.');
  assert.equal(cleanWatchSummary('I looked at the logs, and T03 is circling.'), 'T03 is circling.');
  assert.equal(cleanWatchSummary('Based on the snapshot, T05 looks fragile.'), 'T05 looks fragile.');
  assert.equal(cleanWatchSummary('Looking at the delta: the final gate is not opening.'), 'the final gate is not opening.');
  assert.equal(cleanWatchSummary('Sure, the retry count is climbing.'), 'the retry count is climbing.');
  assert.equal(cleanWatchSummary("I've checked the recent outcomes. Two retries stand out."), 'Two retries stand out.');
  assert.equal(cleanWatchSummary('It looks like the build will time out.'), 'the build will time out.');
  // A preamble followed only by NO_UPDATE still leaves the control token intact.
  assert.equal(cleanWatchSummary('I looked into that and NO_UPDATE'), 'NO_UPDATE');
  // Content that merely starts with a similar word is not butchered, and an all-preamble answer survives.
  assert.equal(cleanWatchSummary('Checking this is the last phase.'), 'Checking this is the last phase.');
  assert.equal(cleanWatchSummary('T03 is retrying.'), 'T03 is retrying.');
  assert.equal(cleanWatchSummary('I looked into that.'), 'I looked into that.');
  assert.equal(cleanWatchSummary(''), '');
});

test('buildWatchPrompt inlines only outcomes that finished inside the window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-watch-delta-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.docs, { recursive: true });
  const tasks = [task('T01', 1), task('T02', 2), task('T03', 3)];
  const old = new Date(Date.now() - 2 * 3600_000).toISOString();
  const fresh = new Date(Date.now() - 10 * 60_000).toISOString();
  const state: State = {
    version: 1,
    tasks: {
      T01: { ...newTaskState('one'), status: 'done', attempts: 1, finished: old, summary: 'alpha landed long ago' },
      T02: { ...newTaskState('two'), status: 'done', attempts: 1, finished: fresh, summary: 'beta just landed' },
      T03: { ...newTaskState('three'), status: 'running', attempts: 1, started: new Date().toISOString() },
    },
  };
  const ctx = makeCtx(dir, tasks, state);
  const prompt = buildWatchPrompt(ctx, { sinceMs: Date.now() - 30 * 60_000 });
  assert.match(prompt, /finished since/);
  // Only the recent outcome carries its summary; the older one is not repeated.
  assert.match(prompt, /beta just landed/);
  assert.doesNotMatch(prompt, /alpha landed long ago/);
  // The status-only task list still shows every task.
  assert.match(prompt, /T01 \[done\] Task 1/);
  assert.match(prompt, /T03 \[running\] Task 3/);
});

test('buildWatchPrompt inlines only PROGRESS.md sections newer than progressFrom', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-watch-progress-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.docs, { recursive: true });
  writeFileSync(paths.progress, ['# Progress', '', '## alpha', '- a', '', '## beta', '- b', '', '## gamma', '- c', '', '## delta', '- d', '', '## epsilon', '- e', ''].join('\n'));
  assert.equal(progressSectionCount(paths.progress), 5);

  const ctx = makeCtx(dir, [task('T01', 1)], { version: 1, tasks: {} });
  // First check with no offset seeds the newest few sections, not the whole history.
  const bootstrap = buildWatchPrompt(ctx, {});
  assert.match(bootstrap, /## gamma/);
  assert.match(bootstrap, /## epsilon/);
  assert.doesNotMatch(bootstrap, /## alpha/);

  // An explicit offset resumes exactly where the previous check stopped.
  const delta = buildWatchPrompt(ctx, { sinceMs: Date.now(), progressFrom: 3 });
  assert.match(delta, /## delta/);
  assert.match(delta, /## epsilon/);
  assert.doesNotMatch(delta, /## alpha|## beta|## gamma/);
});

test('each check feeds only the changes since the previous check into the next prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-watch-window-'));
  const paths = resolvePaths(dir);
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'watch.jsonl'), `${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'w1', result: 'ok',
  })}\n`);
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;
  mkdirSync(paths.docs, { recursive: true });
  writeFileSync(paths.progress, '# Progress\n\n## one\n\n- a\n');

  const tasks = [task('T01', 1), task('T02', 2)];
  const state: State = {
    version: 1,
    tasks: {
      T01: { ...newTaskState('one'), status: 'running', attempts: 1, started: new Date().toISOString() },
      T02: { ...newTaskState('two'), status: 'running', attempts: 1, started: new Date().toISOString() },
    },
  };
  const ctx = makeCtx(dir, tasks, state);
  ctx.config = { ...DEFAULTS, watch: { ...DEFAULTS.watch, provider: 'fake', model: '' } };

  try {
    const watcher = startPipelineWatch(ctx);
    // T01 finished strictly after the watcher started (its window), so the first check includes it.
    await new Promise((r) => setTimeout(r, 20));
    state.tasks.T01 = { ...state.tasks.T01, status: 'done', finished: new Date().toISOString(), summary: 'OLDSUMM-alpha' };
    await watcher!.checkNow();

    // Between checks a second task finishes and a new progress note is appended.
    const bumped = new Date(Date.now() + 1500).toISOString();
    state.tasks.T02 = { ...state.tasks.T02, status: 'done', finished: bumped, summary: 'FRESHSUMM-beta' };
    writeFileSync(paths.progress, '# Progress\n\n## one\n\n- a\n\n## two\n\n- b\n');
    await new Promise((r) => setTimeout(r, 1100)); // a distinct run stamp for the second prompt file
    await watcher!.checkNow();
    watcher!.stop();

    const prompts = readdirSync(paths.runs).filter((f) => /^watch-.*\.prompt\.md$/.test(f)).sort();
    assert.ok(prompts.length >= 2, `both checks wrote a prompt: ${prompts.join(', ')}`);
    const first = readFileSync(join(paths.runs, prompts[0]), 'utf8');
    const second = readFileSync(join(paths.runs, prompts[prompts.length - 1]), 'utf8');

    assert.match(first, /OLDSUMM-alpha/);
    assert.match(first, /## one/);
    // The second check carries the new work and does not repeat the first window's logs.
    assert.match(second, /FRESHSUMM-beta/);
    assert.match(second, /## two/);
    assert.doesNotMatch(second, /OLDSUMM-alpha/);
    assert.doesNotMatch(second, /## one/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
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

test('a watcher NO_UPDATE reply keeps the panel quiet and is logged as no update', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-watch-silent-'));
  const paths = resolvePaths(dir);
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'watch.jsonl'), `${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'w2', result: 'NO_UPDATE',
  })}\n`);
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;

  const tasks = [task('T01', 1)];
  const state: State = { version: 1, tasks: { T01: { ...newTaskState('one'), status: 'running', attempts: 1, started: new Date().toISOString() } } };
  const ctx = makeCtx(dir, tasks, state);
  ctx.config = { ...DEFAULTS, watch: { ...DEFAULTS.watch, provider: 'fake', model: '' } };

  try {
    const watcher = startPipelineWatch(ctx);
    assert.ok(watcher, 'watcher starts with a usable provider');
    await watcher!.checkNow();
    assert.equal(ctx.watch?.status, 'ready');
    assert.equal(ctx.watch?.summary, undefined, 'nothing is shown when the watcher has nothing to add');
    assert.ok(ctx.watch?.updatedAt, 'the refresh still stamps the panel');

    const log = readFileSync(watchLogPath(paths), 'utf8');
    assert.match(log, /result: ready \(no update\)/);
    assert.match(log, /no update — nothing worth adding/);
    watcher!.stop();
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a NO_UPDATE token followed by real content is kept as a summary, not swallowed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-watch-token-'));
  const paths = resolvePaths(dir);
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'watch.jsonl'), `${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'w3',
    result: 'NO_UPDATE — actually T03 has retried twice; that gate may not open.',
  })}\n`);
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;

  const tasks = [task('T01', 1)];
  const state: State = { version: 1, tasks: { T01: { ...newTaskState('one'), status: 'running', attempts: 1, started: new Date().toISOString() } } };
  const ctx = makeCtx(dir, tasks, state);
  ctx.config = { ...DEFAULTS, watch: { ...DEFAULTS.watch, provider: 'fake', model: '' } };

  try {
    const watcher = startPipelineWatch(ctx);
    assert.ok(watcher, 'watcher starts with a usable provider');
    await watcher!.checkNow();
    assert.equal(ctx.watch?.status, 'ready');
    assert.match(ctx.watch?.summary ?? '', /T03 has retried twice/, 'content after the token is not discarded');
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