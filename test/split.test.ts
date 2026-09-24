import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.js';
import { DEFAULTS } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import { loadProject } from '../src/project.js';
import { parseRoadmap } from '../src/roadmap.js';
import type { RunContext, RunFlags } from '../src/runner.js';
import { applySplitState, buildSplitPrompt, checkSplit, childIdSequence, childIdsFor, retargetFlags, splitCommand } from '../src/split.js';
import { loadState, newTaskState, type State } from '../src/state.js';
import { discoverTasks, type Task } from '../src/tasks.js';
import { UsageError } from '../src/util.js';

const silent: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };
const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false };
const claudeResult = (status: string, summary: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: `SYMPHONY_RESULT\nstatus: ${status}\nsummary: ${summary}\nEND_SYMPHONY_RESULT` });

function project(roadmap: string, files: Record<string, string> = {}): { dir: string; paths: Paths } {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-split-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(paths.adrDir, { recursive: true });
  writeFileSync(paths.roadmap, roadmap);
  writeFileSync(paths.progress, '# Progress notes\n');
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return { dir, paths };
}

/** Tasks (in roadmap order) plus the parsed roadmap for a roadmap text. */
function planOf(paths: Paths, roadmapText: string): { tasks: Task[]; roadmap: ReturnType<typeof parseRoadmap> } {
  const roadmap = parseRoadmap(roadmapText);
  return { tasks: discoverTasks(paths, roadmap).tasks, roadmap };
}

test('childIdsFor and childIdSequence name the subtasks of a task, one level at a time', () => {
  assert.deepEqual(childIdsFor('T10').slice(0, 3), ['T10a', 'T10b', 'T10c']);
  assert.equal(childIdSequence('T10').length, 26);
  // Ids already used elsewhere are skipped.
  assert.deepEqual(childIdsFor('T5', ['T05a', 'T05c']).slice(0, 3), ['T05b', 'T05d', 'T05e']);
  // A subtask splits into letter+digits ids; a twice-split task has no further room.
  assert.deepEqual(childIdSequence('T10a').slice(0, 2), ['T10a1', 'T10a2']);
  assert.deepEqual(childIdSequence('T10a1'), []);
  assert.deepEqual(childIdsFor('nonsense'), []);
});

test('checkSplit accepts a rewrite that replaces the parent in place', () => {
  const { paths } = project('# R\n', {
    'docs/tasks/02-big.md': '# T02\n',
    'docs/tasks/02a-schema.md': '# T02a\n',
    'docs/tasks/02b-api.md': '# T02b\n',
  });
  const before = planOf(paths, '# R\n\n- [ ] T01 — One\n- [ ] T02 — Big → [tasks/02-big.md](tasks/02-big.md)\n- [ ] T03 — Three\n');
  const after = planOf(paths, '# R\n\n- [ ] T01 — One\n- [ ] T02a — Schema → [tasks/02a-schema.md](tasks/02a-schema.md)\n- [ ] T02b — API → [tasks/02b-api.md](tasks/02b-api.md)\n- [ ] T03 — Three\n');
  const parent = before.tasks[1];
  assert.equal(parent.taskFileRel, 'docs/tasks/02-big.md');
  rmSync(parent.taskFile!); // the splitting session moved the content into the subtasks
  const check = checkSplit({ parent, before: before.tasks, after: after.tasks, roadmap: after.roadmap, sequence: childIdSequence('T02'), paths });
  assert.equal(check.ok, true, check.errors.join('; '));
  assert.deepEqual(check.children.map((c) => c.id), ['T02a', 'T02b']);
});

