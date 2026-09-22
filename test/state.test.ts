import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRoadmap } from '../src/roadmap.js';
import { newTaskState, reconcile, type State } from '../src/state.js';

test('reconcile rebuilds rows from markers when state is empty', () => {
  const rm = parseRoadmap(['- [x] T01 — a', '- [~] T02 — b ⟵ blocked', '- [~] T03 — c ⟵ running', '- [ ] T04 — d', '- [x] T05 — e ⟵ accepted', '- [~] T06 — f'].join('\n'));
  const state: State = { version: 1, tasks: {} };
  const notes = reconcile(state, rm);
  assert.equal(state.tasks.T01.status, 'done');
  assert.equal(state.tasks.T02.status, 'blocked');
  assert.equal(state.tasks.T03.status, 'failed');
  assert.equal(state.tasks.T04, undefined);
  assert.equal(state.tasks.T05.status, 'accepted');
  assert.equal(state.tasks.T06.status, 'failed');
  assert.equal(notes.length, 5);
  assert.ok(state.tasks.T01.reconciled);
});

test('reconcile honours a human tick but never demotes a terminal state', () => {
  const rm = parseRoadmap(['- [x] T01 — a', '- [ ] T02 — b'].join('\n'));
  const state: State = { version: 1, tasks: { T01: { ...newTaskState('a'), status: 'failed', attempts: 2 }, T02: { ...newTaskState('b'), status: 'done' } } };
  reconcile(state, rm);
  assert.equal(state.tasks.T01.status, 'done');
  assert.equal(state.tasks.T01.attempts, 2);
  assert.equal(state.tasks.T02.status, 'done'); // roadmap says pending; state wins (caller re-patches the bullet)
});

test('reconcile keeps the title a held task ran under when the roadmap renames its id', () => {
  const rm = parseRoadmap(['- [x] T01 — Renamed work'].join('\n'));
  const state: State = { version: 1, tasks: { T01: { ...newTaskState('Original work'), status: 'done', attempts: 1 } } };
  const notes = reconcile(state, rm);
  assert.equal(state.tasks.T01.title, 'Original work');
  assert.equal(state.tasks.T01.titleMismatch, 'Renamed work');
  assert.match(notes.join('\n'), /T01: ROADMAP.md titles this "Renamed work"/);
  // A second pass does not repeat the note, but keeps the evidence.
  const again = reconcile(state, rm);
  assert.deepEqual(again, []);
  assert.equal(state.tasks.T01.title, 'Original work');
});

test('reconcile re-titles a task that will run again', () => {
  const rm = parseRoadmap(['- [ ] T01 — Renamed work'].join('\n'));
  const state: State = { version: 1, tasks: { T01: { ...newTaskState('Original work'), status: 'failed', attempts: 1 } } };
  reconcile(state, rm);
  assert.equal(state.tasks.T01.title, 'Renamed work');
  assert.equal(state.tasks.T01.titleMismatch, undefined);
});
