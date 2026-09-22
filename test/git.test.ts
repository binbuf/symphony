import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resetCommand } from '../src/commands.js';
import { commitAll, commitPrefix, commitsForTask, currentBranch, guardGitignore, untrackedFiles } from '../src/git.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import { loadState, newTaskState } from '../src/state.js';
import type { Task } from '../src/tasks.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-git-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  return dir;
}

test('untracked ephemeral/secret files are auto-ignored; real work is still committed', () => {
  const dir = repo();
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  writeFileSync(join(dir, 'debug.log'), 'noise');

  const guard = guardGitignore(dir);
  assert.ok(guard.added.includes('node_modules/'), `added=${guard.added.join(',')}`);
  assert.ok(guard.added.includes('.env*'));
  assert.ok(guard.added.includes('*.log'));
  assert.ok(guard.ignored.includes('.env'));
  assert.ok(guard.committed.includes('src/app.js'));

  const outcome = commitAll(dir, 'init');
  assert.equal(outcome.status, 'committed');
  const tracked = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(tracked.includes('src/app.js'));
  assert.ok(!tracked.some((f) => f.startsWith('node_modules/')));
  assert.ok(!tracked.includes('.env'));
  assert.ok(!tracked.includes('debug.log'));
  const ignore = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.match(ignore, /node_modules\//);
  assert.match(ignore, /\.env\*/);
  // Everything that is not ignored has been committed, so nothing untracked remains.
  assert.deepEqual(untrackedFiles(dir), []);
});

test('reset clears task state and, with --revert, undoes the task commits', () => {
  const dir = repo();
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [x] T01 — Do the thing\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init docs']);
  writeFileSync(join(dir, 'thing.txt'), 'done');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'T01: Do the thing [done]']);

  const state = loadState(paths);
  state.tasks.T01 = { ...newTaskState('Do the thing'), status: 'done', attempts: 1 };
  const task: Task = { id: 'T01', num: 1, title: 'Do the thing', phase: 'Phase 1', order: 0, meta: {} };

  const code = resetCommand(paths, state, [task], 'T01', { revert: true, log: silent });
  assert.equal(code, 0);
  assert.equal(state.tasks.T01, undefined);
  assert.match(readFileSync(paths.roadmap, 'utf8'), /\[ \] T01/);
  const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
  assert.match(log, /Revert "T01: Do the thing \[done\]"/);
  // The reverted file is gone from the tree.
  assert.throws(() => readFileSync(join(dir, 'thing.txt')));
});

test('reset without --revert only clears state', () => {
  const dir = repo();
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [~] T01 — Do the thing ⟵ failed\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init docs']);
  writeFileSync(join(dir, 'thing.txt'), 'done');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'T01: Do the thing [failed]']);

  const state = loadState(paths);
  state.tasks.T01 = { ...newTaskState('Do the thing'), status: 'failed', attempts: 1 };
  const task: Task = { id: 'T01', num: 1, title: 'Do the thing', phase: 'Phase 1', order: 0, meta: {} };

  assert.equal(resetCommand(paths, state, [task], 'T01', { revert: false, log: silent }), 0);
  assert.equal(state.tasks.T01, undefined);
  const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
  assert.ok(!/Revert/.test(log));
  assert.ok(readFileSync(join(dir, 'thing.txt'), 'utf8').includes('done'));
});

test('commitPrefix derives the subject prefix from the commit template', () => {
  assert.equal(commitPrefix('{id}: {title} [{status}]', 'T05'), 'T05: ');
  assert.equal(commitPrefix('{id} — {title}', 'T05'), 'T05 — ');
  assert.equal(commitPrefix('{id}', 'T05'), 'T05');
  assert.equal(commitPrefix('task {id}', 'T05'), 'task T05');
  assert.equal(commitPrefix('no id here', 'T05'), undefined);
});

test('commitAll refuses to commit when HEAD moved off the expected branch', () => {
  const dir = repo();
  const start = currentBranch(dir);
  writeFileSync(join(dir, 'a.txt'), 'a');
  execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'sidebranch']);
  const refused = commitAll(dir, 'x', undefined, { expectedBranch: start });
  assert.equal(refused.status, 'failed');
  assert.match(refused.status === 'failed' ? refused.detail : '', /branch changed/);
  assert.deepEqual(execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).trim(), '');
  const allowed = commitAll(dir, 'x', undefined, { expectedBranch: 'sidebranch' });
  assert.equal(allowed.status, 'committed');
});

test('reset --revert finds commits under a custom commit message template', () => {
  const dir = repo();
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [x] T01 — Do the thing\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init docs']);
  writeFileSync(join(dir, 'thing.txt'), 'done');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'T01 — Do the thing [done]']);

  const state = loadState(paths);
  state.tasks.T01 = { ...newTaskState('Do the thing'), status: 'done', attempts: 1 };
  const task: Task = { id: 'T01', num: 1, title: 'Do the thing', phase: 'Phase 1', order: 0, meta: {} };
  assert.deepEqual(commitsForTask(dir, 'T01', commitPrefix('{id} — {title} [{status}]', 'T01')!), execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().split('\n'));

  const code = resetCommand(paths, state, [task], 'T01', { revert: true, log: silent, commitTemplate: '{id} — {title} [{status}]' });
  assert.equal(code, 0);
  const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
  assert.match(log, /Revert "T01 — Do the thing \[done\]"/);
  assert.throws(() => readFileSync(join(dir, 'thing.txt')));
});

test('reset --revert refuses a template that cannot identify the task commits', () => {
  const dir = repo();
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [x] T01 — Do the thing\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  const state = loadState(paths);
  state.tasks.T01 = { ...newTaskState('Do the thing'), status: 'done', attempts: 1 };
  const task: Task = { id: 'T01', num: 1, title: 'Do the thing', phase: 'Phase 1', order: 0, meta: {} };
  assert.throws(() => resetCommand(paths, state, [task], 'T01', { revert: true, log: silent, commitTemplate: 'docs: {title}' }), /does not contain \{id\}/);
});
