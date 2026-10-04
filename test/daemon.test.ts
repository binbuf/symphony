import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { ControlServer, sendControl } from '../src/control.js';
import { runWithDaemon } from '../src/daemon.js';
import type { Logger } from '../src/logger.js';
import { stopPresent, resolvePaths } from '../src/paths.js';
import { loadProject } from '../src/project.js';
import { runCommand, type RunContext, type RunFlags } from '../src/runner.js';
import { readRuntime, startRuntimeWriter } from '../src/runtime.js';
import { loadState } from '../src/state.js';
import { RemoteTuiModel } from '../src/tui/model.js';
import { nowIso } from '../src/util.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };
const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false };

const result = (status: string, summary: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: `SYMPHONY_RESULT\nstatus: ${status}\nsummary: ${summary}\nEND_SYMPHONY_RESULT` });

function gitInit(dir: string): void {
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
}

test('control channel: a request round-trips through the server and consumes both files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-control-'));
  const paths = resolvePaths(dir);
  const seen: string[] = [];
  const server = new ControlServer(paths, async (req) => {
    seen.push(req.action);
    return { id: req.id, ok: true, message: `did ${req.action}`, at: nowIso() };
  });
  server.start(20);
  try {
    const res = await sendControl(paths, 'pause', { note: 'x' }, { timeoutMs: 3000 });
    assert.equal(res?.ok, true);
    assert.equal(res?.message, 'did pause');
    assert.deepEqual(seen, ['pause']);
    // A second command works too, so the channel is not one-shot.
    const res2 = await sendControl(paths, 'stop', undefined, { timeoutMs: 3000 });
    assert.equal(res2?.ok, true);
    assert.deepEqual(seen, ['pause', 'stop']);
  } finally {
    server.stop();
  }
});

test('control channel: an unanswered request times out without hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-control-timeout-'));
  const paths = resolvePaths(dir);
  const res = await sendControl(paths, 'pause', undefined, { timeoutMs: 300 });
  assert.equal(res, undefined);
});

test('runtime descriptor: writes, merges and survives the writer stopping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-runtime-'));
  const paths = resolvePaths(dir);
  const writer = startRuntimeWriter(paths, { phase: 'starting' }, 40);
  writer.update({ phase: 'running', currentTask: 'T01' });
  writer.update({ stream: '.symphony/runs/T01-1.log' });
  const live = readRuntime(paths);
  assert.equal(live?.phase, 'running');
  assert.equal(live?.currentTask, 'T01');
  assert.equal(live?.stream, '.symphony/runs/T01-1.log');
  writer.stop();
  assert.equal(readRuntime(paths)?.phase, 'running');
});

test('RemoteTuiModel reads plan, state, runtime and tails the live stream; accept works offline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-remote-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n- [ ] T01 — One → [tasks/01-one.md](tasks/01-one.md)\n');
  writeFileSync(join(paths.tasksDir, '01-one.md'), '# T01 — One\n\n## Goal\nx\n');
  writeFileSync(paths.progress, '# Progress\n');
  mkdirSync(paths.symphony, { recursive: true });
  // State: T01 failed, so it can be accepted.
  writeFileSync(paths.state, JSON.stringify({ version: 1, tasks: { T01: { title: 'One', status: 'failed', attempts: 1, durationS: 3, logs: [] } } }));
  const streamFile = join(paths.runs, 'T01-1.log');
  mkdirSync(paths.runs, { recursive: true });
  writeFileSync(streamFile, 'line one\n');
  const writer = startRuntimeWriter(paths, { phase: 'running', currentTask: 'T01' }, 50);
  writer.update({ stream: '.symphony/runs/T01-1.log', pauseAt: 'T01', watch: { status: 'ready', enabled: true, intervalMin: 5, provider: 'opencode', summary: 'going well', checks: 2 } });

  const model = new RemoteTuiModel({ paths, config: { provider: 'fake', timeZone: 'utc' }, log: silent });
  try {
    model.poll();
    assert.equal(model.tasks.length, 1);
    assert.equal(model.tasks[0].id, 'T01');
    assert.equal(model.state.tasks.T01.status, 'failed');
    assert.equal(model.pauseAt, 'T01');
    assert.equal(model.watch?.summary, 'going well');
    assert.equal(model.isLive(), false, 'no lock means the daemon is not live');

    // The tail is incremental: the first drain returns what is already there, the next only the delta.
    const first = model.takeOutput();
    assert.match(first, /line one/);
    writeFileSync(streamFile, 'line one\nline two\n');
    const delta = model.takeOutput();
    assert.equal(delta, 'line two\n');

    // No daemon: accept is applied directly and lands in the state file.
    model.accept('T01');
    assert.equal(loadState(paths).tasks.T01.status, 'accepted');
  } finally {
    writer.stop();
  }
});

