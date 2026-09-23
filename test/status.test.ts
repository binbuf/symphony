import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { statusCommand } from '../src/commands.js';
import { DEFAULTS } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import { buildPipelineStatus, buildStatusTable } from '../src/status.js';
import { newTaskState, type State } from '../src/state.js';
import type { Task } from '../src/tasks.js';

const task = (id: string, num: number, phase: string): Task => ({ id, num, title: `t${num}`, phase, order: num - 1, meta: {} });

function captureLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: { info() {}, warn() {}, error() {}, plain: (m) => lines.push(m), banner() {} }, lines };
}

test('buildStatusTable keeps the model tail compact and shows it in full when expanded', () => {
  const model = 'some-provider-namespace/claude-sonnet-4-5';
  const tasks = [task('T01', 1, 'Phase 1')];
  const state: State = { version: 1, tasks: { T01: { ...newTaskState('t1'), status: 'running', provider: 'opencode', model } } };

  const compact = buildStatusTable(tasks, state);
  // The compact cell is ellipsized from the front, so the specific model name survives.
  assert.ok(compact.rows[0][10].startsWith('…'));
  assert.ok(compact.rows[0][10].endsWith('claude-sonnet-4-5'));
  assert.ok(compact.rows[0][10].length <= 28);

  const expanded = buildStatusTable(tasks, state, { expand: true });
  assert.equal(expanded.rows[0][10], model, 'expand disables the per-cell cap');
});

test('buildPipelineStatus reports done, blocked, failed, remaining and the last finished task', () => {
  const tasks = [task('T01', 1, 'Phase 1'), task('T02', 2, 'Phase 1'), task('T03', 3, 'Phase 2'), task('T04', 4, 'Phase 2')];
  const state: State = {
    version: 1,
    tasks: {
      T01: { ...newTaskState('t1'), status: 'done', finished: '2026-01-01T00:00:00Z', summary: 'landed' },
      T02: { ...newTaskState('t2'), status: 'blocked' },
      T03: { ...newTaskState('t3'), status: 'failed' },
    },
  };
  const block = buildPipelineStatus(tasks, state, '2026-01-02T03:04:05Z');
  assert.match(block, /updated 2026-01-02T03:04:05Z · 1\/4 done/);
  assert.match(block, /- Completed: T01/);
  assert.match(block, /- Blocked: T02/);
  assert.match(block, /- Failed: T03/);
  assert.match(block, /- Remaining: T04/);
  assert.match(block, /- Last finished: T01 — done · landed/);
  assert.doesNotMatch(block, /Halted/);
});

test('buildPipelineStatus surfaces a halt and handles an all-pending pipeline', () => {
  const tasks = [task('T01', 1, 'Phase 1')];
  const state: State = { version: 1, halted: { at: '2026-01-01T00:00:00Z', taskId: 'T01', category: 'auth', reason: 'no key' }, tasks: {} };
  const block = buildPipelineStatus(tasks, state, 'now');
  assert.match(block, /- Remaining: T01/);
  assert.match(block, /- Halted: auth on T01 — no key/);
});

test('statusCommand shows start and end datetime stamps in the table', () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'symphony-status-')));
  const tasks = [task('T01', 1, 'Phase 1'), task('T02', 2, 'Phase 1'), task('T03', 3, 'Phase 1')];
  const state: State = {
    version: 1,
    tasks: {
      T01: { ...newTaskState('t1'), status: 'done', attempts: 1, started: '2026-01-02T03:04:05Z', finished: '2026-01-02T03:34:05Z', durationS: 1800 },
      T03: { ...newTaskState('t3'), status: 'running', attempts: 1, started: new Date().toISOString(), durationS: 1200, pid: process.pid },
    },
  };
  const { log, lines } = captureLogger();
  assert.equal(statusCommand(paths, { ...DEFAULTS, timeZone: 'utc' }, state, tasks, log, false), 0);
  const out = lines.join('\n');
  const head = lines[0];
  assert.match(head, /duration\s+start\s+end/);
  assert.match(out, /30 min\s+2026-01-02 03:04:05Z\s+2026-01-02 03:34:05Z/);
  // A running task labels its elapsed time and includes the session still in flight.
  const running = lines.find((l) => l.startsWith('T03'))!;
  assert.match(running, /20 min \(running\)/);
  // The pending task has no timing recorded: both columns fall back to '-'.
  const row = lines.find((l) => l.startsWith('T02'))!;
  assert.match(row, /^T02\s+Phase 1\s+t2\s+pending\s+0\s+-\s+-\s+-\s+-/);
  // The footer total matches the table: finished time plus the running session's elapsed time.
  assert.match(out, /1\/3 done · 50 min/);
});

test('statusCommand splits a task into a parent line plus one line per session run', () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'symphony-status-split-')));
  const tasks = [task('T01', 1, 'Phase 1')];
  const state: State = {
    version: 1,
    tasks: {
      T01: {
        ...newTaskState('t1'),
        status: 'done',
        attempts: 3,
        // The last attempt's start is what state keeps; the parent line must span the whole task.
        started: '2026-01-02T02:00:00Z',
        finished: '2026-01-02T03:30:00Z',
        durationS: 5400,
        summary: 'all slices landed',
        logs: [
          { kind: 'task', jsonl: 'a', log: 'a', prompt: 'a', status: 'continue', summary: 'slice one', started: '2026-01-02T01:00:00Z', durationS: 1200, costUsd: 0.5 },
          { kind: 'task', jsonl: 'b', log: 'b', prompt: 'b', status: 'continue', summary: 'slice two', started: '2026-01-02T01:30:00Z', durationS: 1800, costUsd: 0.7 },
          { kind: 'task', jsonl: 'c', log: 'c', prompt: 'c', status: 'done', summary: 'last slice', started: '2026-01-02T02:00:00Z', durationS: 2400, costUsd: 0.9, provider: 'opencode', model: 'openrouter/z-ai/glm-5.3' },
        ],
      },
    },
  };
  const { log, lines } = captureLogger();
  assert.equal(statusCommand(paths, { ...DEFAULTS, timeZone: 'utc' }, state, tasks, log, false), 0);
  // Parent line: total start (first session) through finish, accumulated duration and final summary.
  const parent = lines.find((l) => l.startsWith('T01'))!;
  assert.match(parent, /2026-01-02 01:00:00Z\s+2026-01-02 03:30:00Z/);
  assert.match(parent, /1\.5 h/);
  assert.match(parent, /all slices landed/);
  // Each session run below it: its own start/end, duration and summary.
  const children = lines.filter((l) => l.startsWith('  ↳'));
  assert.equal(children.length, 3);
  assert.match(children[0], /run 1 · task\s+continue/);
  assert.match(children[0], /20 min\s+2026-01-02 01:00:00Z\s+2026-01-02 01:20:00Z/);
  assert.match(children[0], /slice one/);
  assert.match(children[2], /run 3 · task\s+done/);
  assert.match(children[2], /40 min\s+2026-01-02 02:00:00Z\s+2026-01-02 02:40:00Z/);
  assert.match(children[2], /last slice/);
  // The session's own provider and model are shown in separate columns, so an escalated run is visible in the table.
  assert.match(children[2], /opencode\s+openrouter\/z-ai\/glm-5\.3/);
});
