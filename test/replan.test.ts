import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resetCommand } from '../src/commands.js';
import { DEFAULTS } from '../src/config.js';
import type { LintReport } from '../src/lint.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import { applyReplanState, buildAutoReplanPrompt, buildReplanPrompt, checkAutoReplanState, planReplanState, resolveDirection } from '../src/replan.js';
import type { BreakdownEvidence } from '../src/breakdown.js';
import type { RunContext } from '../src/runner.js';
import { newTaskState, type State } from '../src/state.js';
import type { Task } from '../src/tasks.js';
import { UsageError } from '../src/util.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };

function task(id: string, title: string, num = Number(id.slice(1))): Task {
  return { id, num, title, phase: 'Phase 1', order: num - 1, meta: {} };
}

function project(): { dir: string; paths: Paths } {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-replan-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(paths.adrDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [x] T01 — Old one\n- [ ] T02 — Old two\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  return { dir, paths };
}

test('resolveDirection defaults to <docs>/REPLAN.md and requires content', () => {
  const { paths } = project();
  assert.throws(() => resolveDirection(paths, undefined), UsageError);
  writeFileSync(join(paths.docs, 'REPLAN.md'), 'Pivot to a queue-based design.\n');
  const d = resolveDirection(paths, undefined);
  assert.equal(d.path, 'docs/REPLAN.md');
  assert.match(d.body, /queue-based/);
  // An explicit path that does not exist is an error.
  assert.throws(() => resolveDirection(paths, 'nope.md'), UsageError);
});

test('planReplanState finds removed rows and ids reused for different work', () => {
  const state: State = {
    version: 1,
    tasks: {
      T01: { ...newTaskState('Old one'), status: 'done' },
      T02: { ...newTaskState('Old two'), status: 'pending' },
      T09: { ...newTaskState('Dropped'), status: 'done' },
    },
  };
  const plan = planReplanState(state, [task('T01', 'New one'), task('T02', 'Old two'), task('T10', 'Fresh')]);
  assert.deepEqual(plan.removed, ['T09']);
  assert.deepEqual(plan.conflicts.map((c) => c.id), ['T01']);
  assert.equal(plan.conflicts[0].oldTitle, 'Old one');
  assert.equal(plan.conflicts[0].newTitle, 'New one');
});

test('applyReplanState prunes removed rows and clears reused ids only when allowed', () => {
  const { paths } = project();
  const plan = {
    removed: ['T09'],
    conflicts: [{ id: 'T01', oldTitle: 'Old one', newTitle: 'New one', status: 'done' as const }],
  };

  const state: State = { version: 1, tasks: { T01: { ...newTaskState('Old one'), status: 'done' }, T09: { ...newTaskState('Dropped'), status: 'done' } } };
  const cleared = applyReplanState(paths, state, plan, { allowIdReuse: false, resetState: false }, silent);
  assert.deepEqual(cleared, []);
  assert.equal(state.tasks.T01.status, 'done');
  assert.equal(state.tasks.T09, undefined);

  const state2: State = { version: 1, tasks: { T01: { ...newTaskState('Old one'), status: 'done' } } };
  const cleared2 = applyReplanState(paths, state2, plan, { allowIdReuse: true, resetState: false }, silent);
  assert.deepEqual(cleared2, ['T01']);
  assert.equal(state2.tasks.T01, undefined);
});

test('applyReplanState --reset-state wipes every row and the halt', () => {
  const { paths } = project();
  const state: State = { version: 1, halted: { at: 'x', category: 'auth', reason: 'y' }, tasks: { T01: { ...newTaskState('Old one'), status: 'done' } } };
  applyReplanState(paths, state, { removed: [], conflicts: [] }, { allowIdReuse: false, resetState: true }, silent);
  assert.deepEqual(state.tasks, {});
  assert.equal(state.halted, undefined);
});

test('checkAutoReplanState protects finished work and reports what runs next', () => {
  const state: State = {
    version: 1,
    tasks: {
      T01: { ...newTaskState('Old one'), status: 'done' },
      T02: { ...newTaskState('Old two'), status: 'pending' },
    },
  };
  const ok = checkAutoReplanState(state, [task('T01', 'Old one'), task('T03', 'Fresh')]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.pending, ['T03']);

  const removed = checkAutoReplanState(state, [task('T02', 'Old two')]);
  assert.equal(removed.ok, false);
  assert.match(removed.errors[0], /T01 already ran \[done\] but the rewrite removed it/);

  const retitled = checkAutoReplanState(state, [task('T01', 'Different'), task('T02', 'Old two')]);
  assert.equal(retitled.ok, false);
  assert.match(retitled.errors[0], /T01 was retitled/);

  const empty = checkAutoReplanState(state, []);
  assert.equal(empty.ok, false);
  assert.match(empty.errors[0], /left no tasks/);
});

test('buildAutoReplanPrompt renders the trigger, the plan and the free ids', () => {
  const { paths } = project();
  const ctx = { paths, config: { ...DEFAULTS, designDocs: false }, tasks: [task('T01', 'Old one'), task('T02', 'Old two')] } as unknown as RunContext;
  const report = { findings: [{ level: 'warn', code: 'x', message: 'm' }], candidates: [] } as unknown as LintReport;
  const ev: BreakdownEvidence = {
    stage: 'failure',
    task: task('T02', 'Old two'),
    status: 'failed',
    attempts: 2,
    continuations: 0,
    category: 'task',
    reason: 'boom',
    taskBody: '# T02 — Old two\n\n## Goal\nship it\n',
  };
  const text = buildAutoReplanPrompt(ctx, ev, report, 'the upcoming plan needs reshaping');
  assert.doesNotMatch(text, /\{[a-zA-Z_]\w*\}/);
  assert.match(text, /task: T02 — Old two/);
  assert.match(text, /boom/);
  assert.match(text, /the upcoming plan needs reshaping/);
  assert.match(text, /at least T03/);
  assert.match(text, /SYMPHONY_RESULT/);
  assert.match(text, /- \[x\] T01 — Old one/);
});

test('reset --all clears state and resets every roadmap marker to pending', () => {
  const { paths } = project();
  const tasks = [task('T01', 'Old one'), task('T02', 'Old two')];
  const state: State = { version: 1, halted: { at: 'x', category: 'auth', reason: 'y' }, tasks: { T01: { ...newTaskState('Old one'), status: 'done' } } };
  const code = resetCommand(paths, state, tasks, undefined, { revert: false, all: true, log: silent });
  assert.equal(code, 0);
  assert.deepEqual(state.tasks, {});
  assert.equal(state.halted, undefined);
  const roadmap = readFileSync(paths.roadmap, 'utf8');
  assert.match(roadmap, /- \[ \] T01 — Old one/);
  assert.match(roadmap, /- \[ \] T02 — Old two/);
  assert.doesNotMatch(roadmap, /\[x\] T01/);
});

test('reset --all refuses to combine with --revert', () => {
  const { paths } = project();
  assert.throws(() => resetCommand(paths, { version: 1, tasks: {} }, [task('T01', 'Old one')], undefined, { revert: true, all: true, log: silent }), UsageError);
});

test('buildReplanPrompt renders from the template with no leftover placeholders', () => {
  const { paths } = project();
  const ctx = { paths, config: { ...DEFAULTS, designDocs: true }, tasks: [task('T01', 'Old one'), task('T02', 'Old two')] } as unknown as RunContext;
  const report = { findings: [{ level: 'warn', code: 'x', message: 'm' }], candidates: [] } as unknown as LintReport;
  const text = buildReplanPrompt(ctx, report, { path: 'docs/REPLAN.md', body: 'Switch to a queue-based design.' });
  assert.doesNotMatch(text, /\{[a-zA-Z_]\w*\}/);
  assert.match(text, /Switch to a queue-based design\./);
  assert.match(text, /## Rules/);
  assert.match(text, /New tasks take the next free ids after the highest id currently in use \(at least T03\)/);
  assert.match(text, /SYMPHONY_RESULT/);
});

test('buildReplanPrompt omits the design rules when designDocs is off', () => {
  const { paths } = project();
  const ctx = { paths, config: { ...DEFAULTS, designDocs: false }, tasks: [task('T01', 'Old one')] } as unknown as RunContext;
  const report = { findings: [], candidates: [] } as unknown as LintReport;
  const text = buildReplanPrompt(ctx, report, { path: 'docs/REPLAN.md', body: 'Simplify.' });
  assert.doesNotMatch(text, /\{[a-zA-Z_]\w*\}/);
  assert.doesNotMatch(text, /design docs under/);
  assert.doesNotMatch(text, /Record the pivot as an ADR/);
  assert.match(text, /Simplify\./);
});