test('runWithDaemon services a pause request at the task boundary and publishes a runtime heartbeat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-daemon-'));
  gitInit(dir);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — One → [tasks/01-one.md](tasks/01-one.md)\n- [ ] T02 — Two → [tasks/02-two.md](tasks/02-two.md)\n');
  writeFileSync(join(paths.tasksDir, '01-one.md'), '# T01 — One\n\n## Goal\nx\n');
  writeFileSync(join(paths.tasksDir, '02-two.md'), '# T02 — Two\n\n## Goal\ny\n');
  writeFileSync(paths.progress, '# Progress\n');
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'default.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_sleep', ms: 800 }),
    result('done', 'finished'),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;

  const log: Logger = { ...silent, info() {}, warn() {} };
  const loaded = loadProject(paths, silent);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxContinuations: 3, watch: { ...DEFAULTS.watch, enabled: false } };
  const ctx: RunContext = { paths, config, cli: {}, flags, log, roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state, interrupted: false, abort: new AbortController() };
  try {
    const run = runWithDaemon(ctx, () => runCommand(ctx));
    // Queue a pause as soon as the daemon is up; it lands at the next boundary (before T02).
    void sendControl(paths, 'pause', undefined, { timeoutMs: 5000 });
    const code = await run;
    assert.equal(code, 0);
    assert.ok(stopPresent(paths), 'the pause sentinel is in place');
    assert.equal(ctx.state.tasks.T02?.status ?? 'pending', 'pending', 'T02 never ran');
    const rt = readRuntime(paths);
    assert.ok(rt, 'a runtime descriptor was written');
    assert.equal(rt?.pid, process.pid, 'the descriptor names the daemon process');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('runWithDaemon: a wrap-up request stops the session, closes the task out and pauses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-daemon-wrapup-'));
  gitInit(dir);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — One → [tasks/01-one.md](tasks/01-one.md)\n- [ ] T02 — Two → [tasks/02-two.md](tasks/02-two.md)\n');
  writeFileSync(join(paths.tasksDir, '01-one.md'), '# T01 — One\n\n## Goal\nx\n');
  writeFileSync(join(paths.tasksDir, '02-two.md'), '# T02 — Two\n\n## Goal\ny\n');
  writeFileSync(paths.progress, '# Progress\n');
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_sleep', ms: 1500 }),
    result('done', 'should have been interrupted'),
  ].join('\n') + '\n');
  writeFileSync(join(fixtures, 'T01.wrapup.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_write', path: 'closed.txt', content: 'closed out' }),
    result('continue', 'wrapped up for resume'),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;

  const log: Logger = { ...silent, info() {}, warn() {} };
  const loaded = loadProject(paths, silent);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxContinuations: 3, watch: { ...DEFAULTS.watch, enabled: false } };
  const ctx: RunContext = { paths, config, cli: {}, flags, log, roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state, interrupted: false, abort: new AbortController() };
  try {
    const run = runWithDaemon(ctx, () => runCommand(ctx));
    void sendControl(paths, 'wrap-up', undefined, { timeoutMs: 5000 });
    const code = await run;
    assert.equal(code, 0, 'the run pauses cleanly');
    assert.ok(stopPresent(paths), 'the pause sentinel is in place');
    assert.ok(readFileSync(join(dir, 'closed.txt'), 'utf8').includes('closed out'), 'the close-out session ran');
    assert.equal(ctx.state.tasks.T01.status, 'running');
    assert.equal(ctx.state.tasks.T01.continuation, 1, 'the task resumes at its next slice');
    assert.equal(ctx.state.tasks.T02?.status ?? 'pending', 'pending', 'T02 never ran');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('an attach client can stop the harness through the control channel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-daemon-attach-stop-'));
  gitInit(dir);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — One → [tasks/01-one.md](tasks/01-one.md)\n- [ ] T02 — Two → [tasks/02-two.md](tasks/02-two.md)\n');
  writeFileSync(join(paths.tasksDir, '01-one.md'), '# T01 — One\n\n## Goal\nx\n');
  writeFileSync(join(paths.tasksDir, '02-two.md'), '# T02 — Two\n\n## Goal\ny\n');
  writeFileSync(paths.progress, '# Progress\n');
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_sleep', ms: 2000 }),
    result('done', 'should have been stopped'),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;

  const log: Logger = { ...silent, info() {}, warn() {} };
  const loaded = loadProject(paths, silent);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxContinuations: 3, watch: { ...DEFAULTS.watch, enabled: false } };
  const ctx: RunContext = { paths, config, cli: {}, flags, log, roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state, interrupted: false, abort: new AbortController() };
  const model = new RemoteTuiModel({ paths, config: { provider: 'fake' }, log: silent });
  try {
    const run = runWithDaemon(ctx, () => runCommand(ctx));
    // Wait until the daemon owns the lock and the view sees it as live.
    for (let i = 0; i < 60 && !model.isLive(); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.ok(model.isLive(), 'the daemon is live before we ask it to stop');
    model.stopHarness();
    const code = await run;
    assert.equal(code, 143, 'the harness stops the run instead of finishing it');
    assert.equal(ctx.state.tasks.T01.status, 'failed', 'the stopped task is recorded unfinished');
    assert.equal(ctx.state.tasks.T01.lastError?.category, 'interrupted', 'the stop is recorded as an interruption');
    assert.equal(ctx.state.tasks.T01.attempts, 0, 'the interrupted session does not count as an attempt');
    assert.equal(ctx.state.tasks.T02?.status ?? 'pending', 'pending', 'T02 never ran');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});