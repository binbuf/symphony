import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import { runTask, type RunContext, type RunFlags } from '../src/runner.js';
import { loadState, type State } from '../src/state.js';
import type { Task } from '../src/tasks.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };
const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false };

const claudeResult = (status: string, summary: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: `SYMPHONY_RESULT\nstatus: ${status}\nsummary: ${summary}\nEND_SYMPHONY_RESULT` });

function project(): { dir: string; paths: ReturnType<typeof resolvePaths>; task: Task } {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-run-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(paths.adrDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — Do the thing → [tasks/01-thing.md](tasks/01-thing.md)\n');
  writeFileSync(join(paths.tasksDir, '01-thing.md'), '# T01 — Do the thing\n\n## Goal\nx\n\n## Scope\n- a\n\n## Done when\n- tests pass\n\n## Hand-off\n_(tbd)_\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_write', path: 'part1.txt', content: 'part 1' }),
    claudeResult('continue', 'first half done'),
  ].join('\n') + '\n');
  writeFileSync(join(fixtures, 'T01.continue.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    JSON.stringify({ type: 'fake_write', path: 'part2.txt', content: 'part 2' }),
    claudeResult('done', 'all done'),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;
  const task: Task = { id: 'T01', num: 1, title: 'Do the thing', phase: 'Phase 1', order: 0, meta: { provider: 'fake' } };
  return { dir, paths, task };
}

test('a task that reports continue is re-run in a fresh session until done, committing each slice', async () => {
  const { dir, paths, task } = project();
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxContinuations: 3 };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.status, 'done');
    assert.equal(state.tasks.T01.attempts, 2);
    assert.ok(readFileSync(join(dir, 'part1.txt'), 'utf8').includes('part 1'));
    assert.ok(readFileSync(join(dir, 'part2.txt'), 'utf8').includes('part 2'));
    assert.match(readFileSync(paths.roadmap, 'utf8'), /\[x\] T01/);
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(log, /T01: Do the thing \[continue\]/);
    assert.match(log, /T01: Do the thing \[done\]/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('continuation is bounded by maxContinuations and ends failed', async () => {
  const { dir, paths, task } = project();
  // Both the first and every continuation session report continue, so the bound is reached.
  writeFileSync(join(dir, 'fixtures', 'T01.continue.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    claudeResult('continue', 'still not finished'),
  ].join('\n') + '\n');
  const state: State = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxContinuations: 1, nudge: false };
  const ctx: RunContext = { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'failed');
    assert.equal(state.tasks.T01.status, 'failed');
    assert.match(state.tasks.T01.summary ?? '', /continuation/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});
