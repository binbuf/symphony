import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolvePaths } from '../src/paths.js';
import { checkboxSignature, computeAttemptDelta, isStalled, metricImproved, metricPlateau, parseMetric } from '../src/progress.js';

test('checkboxSignature records acceptance state in order', () => {
  const body = [
    '## Done when',
    '- [x] first',
    '- [ ] second',
    '- [X] third',
    'prose',
    '- [ ] fourth',
  ].join('\n');
  assert.equal(checkboxSignature(body), '1010');
  assert.equal(checkboxSignature('no boxes here'), '');
});

test('isStalled fires only on the configured number of consecutive repeats', () => {
  assert.equal(isStalled([], 'a', 1), false, 'no history cannot be a stall');
  assert.equal(isStalled(['a'], 'a', 1), true, 'one repeat at threshold 1');
  assert.equal(isStalled(['a'], 'b', 1), false);
  assert.equal(isStalled(['a', 'a'], 'a', 2), true);
  assert.equal(isStalled(['a', 'b'], 'a', 2), false);
  assert.equal(isStalled(['a', 'a'], 'a', 0), false, 'disabled never stalls');
  assert.equal(isStalled(['b', 'a', 'a'], 'a', 2), true);
});

test('the objective metric is parsed, compared by direction, and plateaued', () => {
  assert.equal(parseMetric('routes certified: 12\nfixtures: 0'), 0, 'the last number wins');
  assert.equal(parseMetric('count=7'), 7);
  assert.equal(parseMetric('no number here'), undefined);

  assert.equal(metricImproved(3, 4, 'increase'), true);
  assert.equal(metricImproved(4, 4, 'increase'), false);
  assert.equal(metricImproved(4, 3, 'decrease'), true);
  assert.equal(metricImproved(0, 1, 'nonzero'), true);
  assert.equal(metricImproved(1, 2, 'nonzero'), false, 'already nonzero is not new progress');

  assert.equal(metricPlateau([1, 1, 1], 'increase', 1), true);
  assert.equal(metricPlateau([1, 2, 2], 'increase', 1), true, 'the last pair did not improve');
  assert.equal(metricPlateau([1, 2, 3], 'increase', 1), false);
  assert.equal(metricPlateau([1], 'increase', 1), false, 'one reading cannot plateau');
  assert.equal(metricPlateau([undefined, undefined], 'increase', 1), false);
});

test('a metric reading is folded into the fingerprint', () => {
  const { paths, taskFile } = repo();
  try {
    const a = computeAttemptDelta({ paths, attempt: 1, taskFile, metric: 1 });
    const b = computeAttemptDelta({ paths, attempt: 2, taskFile, metric: 2 });
    assert.notEqual(a.fingerprint, b.fingerprint);
    assert.equal(a.metric, 1);
    assert.match(a.signals.join(' '), /metric 1/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

function repo(): { dir: string; paths: ReturnType<typeof resolvePaths>; taskFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-progress-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'init']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  const taskFile = join(paths.tasksDir, '01-thing.md');
  writeFileSync(taskFile, '# T01 — thing\n\n## Done when\n- [ ] done\n');
  writeFileSync(paths.roadmap, '# R\n\n- [ ] T01 — thing → [tasks/01-thing.md](tasks/01-thing.md)\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  return { dir, paths, taskFile };
}

test('an unchanged worktree keeps the same fingerprint; real changes move it', () => {
  const { dir, paths, taskFile } = repo();
  try {
    const base = computeAttemptDelta({ paths, attempt: 1, taskFile });
    const again = computeAttemptDelta({ paths, attempt: 2, taskFile });
    assert.equal(base.fingerprint, again.fingerprint);
    assert.ok(isStalled([base.fingerprint], again.fingerprint, 1), 'no-op attempt is a stall');

    writeFileSync(join(dir, 'feature.ts'), 'export const x = 1;\n');
    const changed = computeAttemptDelta({ paths, attempt: 2, taskFile });
    assert.notEqual(base.fingerprint, changed.fingerprint);
    assert.ok(!isStalled([base.fingerprint], changed.fingerprint, 1));
    assert.match(changed.signals.join(' '), /worktree change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('harness-owned rewrites (PROGRESS.md, ROADMAP.md, logs) never count as progress', () => {
  const { paths, taskFile } = repo();
  try {
    const base = computeAttemptDelta({ paths, attempt: 1, taskFile });
    writeFileSync(paths.progress, '# Progress notes\n\n## T01 — thing\nonly a note\n');
    writeFileSync(join(paths.logsDir, 'T01.md'), 'log\n');
    const noteOnly = computeAttemptDelta({ paths, attempt: 2, taskFile });
    assert.equal(base.fingerprint, noteOnly.fingerprint, 'a notes-only attempt is not progress');
  } finally {
    rmSync(join(paths.root), { recursive: true, force: true });
  }
});

test('ticking an acceptance checkbox counts as progress', () => {
  const { paths, taskFile } = repo();
  try {
    const base = computeAttemptDelta({ paths, attempt: 1, taskFile });
    writeFileSync(taskFile, '# T01 — thing\n\n## Done when\n- [x] done\n');
    const ticked = computeAttemptDelta({ paths, attempt: 2, taskFile });
    assert.notEqual(base.fingerprint, ticked.fingerprint);
    assert.match(ticked.signals.join(' '), /checkboxes 1\/1/);
  } finally {
    rmSync(join(paths.root), { recursive: true, force: true });
  }
});