test('checkSplit rejects a leftover parent, wrong ids, stale bullets and a kept parent file', () => {
  const { paths } = project('# R\n', {
    'docs/tasks/02-big.md': '# T02\n',
    'docs/tasks/02a-schema.md': '# T02a\n',
    'docs/tasks/02b-api.md': '# T02b\n',
  });
  const before = planOf(paths, '# R\n\n- [ ] T01 — One\n- [ ] T02 — Big → [tasks/02-big.md](tasks/02-big.md)\n- [ ] T03 — Three\n');
  const parent = before.tasks[1];
  const errorsFor = (text: string, expected?: string[]) => {
    const after = planOf(paths, text);
    return checkSplit({ parent, before: before.tasks, after: after.tasks, roadmap: after.roadmap, sequence: childIdSequence('T02'), expected, paths });
  };

  const leftover = errorsFor('# R\n\n- [ ] T01 — One\n- [ ] T02 — Big → [tasks/02-big.md](tasks/02-big.md)\n- [ ] T03 — Three\n');
  assert.equal(leftover.ok, false);
  assert.match(leftover.errors.join('; '), /T02's bullet is still in the roadmap/);

  const wrongIds = errorsFor('# R\n\n- [ ] T01 — One\n- [ ] T02b — API → [tasks/02b-api.md](tasks/02b-api.md)\n- [ ] T02c — Extra\n- [ ] T03 — Three\n', ['T02a', 'T02b']);
  assert.equal(wrongIds.ok, false);
  assert.match(wrongIds.errors.join('; '), /must be exactly T02a, T02b/);

  // The children exist but are marked done; a fresh subtask must be pending.
  const stale = errorsFor('# R\n\n- [ ] T01 — One\n- [x] T02a — Schema\n- [ ] T02b — API\n- [ ] T03 — Three\n');
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join('; '), /T02a must be a fresh "- \[ \]" bullet/);

  // The parent's task file was not removed.
  assert.match(errorsFor('# R\n\n- [ ] T01 — One\n- [ ] T02a — Schema\n- [ ] T02b — API\n- [ ] T03 — Three\n').errors.join('; '), /parent task file .*02-big\.md still exists/);

  // The children moved: T03 ended up before them.
  assert.match(errorsFor('# R\n\n- [ ] T01 — One\n- [ ] T03 — Three\n- [ ] T02a — Schema\n- [ ] T02b — API\n').errors.join('; '), /the task before them must stay T01/);
});

