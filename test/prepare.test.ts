import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import { prepareCommand } from '../src/prepare.js';
import { replanCommand } from '../src/replan.js';
import type { RunContext, RunFlags } from '../src/runner.js';
import { loadState, newTaskState } from '../src/state.js';
import type { Task } from '../src/tasks.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };
const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false };

const claudeResult = (status: string, summary: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: `SYMPHONY_RESULT\nstatus: ${status}\nsummary: ${summary}\nEND_SYMPHONY_RESULT` });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-docs-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  return dir;
}

const TASK_FILE = '# T01 — Do the thing\n\n## Goal\nIt exists.\n\n## Scope\n- a\n\n## Done when\n- tests pass\n\n## Hand-off\n_(filled in)_\n';
const TASK_FILE_2 = '# T02 — Second thing\n\n## Goal\nIt exists too.\n\n## Scope\n- b\n\n## Done when\n- tests pass\n\n## Hand-off\n_(filled in)_\n';

test('prepare converts outside docs with the agent, re-lints clean and commits', async () => {
  const dir = repo();
  const paths = resolvePaths(dir);
  mkdirSync(paths.docs, { recursive: true });
  writeFileSync(join(paths.docs, 'TASKS.md'), '# Tasks\n\n1. Do the thing\n');
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'prepare.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-prepare' }),
    JSON.stringify({ type: 'fake_rm', path: 'docs/TASKS.md' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/ROADMAP.md', content: '# Roadmap\n\n## Phase 1\n- [ ] T01 — Do the thing → [tasks/01-do-the-thing.md](tasks/01-do-the-thing.md)\n' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/tasks/01-do-the-thing.md', content: TASK_FILE }),
    claudeResult('done', 'docs converted'),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;
  const state = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [], state, interrupted: false, abort: new AbortController() };
  try {
    const code = await prepareCommand(ctx, { dryRun: false });
    assert.equal(code, 0);
    assert.ok(existsSync(paths.roadmap));
    assert.match(readFileSync(paths.roadmap, 'utf8'), /T01/);
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(log, /docs: normalise docs for symphony \[prepare\]/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('replan rewrites the plan for a new direction and commits it', async () => {
  const dir = repo();
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(paths.adrDir, { recursive: true });
  writeFileSync(paths.roadmap, '# Roadmap\n\n## Phase 1\n\n- [x] T01 — Do the thing → [tasks/01-thing.md](tasks/01-thing.md)\n');
  writeFileSync(join(paths.tasksDir, '01-thing.md'), TASK_FILE);
  writeFileSync(paths.progress, '# Progress notes\n');
  writeFileSync(join(paths.docs, 'REPLAN.md'), '# Direction\n\nDo it differently: add a second task.\n');
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'replan.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-replan' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/ROADMAP.md', content: '# Roadmap\n\n## Phase 1\n\n- [x] T01 — Do the thing → [tasks/01-thing.md](tasks/01-thing.md)\n- [ ] T02 — Second thing → [tasks/02-second-thing.md](tasks/02-second-thing.md)\n' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/tasks/02-second-thing.md', content: TASK_FILE_2.replace('T01', 'T02') }),
    claudeResult('done', 'plan rewritten'),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;
  const state = loadState(paths);
  state.tasks.T01 = { ...newTaskState('Do the thing'), status: 'done', attempts: 1 };
  const tasks: Task[] = [{ id: 'T01', num: 1, title: 'Do the thing', phase: 'Phase 1', order: 0, taskFile: join(paths.tasksDir, '01-thing.md'), taskFileRel: 'docs/tasks/01-thing.md', meta: {} }];
  const config = { ...DEFAULTS, provider: 'fake' as const };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks, state, interrupted: false, abort: new AbortController() };
  try {
    const code = await replanCommand(ctx, { dryRun: false, allowIdReuse: false, resetState: false });
    assert.equal(code, 0);
    assert.match(readFileSync(paths.roadmap, 'utf8'), /T02 — Second thing/);
    assert.equal(state.tasks.T01?.status, 'done');
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(log, /docs: replan docs \[replan\]/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});