import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, type Config } from '../src/config.js';
import type { TaskContract } from '../src/graph.js';
import { scheduleTasks } from '../src/scheduling.js';
import type { Task } from '../src/tasks.js';

function task(id: string, order: number, meta: Record<string, string> = {}): Task {
  return { id, num: order + 1, title: `Task ${id}`, phase: 'P', order, meta };
}

function contracts(edges: Record<string, string[]>): Map<string, TaskContract> {
  return new Map(Object.entries(edges).map(([id, dependsOn]) => [id, { dependsOn, blocks: [], acceptance: [] }]));
}

const config = (strategy: 'roadmap' | 'priority' | 'critical-path', enabled = true): Config => ({
  ...DEFAULTS,
  scheduling: { enabled, strategy },
});

test('scheduling is off by default and preserves roadmap order', () => {
  const tasks = [task('T01', 0), task('T02', 1), task('T03', 2)];
  const plan = scheduleTasks(config('priority', false), tasks, contracts({}));
  assert.equal(plan.strategy, 'roadmap');
  assert.deepEqual(plan.entries.map((e) => e.task.id), ['T01', 'T02', 'T03']);
});

test('priority scheduling orders ready tasks by front-matter priority, then roadmap order', () => {
  const tasks = [
    task('T01', 0, { priority: 'low' }),
    task('T02', 1, { priority: 'high' }),
    task('T03', 2),
    task('T04', 3, { priority: 'urgent' }),
  ];
  const plan = scheduleTasks(config('priority'), tasks, contracts({}));
  assert.deepEqual(plan.entries.map((e) => e.task.id), ['T04', 'T02', 'T03', 'T01']);
});

test('a prerequisite still runs before its consumer regardless of priority', () => {
  const tasks = [
    task('T01', 0, { priority: 'low' }),
    task('T02', 1, { priority: 'high', dependsOn: 'T01' }),
  ];
  const plan = scheduleTasks(config('priority'), tasks, contracts({ T01: [], T02: ['T01'] }));
  assert.deepEqual(plan.entries.map((e) => e.task.id), ['T01', 'T02']);
});

test('critical-path scheduling puts tasks that unblock more work first', () => {
  const tasks = [task('T01', 0), task('T02', 1), task('T03', 2)];
  const plan = scheduleTasks(config('critical-path'), tasks, contracts({ T01: [], T02: ['T01'], T03: ['T02'] }));
  // With the edges above the chain is required anyway; make a second ready branch.
  const branched = scheduleTasks(config('critical-path'), [task('T01', 0), task('T02', 1), task('T03', 2)], contracts({ T01: [], T02: ['T01'], T03: [] }));
  assert.deepEqual(branched.entries.map((e) => e.task.id), ['T01', 'T02', 'T03']);
  assert.equal(plan.entries[0].unlocks, 2);
  assert.match(plan.entries[0].reason, /unblocks 2/);
});

test('unresolved cycles are returned instead of being silently reordered', () => {
  const tasks = [task('T01', 0), task('T02', 1)];
  const plan = scheduleTasks(config('priority'), tasks, contracts({ T01: ['T02'], T02: ['T01'] }));
  assert.equal(plan.entries.length, 0);
  assert.deepEqual(plan.unresolved.map((t) => t.id), ['T01', 'T02']);
});