test('buildSplitPrompt names the child ids and carries the parent body, with and without guidance', () => {
  const { paths } = project('# R\n', { 'docs/tasks/05-big.md': '# T05 — Big\n\n## Goal\nDo everything at once.\n' });
  const before = planOf(paths, '# R\n\n- [ ] T05 — Big → [tasks/05-big.md](tasks/05-big.md)\n');
  const ctx = {
    paths, config: { ...DEFAULTS, designDocs: false }, cli: {}, flags, log: silent,
    tasks: before.tasks, state: { version: 1, tasks: {} } as State, interrupted: false, abort: new AbortController(),
  } as unknown as RunContext;
  const report = { findings: [], candidates: [] as string[], taskCount: 1, ok: true };

  const prompt = buildSplitPrompt(ctx, before.tasks[0], { sequence: childIdSequence('T05'), expected: ['T05a', 'T05b'], findings: report });
  assert.doesNotMatch(prompt, /\{[a-zA-Z_]\w*\}/);
  assert.match(prompt, /Do everything at once\./);
  assert.match(prompt, /exactly 2 subtask bullets/);
  assert.match(prompt, /T05a, T05b/);
  assert.match(prompt, /- \[ \] T05a — <short imperative title>/);
  assert.doesNotMatch(prompt, /Guidance from the human/);

  const guided = buildSplitPrompt(ctx, before.tasks[0], { sequence: childIdSequence('T05'), note: 'split by layer', findings: report });
  assert.match(guided, /## Guidance from the human \(authoritative\)\nsplit by layer/);
  assert.match(guided, /between 2 and 6 subtask bullets/);
});

test('applySplitState prunes the parent row and the halt on it; retargetFlags follows the subtasks', () => {
  const { paths } = project('# R\n');
  const state: State = {
    version: 1,
    halted: { at: 'x', taskId: 'T02', category: 'attempts', reason: 'too many failures' },
    tasks: { T01: { ...newTaskState('One'), status: 'done' }, T02: { ...newTaskState('Big'), status: 'failed' } },
  };
  applySplitState(paths, state, 'T02');
  assert.equal(state.tasks.T02, undefined);
  assert.equal(state.tasks.T01.status, 'done');
  assert.equal(state.halted, undefined);
  assert.deepEqual(loadState(paths).tasks.T01.status, 'done');

  const run: RunFlags = { only: ['T02', 'T04'], from: 'T02', to: 'T02', retry: true, continueOnFailure: false, dryRun: false, clearHalt: false };
  retargetFlags(run, 'T02', ['T02a', 'T02b']);
  assert.deepEqual(run.only, ['T02a', 'T02b', 'T04']);
  assert.equal(run.from, 'T02a');
  assert.equal(run.to, 'T02b');
  const untouched: RunFlags = { only: ['T03'], from: 'T01', to: 'T03', retry: false, continueOnFailure: false, dryRun: false, clearHalt: false };
  retargetFlags(untouched, 'T02', ['T02a']);
  assert.deepEqual(untouched.only, ['T03']);
  assert.equal(untouched.from, 'T01');
});

test('splitCommand rewrites the task with the agent, reconciles state, and commits the docs change', async () => {
  const { dir, paths } = project(
    '# Roadmap\n\n## Phase 1\n\n- [x] T01 — Done thing\n- [~] T02 — Big thing → [tasks/02-big.md](tasks/02-big.md) ⟵ failed\n- [ ] T03 — Later\n',
    { 'docs/tasks/02-big.md': '# T02 — Big thing\n\n## Goal\ntoo big\n' },
  );
  const child = (id: string, title: string, body: string) => `# ${id} — ${title}\n\n${body}\n`;
  const newRoadmap = '# Roadmap\n\n## Phase 1\n\n- [x] T01 — Done thing\n- [ ] T02a — Schema → [tasks/02a-schema.md](tasks/02a-schema.md)\n- [ ] T02b — API → [tasks/02b-api.md](tasks/02b-api.md)\n- [ ] T03 — Later\n';
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'split-T02.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_rm', path: 'docs/tasks/02-big.md' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/tasks/02a-schema.md', content: child('T02a', 'Schema', '## Goal\nthe schema') }),
    JSON.stringify({ type: 'fake_write', path: 'docs/tasks/02b-api.md', content: child('T02b', 'API', '## Goal\nthe API') }),
    JSON.stringify({ type: 'fake_write', path: 'docs/ROADMAP.md', content: newRoadmap }),
    claudeResult('done', 'T02 → T02a, T02b'),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;

  const loaded = loadProject(paths, silent);
  const state: State = { ...loaded.state, halted: { at: 'x', taskId: 'T02', category: 'attempts', reason: 'failed 3 times' } };
  const ctx: RunContext = {
    paths, config: { ...DEFAULTS, provider: 'fake' }, cli: {}, flags, log: silent,
    roadmap: loaded.roadmap, tasks: loaded.tasks, state, interrupted: false, abort: new AbortController(),
  };
  try {
    assert.equal(state.tasks.T02.status, 'failed');
    const code = await splitCommand(ctx, { id: 'T02', dryRun: false });
    assert.equal(code, 0);
    assert.equal(existsSync(join(paths.tasksDir, '02-big.md')), false);
    assert.ok(existsSync(join(paths.tasksDir, '02a-schema.md')));
    const roadmapText = readFileSync(paths.roadmap, 'utf8');
    assert.doesNotMatch(roadmapText, /T02 — Big thing/);
    assert.match(roadmapText, /- \[ \] T02a — Schema → \[tasks\/02a-schema\.md\]\(tasks\/02a-schema\.md\)/);
    assert.match(roadmapText, /- \[ \] T02b — API/);
    assert.equal(state.tasks.T02, undefined, 'the parent state row is pruned');
    assert.equal(state.halted, undefined, 'the halt on the split task is cleared');
    assert.equal(loadState(paths).tasks.T02, undefined, 'the pruned state is persisted');
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(log, /docs: split T02 into T02a, T02b \[split\]/);
    // The whole rewrite is one commit: nothing else is left dirty.
    assert.equal(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('discoverTasks matches a suffixed id to its file by link or id prefix, and rejects two files per id', () => {
  const { paths } = project('# R\n', {
    'docs/tasks/10-schema.md': '# T10\n',
    'docs/tasks/10a-schema.md': '# T10a\n',
    'docs/tasks/10b.md': '# T10b\n',
  });
  const rm = parseRoadmap('- [ ] T10 — Parent → [tasks/10-nope.md](tasks/10-nope.md)\n- [ ] T10a — Child\n- [ ] T10b — Other\n');
  const { tasks, warnings } = discoverTasks(paths, rm);
  assert.deepEqual(tasks.map((t) => t.id), ['T10', 'T10a', 'T10b']);
  assert.deepEqual(tasks.map((t) => t.suffix), ['', 'a', 'b']);
  // The broken link warns and falls back to the id's filename prefix.
  assert.match(warnings.join('\n'), /linked task file "tasks\/10-nope.md" not found/);
  assert.equal(tasks[0].taskFileRel, 'docs/tasks/10-schema.md');
  assert.equal(tasks[1].taskFileRel, 'docs/tasks/10a-schema.md');
  assert.equal(tasks[2].taskFileRel, 'docs/tasks/10b.md');

  writeFileSync(join(paths.tasksDir, '10b-other.md'), '# y\n');
  assert.throws(() => discoverTasks(paths, rm), /both claim task T10b/);
});

test('splitCommand --dry-run prints the prompt for the subtasks and touches nothing', async () => {
  const { paths } = project('# R\n\n- [ ] T02 — Big → [tasks/02-big.md](tasks/02-big.md)\n', { 'docs/tasks/02-big.md': '# T02 — Big\n\n## Goal\ntoo big\n' });
  const loaded = loadProject(paths, silent);
  const lines: string[] = [];
  const log: Logger = { info() {}, warn() {}, error() {}, plain(l) { lines.push(l); }, banner() {} };
  const ctx: RunContext = {
    paths, config: { ...DEFAULTS, provider: 'fake' }, cli: {}, flags, log,
    roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state, interrupted: false, abort: new AbortController(),
  };
  const before = readFileSync(paths.roadmap, 'utf8');
  assert.equal(await splitCommand(ctx, { id: 'T02', into: 3, dryRun: true }), 0);
  const out = lines.join('\n');
  assert.match(out, /--- split prompt \(/);
  assert.match(out, /exactly 3 subtask bullets/);
  assert.match(out, /T02a, T02b, T02c/);
  assert.equal(readFileSync(paths.roadmap, 'utf8'), before, 'nothing is written in a dry run');
  assert.ok(existsSync(join(paths.tasksDir, '02-big.md')));
});

test('the CLI rejects split without an id and --into outside 2–26', async () => {
  const { paths } = project('# R\n\n- [ ] T02 — Big\n');
  await assert.rejects(main(['split', '--root', paths.root]), (e: unknown) => e instanceof UsageError && /give the task/.test((e as Error).message));
  await assert.rejects(main(['split', 'T02', '--into', '1', '--root', paths.root]), (e: unknown) => e instanceof UsageError && /--into/.test((e as Error).message));
  await assert.rejects(main(['split', 'T02', '--into', 'abc', '--root', paths.root]), (e: unknown) => e instanceof UsageError && /--into/.test((e as Error).message));
});

test('the CLI runs split end to end: one session, validation, and a commit', async () => {
  const { dir, paths } = project('# R\n\n- [ ] T02 — Big → [tasks/02-big.md](tasks/02-big.md)\n- [ ] T03 — Later\n', {
    'docs/tasks/02-big.md': '# T02 — Big\n\n## Goal\ntoo big\n',
  });
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(paths.symphony, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ provider: 'fake' }));
  const newRoadmap = '# R\n\n- [ ] T02a — Schema → [tasks/02a-schema.md](tasks/02a-schema.md)\n- [ ] T02b — API → [tasks/02b-api.md](tasks/02b-api.md)\n- [ ] T03 — Later\n';
  writeFileSync(join(fixtures, 'split-T02.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_rm', path: 'docs/tasks/02-big.md' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/tasks/02a-schema.md', content: '# T02a — Schema\n' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/tasks/02b-api.md', content: '# T02b — API\n' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/ROADMAP.md', content: newRoadmap }),
    claudeResult('done', 'T02 → T02a, T02b'),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;
  try {
    const code = await main(['split', 'T02', '--into', '2', '--root', paths.root]);
    assert.equal(code, 0);
    const roadmap = readFileSync(paths.roadmap, 'utf8');
    assert.doesNotMatch(roadmap, /T02 — Big/);
    assert.match(roadmap, /- \[ \] T02a — Schema/);
    assert.match(roadmap, /- \[ \] T02b — API/);
    assert.match(execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' }), /docs: split T02 into T02a, T02b \[split\]/);
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('splitCommand refuses a finished task, a task with no free ids, and --into out of range', async () => {
  const { paths } = project('# R\n\n- [ ] T02 — Big\n- [ ] T02a — Existing\n', { 'docs/tasks/02a.md': '# T02a\n' });
  const loaded = loadProject(paths, silent);
  const ctx: RunContext = {
    paths, config: { ...DEFAULTS, provider: 'fake' }, cli: {}, flags, log: silent,
    roadmap: loaded.roadmap, tasks: loaded.tasks, state: { version: 1, tasks: { T02: { ...newTaskState('Big'), status: 'accepted' } } }, interrupted: false, abort: new AbortController(),
  };
  await assert.rejects(splitCommand(ctx, { id: 'T02', dryRun: false }), /accepted/);
  await assert.rejects(splitCommand(ctx, { id: 'T99', dryRun: false }), /no such task/);

  // A twice-split id has no room for children.
  ctx.tasks = [{ id: 'T02a1', num: 2, suffix: 'a1', title: 'Deep', phase: 'P', order: 0, meta: {} }];
  ctx.state = { version: 1, tasks: {} };
  await assert.rejects(splitCommand(ctx, { id: 'T02a1', dryRun: false }), /sub-split/);

  // --into outside 2–26 is a usage error before anything runs.
  ctx.tasks = [{ id: 'T02', num: 2, title: 'Big', phase: 'P', order: 0, meta: {} }];
  await assert.rejects(splitCommand(ctx, { id: 'T02', into: 1, dryRun: false }), /--into/);
});
