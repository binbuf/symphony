import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPipelineStatus } from '../src/status.js';
import { newTaskState, type State } from '../src/state.js';
import type { Task } from '../src/tasks.js';

const task = (id: string, num: number, phase: string): Task => ({ id, num, title: `t${num}`, phase, order: num - 1, meta: {} });

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