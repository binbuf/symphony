import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { parseAcceptance } from '../src/graph.js';
import { resolvePaths } from '../src/paths.js';
import { createRemainderTask } from '../src/remainder.js';
import { parseRoadmap } from '../src/roadmap.js';
import type { Task } from '../src/tasks.js';

function project(parentId = 'T01', suffix = ''): { dir: string; paths: ReturnType<typeof resolvePaths>; parent: Task } {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-remainder-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  const num = 1;
  const file = join(paths.tasksDir, `01${suffix}-thing.md`);
  writeFileSync(file, `# ${parentId} — Do the thing\n`);
  writeFileSync(paths.roadmap, `# R\n\n- [ ] ${parentId} — Do the thing → [tasks/01${suffix}-thing.md](tasks/01${suffix}-thing.md)\n- [ ] T02 — dependent on the parent\n`);
  writeFileSync(paths.progress, '# Progress notes\n');
  const parent: Task = { id: parentId, num, suffix, title: 'Do the thing', phase: 'P', order: 0, taskFile: file, taskFileRel: `docs/tasks/01${suffix}-thing.md`, meta: {} };
  return { dir, paths, parent };
}

const deferredOf = (body: string) => parseAcceptance(body).filter((a) => !a.checked);

test('createRemainderTask writes a blocking child and inserts it before the parent dependents', () => {
  const { dir, paths, parent } = project();
  try {
    const dependentFile = join(paths.tasksDir, '02-dependent.md');
    writeFileSync(dependentFile, '---\ndependsOn: T01\n---\n# T02 — dependent\n');
    const dependent: Task = { id: 'T02', num: 2, suffix: '', title: 'dependent on the parent', phase: 'P', order: 1, taskFile: dependentFile, meta: {} };

    const deferred = deferredOf('- [x] core\n- [ ] in-game sfx [deferrable: unity-audio]\n- [ ] docs [deferrable]\n');
    const result = createRemainderTask(paths, parent, deferred, [parent, dependent], DEFAULTS, [dependent]);
    assert.ok(result, 'a remainder ticket is created');
    assert.equal(result!.id, 'T01a');
    assert.ok(existsSync(result!.taskFile), 'the child task file exists');
    assert.deepEqual(result!.gatedOn, ['unity-audio']);
    assert.deepEqual(result!.dependentsPatched, ['T02']);
    assert.match(readFileSync(dependentFile, 'utf8'), /dependsOn: T01, T01a/, 'the dependent now waits on the remainder');

    const body = readFileSync(result!.taskFile, 'utf8');
    assert.match(body, /- \[ \] in-game sfx/);
    assert.match(body, /needs unity-audio/);
    assert.ok(!/deferrable/.test(body), 'the remainder items are blocking in the child, so it cannot re-defer itself into a loop');

    const ids = parseRoadmap(readFileSync(paths.roadmap, 'utf8')).bullets.map((b) => b.id);
    assert.deepEqual(ids, ['T01', 'T01a', 'T02'], 'the remainder sits immediately after its parent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createRemainderTask resolves a named capability to an existing prerequisite ticket', () => {
  const { dir, paths, parent } = project();
  try {
    const prereq: Task = { id: 'T05', num: 5, suffix: '', title: 'Unity Audio', phase: 'P', order: 1, meta: {} };
    const deferred = deferredOf('- [ ] sfx [deferrable: unity-audio]\n');
    const result = createRemainderTask(paths, parent, deferred, [parent, prereq], DEFAULTS);
    assert.deepEqual(result!.dependsOn, ['T05']);
    assert.match(readFileSync(result!.taskFile, 'utf8'), /dependsOn: T05/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createRemainderTask honours the split-depth ceiling and the free-id bound', () => {
  const { dir, paths, parent } = project('T01a', 'a');
  try {
    const deferred = deferredOf('- [ ] still gated [deferrable: cap]\n');
    const bounded = { ...DEFAULTS, ceiling: { ...DEFAULTS.ceiling, maxSplitDepth: 1 } };
    assert.equal(createRemainderTask(paths, parent, deferred, [parent], bounded), undefined, 'depth 2 exceeds maxSplitDepth 1');

    const taken = [parent, ...Array.from({ length: 99 }, (_v, i) => ({ ...parent, id: `T01a${i + 1}` }))];
    assert.equal(createRemainderTask(paths, parent, deferred, taken as Task[], DEFAULTS), undefined, 'no free child id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});