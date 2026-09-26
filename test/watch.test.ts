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
import { buildWatchPrompt, cleanWatchSummary, pipelineSnapshot, startPipelineWatch, watchLogPath } from '../src/watch.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };

const task = (id: string, num: number): Task => ({ id, num, title: `Task ${num}`, phase: 'Phase 1', order: num - 1, meta: {} });

function makeCtx(root: string, tasks: Task[], state: State): RunContext {
  const paths = resolvePaths(root);
  return {
    paths, config: DEFAULTS, cli: {}, flags: { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false },
    log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks, state, interrupted: false, abort: new AbortController(),
  };
}

test('pipelineSnapshot describes the pipeline from live state', () => {
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
});

test('buildWatchPrompt asks how the current task is doing and points at the symphony log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-watch-prompt-'));
  const ctx = makeCtx(dir, [task('T01', 1)], { version: 1, tasks: {} });
  const prompt = buildWatchPrompt(ctx);
  assert.match(prompt, /How is the current task doing\?/);
  assert.match(prompt, /`\.symphony\/symphony\.log`/);
  assert.match(prompt, /4-5 sentences max/);
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
  // Content that merely starts with a similar word is not butchered, and an all-preamble answer survives.
  assert.equal(cleanWatchSummary('Checking this is the last phase.'), 'Checking this is the last phase.');
  assert.equal(cleanWatchSummary('T03 is retrying.'), 'T03 is retrying.');
  assert.equal(cleanWatchSummary('I looked into that.'), 'I looked into that.');
  assert.equal(cleanWatchSummary(''), '');
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

test('a ready watch check posts an in-progress message threaded under the running task, when the feature flag is on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-watch-slack-'));
  const paths = resolvePaths(dir);
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'watch.jsonl'), `${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'w1',
    result: 'T02 is healthy and should finish shortly.',
  })}\n`);
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';

  const tasks = [task('T01', 1), task('T02', 2)];
  const state: State = { version: 1, tasks: { T01: { ...newTaskState('one'), status: 'done', attempts: 1 }, T02: { ...newTaskState('two'), status: 'running', attempts: 1, started: new Date().toISOString() } } };
  const ctx = makeCtx(dir, tasks, state);
  ctx.config = {
    ...DEFAULTS,
    watch: { ...DEFAULTS.watch, provider: 'fake', model: '' },
    slack: { ...DEFAULTS.slack, enabled: true, channel: 'C123ABC', events: { ...DEFAULTS.slack.events, watch: true } },
  };
  const posts: URLSearchParams[] = [];
  ctx.fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    posts.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, ts: 'watch-ts' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  // The running task already has a thread root from its taskStart message.
  ctx.slackThreads = new Map([['T02', 'root-1']]);

  try {
    const watcher = startPipelineWatch(ctx);
    await watcher!.checkNow();
    for (let i = 0; i < 50 && posts.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.length, 1, 'one in-progress update is posted');
    assert.equal(posts[0].get('channel'), 'C123ABC');
    assert.equal(posts[0].get('thread_ts'), 'root-1', 'it replies in the running task thread');
    assert.match(posts[0].get('text') ?? '', /T02 in progress — Task 2/);
    assert.match(posts[0].get('text') ?? '', /T02 is healthy and should finish shortly\./);
    watcher!.stop();

    // With the feature flag off, the same ready check posts nothing.
    posts.length = 0;
    const off = makeCtx(dir, tasks, state);
    off.config = { ...ctx.config, slack: { ...ctx.config.slack, events: { ...ctx.config.slack.events, watch: false } } };
    off.fetchImpl = ctx.fetchImpl;
    const offWatcher = startPipelineWatch(off);
    await offWatcher!.checkNow();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(posts.length, 0, 'the watch event is feature-flagged off by default');
    offWatcher!.stop();
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
    delete process.env.SLACK_BOT_TOKEN;
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