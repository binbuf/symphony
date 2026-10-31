import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attentionPath, collectAttention, formatAttention, writeAttention } from '../src/attention.js';
import { resolvePaths } from '../src/paths.js';
import { newTaskState, type State } from '../src/state.js';
import { appendSteering, consumeSteering, pendingSteering, steeringBlock, steeringPath } from '../src/steering.js';
import type { Task } from '../src/tasks.js';

function task(id: string, order: number): Task {
  return { id, num: order + 1, title: `Task ${id}`, phase: 'Phase 1', order, meta: {} };
}

function stateFor(): State {
  return { version: 1, tasks: {} } as State;
}

test('attention lists a halt, pending human approval, inconclusive evidence, judge unavailability and failures', () => {
  const state = stateFor();
  state.halted = { at: '2026-01-01T00:00:00.000Z', taskId: 'T01', category: 'auth', reason: 'bad key' };
  state.tasks.T01 = {
    ...newTaskState('Task T01'),
    status: 'blocked',
    finished: '2026-01-01T00:01:00.000Z',
    acceptance: {
      version: 2,
      revision: 'tree',
      status: 'pending_human',
      at: '2026-01-01T00:01:00.000Z',
      criteria: [{ id: 'design', status: 'pending_human' }],
    },
  };
  state.tasks.T02 = {
    ...newTaskState('Task T02'),
    status: 'blocked',
    summary: 'capture did not produce an image',
    acceptance: {
      version: 2,
      revision: 'tree',
      status: 'inconclusive',
      at: '2026-01-01T00:02:00.000Z',
      criteria: [{ id: 'look', status: 'inconclusive' }],
    },
  };
  state.tasks.T03 = {
    ...newTaskState('Task T03'),
    status: 'blocked',
    summary: 'judge unavailable',
    judge: { verdict: 'unavailable', ok: false, summary: 'judge unavailable: timeout', reason: 'timeout', at: '2026-01-01T00:03:00.000Z' },
  };
  state.tasks.T04 = {
    ...newTaskState('Task T04'),
    status: 'failed',
    summary: 'tests still fail',
  };

  const items = collectAttention(state, [task('T01', 0), task('T02', 1), task('T03', 2), task('T04', 3)]);
  assert.deepEqual(items.map((i) => i.kind), ['halt', 'pending_human', 'inconclusive', 'judge_unavailable', 'failed']);
  assert.equal(items[1].id, 'T01:pending_human');
  assert.ok(items[1].actions.some((a) => /approve T01 design/.test(a)));
  assert.ok(items[3].actions.some((a) => /judge\.required false/.test(a)));
  assert.ok(items[4].actions.some((a) => /run --retry --only T04/.test(a)));

  const lines = formatAttention(items);
  assert.equal(lines[0], 'attention: 5 items');
  assert.ok(lines.some((l) => /T03\s+judge_unavailable/.test(l)));
});

test('attention snapshot is written where a supervisor can read it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-attention-'));
  const paths = resolvePaths(dir);
  const state = stateFor();
  state.tasks.T01 = { ...newTaskState('Task T01'), status: 'failed', summary: 'boom' };
  const items = collectAttention(state, [task('T01', 0)]);
  writeAttention(paths, items);
  assert.ok(existsSync(attentionPath(paths)));
  const snapshot = JSON.parse(readFileSync(attentionPath(paths), 'utf8'));
  assert.equal(snapshot.items[0].kind, 'failed');
  assert.ok(snapshot.at);
});

test('steering is append-only, per task, and folded with consume records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-steering-'));
  const paths = resolvePaths(dir);
  const first = appendSteering(paths, 'T01', 'keep the public API stable', 'dan');
  assert.ok(existsSync(steeringPath(paths, 'T01')));
  appendSteering(paths, 'T01', 'prefer a smaller diff');

  const pending = pendingSteering(paths, 'T01');
  assert.equal(pending.length, 2);
  assert.equal(pending[0].by, 'dan');
  assert.match(pending[0].note, /public API/);
  assert.equal(pendingSteering(paths, 'T02').length, 0);

  consumeSteering(paths, 'T01', [first.id]);
  assert.deepEqual(pendingSteering(paths, 'T01').map((m) => m.note), ['prefer a smaller diff']);
  consumeSteering(paths, 'T01', pendingSteering(paths, 'T01').map((m) => m.id));
  assert.equal(pendingSteering(paths, 'T01').length, 0);
});

test('steering block names the operator note and the sender', () => {
  const block = steeringBlock([
    { id: 'a', taskId: 'T01', at: '2026-01-01T00:00:00.000Z', by: 'dan', note: 'do not touch the CLI' },
    { id: 'b', taskId: 'T01', at: '2026-01-01T00:01:00.000Z', note: 'add a test' },
  ]);
  assert.match(block, /Operator steering/);
  assert.match(block, /dan: do not touch the CLI/);
  assert.match(block, /add a test/);
  assert.equal(steeringBlock([]), '');
});
