import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateResultsPath, readGateResults } from '../src/acceptance.js';
import { DEFAULTS } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import { runTask, type RunContext, type RunFlags } from '../src/runner.js';
import { loadState, type State } from '../src/state.js';
import type { Task } from '../src/tasks.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };
const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false };
const fence = '```';

const claudeResult = (status: string, summary: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: `SYMPHONY_RESULT\nstatus: ${status}\nsummary: ${summary}\nEND_SYMPHONY_RESULT` });

function v2Block(verifyCommand: string): string {
  return [
    `${fence}symphony-acceptance`,
    JSON.stringify({
      version: 2,
      criteria: [
        {
          id: 'tests',
          text: 'Tests pass',
          blocking: true,
          gates: [{ kind: 'verify', command: verifyCommand }],
        },
        {
          id: 'feature',
          text: 'Feature implemented',
          blocking: true,
          gates: [{ kind: 'diff', paths: ['part1.txt'] }],
        },
      ],
    }, null, 2),
    fence,
  ].join('\n');
}

function project(acceptance: string | undefined): { dir: string; paths: ReturnType<typeof resolvePaths>; task: Task } {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-acc-run-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(paths.adrDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — Do the thing → [tasks/01-thing.md](tasks/01-thing.md)\n');
  const taskFile = join(paths.tasksDir, '01-thing.md');
  writeFileSync(taskFile, [
    '# T01 — Do the thing',
    '',
    '## Goal',
    'x',
    '',
    '## Scope',
    '- a',
    '',
    '## Done when',
    '- [ ] tests pass',
    '',
    acceptance ?? '',
    '',
    '## Hand-off',
    '_(tbd)_',
    '',
  ].join('\n'));
  writeFileSync(paths.progress, '# Progress notes\n');

  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'T01.task.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_write', path: 'part1.txt', content: 'the feature' }),
    claudeResult('done', 'the task is done'),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;

  const task: Task = {
    id: 'T01',
    num: 1,
    title: 'Do the thing',
    phase: 'Phase 1',
    order: 0,
    taskFile,
    taskFileRel: 'docs/tasks/01-thing.md',
    meta: { provider: 'fake' },
  };
  return { dir, paths, task };
}

function ctxFor(paths: ReturnType<typeof resolvePaths>, task: Task): { ctx: RunContext; state: State } {
  const state = loadState(paths);
  const config = { ...DEFAULTS, provider: 'fake' as const, maxContinuations: 2, watch: { ...DEFAULTS.watch, enabled: false } };
  return {
    state,
    ctx: { paths, config, cli: {}, flags, log: silent, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [task], state, interrupted: false, abort: new AbortController() },
  };
}

test('a v2 task is accepted only when its verify and diff gates pass at one revision', async () => {
  const { paths, task } = project(v2Block('git --version'));
  const { ctx, state } = ctxFor(paths, task);
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.acceptance?.status, 'accepted');
    assert.equal(state.tasks.T01.verify?.ok, true);
    const results = readGateResults(paths, 'T01');
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === 'pass'));
    assert.equal(new Set(results.map((r) => r.revision.tree)).size, 1, 'all gates use one revision');
    assert.ok(gateResultsPath(paths, 'T01').includes('evidence'));
    assert.ok(results.find((r) => r.gate === 'verify')?.evidence[0]?.path);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a failing v2 verify gate fails the task instead of accepting it', async () => {
  const { paths, task } = project(v2Block('git --definitely-not-a-real-option'));
  const { ctx, state } = ctxFor(paths, task);
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'failed');
    assert.equal(state.tasks.T01.acceptance?.status, 'failed');
    const results = readGateResults(paths, 'T01');
    const verify = results.find((r) => r.gate === 'verify');
    assert.equal(verify?.status, 'fail');
    assert.equal(state.tasks.T01.verify?.ok, false);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('a legacy task keeps the old verify path and has no v2 acceptance record', async () => {
  const { paths, task } = project(undefined);
  const { ctx, state } = ctxFor(paths, task);
  ctx.config = { ...ctx.config, verifyCommand: 'git --version' };
  try {
    const out = await runTask(ctx, task);
    assert.equal(out.status, 'done');
    assert.equal(state.tasks.T01.acceptance, undefined);
    assert.equal(state.tasks.T01.verify?.ok, true);
    assert.equal(readGateResults(paths, 'T01').length, 0);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});
