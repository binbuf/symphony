import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decomposeCommand } from '../src/commands.js';
import { DEFAULTS } from '../src/config.js';
import { applyDecomposition, planDecomposition } from '../src/decomposition.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import { loadState, newTaskState } from '../src/state.js';
import type { Task } from '../src/tasks.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };

const body = `# T01 — Ship the thing

## Goal
Ship it.

## Scope
- build the parser
- build the writer
- wire the CLI

## Done when
- [ ] tests pass

## Hand-off
(tbd)
`;

function project(): { dir: string; paths: ReturnType<typeof resolvePaths>; task: Task } {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-decompose-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — Ship the thing → [tasks/01-thing.md](tasks/01-thing.md)\n');
  writeFileSync(paths.progress, '# Progress\n');
  const file = join(paths.tasksDir, '01-thing.md');
  writeFileSync(file, body);
  const task: Task = {
    id: 'T01',
    num: 1,
    title: 'Ship the thing',
    phase: 'Phase 1',
    order: 0,
    taskFile: file,
    taskFileRel: 'docs/tasks/01-thing.md',
    meta: {},
  };
  return { dir, paths, task };
}

test('deterministic decomposition plans one child per scope item', () => {
  const { paths, task } = project();
  const plan = planDecomposition(task, body, [task], DEFAULTS);
  assert.ok(plan);
  assert.equal(plan.source, 'scope');
  assert.deepEqual(plan.children.map((c) => c.id), ['T01a', 'T01b', 'T01c']);
  assert.match(plan.children[0].title, /build the parser/);
  assert.equal(paths.root.length > 0, true);
});

test('decomposition falls back to unchecked acceptance items when scope is empty', () => {
  const { task } = project();
  const acceptanceOnly = '# T01\n\n## Done when\n- [x] one\n- [ ] two\n- [ ] three\n';
  const plan = planDecomposition(task, acceptanceOnly, [task], DEFAULTS);
  assert.ok(plan);
  assert.equal(plan.source, 'acceptance');
  assert.deepEqual(plan.children.map((c) => c.item), ['two', 'three']);
});

test('nothing is planned when there are too few items or no free child ids', () => {
  const { task } = project();
  assert.equal(planDecomposition(task, '# T01\n\n## Scope\n- only one\n', [task], DEFAULTS), undefined);
  const taken = [task, ...'abcdefghijklmnopqrstuvwxyz'.split('').map((s, i) => ({ ...task, id: `T01${s}`, order: i + 1 }))];
  assert.equal(planDecomposition(task, body, taken, DEFAULTS), undefined);
});

test('applyDecomposition writes child files and inserts their bullets after the parent', () => {
  const { paths, task } = project();
  const plan = planDecomposition(task, body, [task], DEFAULTS)!;
  const applied = applyDecomposition(paths, task, plan);
  assert.equal(applied.childFiles.length, 3);
  for (const file of applied.childFiles) assert.ok(existsSync(file), file);
  const roadmap = readFileSync(paths.roadmap, 'utf8');
  const lines = roadmap.split('\n').filter((l) => /^- \[ \] T01[a-z]/.test(l));
  assert.deepEqual(lines.map((l) => l.match(/T01[a-z]/)![0]), ['T01a', 'T01b', 'T01c']);
});

test('decomposeCommand --apply retires the parent and commits the child tasks', () => {
  const { dir, paths, task } = project();
  const state = loadState(paths);
  state.tasks.T01 = {
    ...newTaskState(task.title),
    status: 'blocked',
    summary: 'too large',
    attempts: 1,
  };
  const code = decomposeCommand(paths, state, [task], DEFAULTS, 'T01', { apply: true, log: silent });
  assert.equal(code, 0);
  assert.equal(state.tasks.T01.status, 'accepted');
  assert.match(state.tasks.T01.summary ?? '', /decomposed into T01a/);
  assert.ok(existsSync(join(paths.tasksDir, '01a-build-the-parser.md')));
  const roadmap = readFileSync(paths.roadmap, 'utf8');
  assert.match(roadmap, /- \[x\].*T01/);
  assert.match(roadmap, /- \[ \] T01a/);
  const log = execFileSync('git', ['-C', dir, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim();
  assert.match(log, /T01: Ship the thing \[decomposed\]/);
});
