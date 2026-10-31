import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, type Config } from '../src/config.js';
import { resolvePaths } from '../src/paths.js';
import { newTaskState, type State } from '../src/state.js';
import { collectSupervisorSignals, decideSupervision, formatSupervisor, supervisorPath, writeSupervisorSnapshot } from '../src/supervisor.js';
import type { Task } from '../src/tasks.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');

function task(id = 'T01'): Task {
  return { id, num: 1, title: 'Task', phase: 'P', order: 0, meta: {} };
}

function emptyState(): State {
  return { version: 1, tasks: {} } as State;
}

const config = (over: Partial<Config['supervisor']> = {}): Config => ({
  ...DEFAULTS,
  supervisor: { ...DEFAULTS.supervisor, ...over },
});

test('ordinary pending/running work is left alone', () => {
  const state = emptyState();
  state.tasks.T01 = { ...newTaskState('t'), status: 'running', started: '2026-01-01T11:55:00.000Z', attempts: 1 };
  const decision = decideSupervision({ state, tasks: [task()], config: config(), now: NOW });
  assert.equal(decision.action, 'none');
  assert.deepEqual(decision.signals, []);
});

test('a slow running task raises a watch exception', () => {
  const state = emptyState();
  state.tasks.T01 = { ...newTaskState('t'), status: 'running', started: '2026-01-01T11:00:00.000Z', attempts: 1 };
  const decision = decideSupervision({ state, tasks: [task()], config: config({ slowAfterMin: 45 }), now: NOW });
  assert.equal(decision.action, 'watch');
  assert.ok(decision.signals.some((s) => s.kind === 'slow'));
  assert.equal(decision.taskId, 'T01');
});

test('retries and a flat observable trend raise watch exceptions', () => {
  const state = emptyState();
  state.tasks.T01 = {
    ...newTaskState('t'),
    status: 'running',
    started: '2026-01-01T11:59:00.000Z',
    attempts: 2,
    deltas: [
      { at: '2026-01-01T11:00:00.000Z', attempt: 1, fingerprint: 'a', signals: [] },
      { at: '2026-01-01T11:30:00.000Z', attempt: 2, fingerprint: 'a', signals: [] },
    ],
  };
  const signals = collectSupervisorSignals({ state, tasks: [task()], config: config(), now: NOW });
  assert.ok(signals.some((s) => s.kind === 'repeated'));
  assert.ok(signals.some((s) => s.kind === 'stalled'));
  assert.equal(decideSupervision({ state, tasks: [task()], config: config(), now: NOW }).action, 'watch');
});

test('blocked, failed, pending-human and required-judge-unavailable tasks are attention', () => {
  const state = emptyState();
  state.tasks.T01 = { ...newTaskState('t'), status: 'blocked', summary: 'needs a decision' };
  state.tasks.T02 = { ...newTaskState('t'), status: 'failed', summary: 'tests fail' };
  state.tasks.T03 = {
    ...newTaskState('t'),
    status: 'running',
    acceptance: { version: 2, revision: 'r', status: 'pending_human', at: '2026-01-01T11:00:00.000Z', criteria: [] },
  };
  state.tasks.T04 = {
    ...newTaskState('t'),
    status: 'blocked',
    judge: { verdict: 'unavailable', ok: false, summary: 'judge unavailable', reason: 'timeout', at: '2026-01-01T11:00:00.000Z' },
  };
  const tasks = [task('T01'), { ...task('T02'), num: 2 }, { ...task('T03'), num: 3 }, { ...task('T04'), num: 4 }];
  const decision = decideSupervision({ state, tasks, config: config(), now: NOW });
  assert.equal(decision.action, 'attention');
  assert.ok(decision.signals.filter((s) => s.kind === 'attention').length >= 4);
});

test('a halt outranks everything else', () => {
  const state = emptyState();
  state.halted = { at: '2026-01-01T11:00:00.000Z', category: 'auth', reason: 'bad key' };
  state.tasks.T01 = { ...newTaskState('t'), status: 'failed' };
  const decision = decideSupervision({ state, tasks: [task()], config: config(), now: NOW });
  assert.equal(decision.action, 'halt');
  assert.match(formatSupervisor(decision)[0], /supervisor: halt/);
});

test('the supervisor snapshot is written for external supervisors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-supervisor-'));
  const paths = resolvePaths(dir);
  const state = emptyState();
  state.tasks.T01 = { ...newTaskState('t'), status: 'failed', summary: 'boom' };
  const decision = decideSupervision({ state, tasks: [task()], config: config(), now: NOW });
  writeSupervisorSnapshot(paths, decision);
  assert.ok(existsSync(supervisorPath(paths)));
  const saved = JSON.parse(readFileSync(supervisorPath(paths), 'utf8'));
  assert.equal(saved.action, 'attention');
  assert.equal(saved.signals[0].taskId, 'T01');
});
