import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalId, parseRoadmap, patchRoadmapFile, renderBulletLine, statusFromMarkers } from '../src/roadmap.js';

const SAMPLE = `# Roadmap

Examples (indented, must be ignored):

    - [ ] T99 — not a task

\`\`\`
- [ ] T98 — inside a fence, not a task
\`\`\`

## Phase 1 — Foundation

- [ ] T01 — Scaffold repo → [tasks/01-scaffold-repo.md](tasks/01-scaffold-repo.md)
- [x] T02 — Add CI
- [~] 3. Set up database ⟵ failed
- 2 servers are needed (prose, not a task)
- T4 Write docs
  - [ ] T05 — sub-bullet, ignored

## Phase 2 — Features

- [x] T06 — [Search endpoint](tasks/06-search.md) ⟵ accepted
`;

test('parseRoadmap finds tasks, normalises ids, keeps phases and links', () => {
  const rm = parseRoadmap(SAMPLE);
  assert.deepEqual(rm.bullets.map((b) => b.id), ['T01', 'T02', 'T03', 'T04', 'T06']);
  const [t1, t2, t3, t4, t6] = rm.bullets;
  assert.equal(t1.title, 'Scaffold repo');
  assert.equal(t1.link, 'tasks/01-scaffold-repo.md');
  assert.equal(t1.phase, 'Phase 1 — Foundation');
  assert.equal(t1.check, ' ');
  assert.equal(t2.check, 'x');
  assert.equal(t3.check, '~');
  assert.equal(t3.tag, 'failed');
  assert.equal(t3.title, 'Set up database');
  assert.equal(t4.title, 'Write docs');
  assert.equal(t6.title, 'Search endpoint');
  assert.equal(t6.link, 'tasks/06-search.md');
  assert.equal(t6.phase, 'Phase 2 — Features');
  assert.equal(t6.tag, 'accepted');
});

test('statusFromMarkers maps [x]/[~]/tags', () => {
  const rm = parseRoadmap(SAMPLE);
  assert.deepEqual(rm.bullets.map(statusFromMarkers), ['pending', 'done', 'failed', 'pending', 'accepted']);
  const tilde = parseRoadmap('- [~] T07 — Unfinished, no tag\n').bullets[0];
  assert.equal(statusFromMarkers(tilde), 'failed');
});

test('canonicalId accepts T5, 5, 05, T05', () => {
  for (const s of ['T5', '5', '05', 'T05', ' t05 ']) assert.equal(canonicalId(s), 'T05');
  assert.equal(canonicalId('T100'), 'T100');
  assert.equal(canonicalId('foo'), undefined);
});

test('duplicate ids throw', () => {
  assert.throws(() => parseRoadmap('- [ ] T01 — a\n- [ ] 01 — b\n'), /T01 appears twice/);
});

test('renderBulletLine produces harness markers', () => {
  const b = parseRoadmap('- [ ] T01 — Scaffold repo → [tasks/01.md](tasks/01.md)\n').bullets[0];
  assert.equal(renderBulletLine(b, 'done'), '- [x] T01 — Scaffold repo → [tasks/01.md](tasks/01.md)');
  assert.equal(renderBulletLine(b, 'running'), '- [ ] T01 — Scaffold repo → [tasks/01.md](tasks/01.md)'.replace('[ ]', '[~]') + ' ⟵ running');
  assert.equal(renderBulletLine(b, 'blocked'), '- [~] T01 — Scaffold repo → [tasks/01.md](tasks/01.md) ⟵ blocked');
  assert.equal(renderBulletLine(b, 'accepted'), '- [x] T01 — Scaffold repo → [tasks/01.md](tasks/01.md) ⟵ accepted');
  assert.equal(renderBulletLine(b, 'pending'), '- [ ] T01 — Scaffold repo → [tasks/01.md](tasks/01.md)');
  const noBox = parseRoadmap('* T02 — Title ⟵ failed\n').bullets[0];
  assert.equal(renderBulletLine(noBox, 'done'), '* [x] T02 — Title');
});

test('patchRoadmapFile rewrites one line and preserves every other byte, CRLF and trailing newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-roadmap-'));
  const path = join(dir, 'ROADMAP.md');
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  writeFileSync(path, crlf);
  assert.equal(patchRoadmapFile(path, 'T01', 'done'), 'patched');
  const after = readFileSync(path, 'utf8');
  assert.ok(after.includes('\r\n'));
  assert.ok(after.endsWith('\r\n'));
  const before = crlf.split('\r\n');
  const now = after.split('\r\n');
  assert.equal(before.length, now.length);
  const changed = before.map((l, i) => (l === now[i] ? -1 : i)).filter((i) => i >= 0);
  assert.deepEqual(changed.length, 1);
  assert.equal(now[changed[0]], '- [x] T01 — Scaffold repo → [tasks/01-scaffold-repo.md](tasks/01-scaffold-repo.md)');
  assert.equal(patchRoadmapFile(path, 'T01', 'done'), 'unchanged');
  assert.equal(patchRoadmapFile(path, 'T42', 'done'), 'missing');
  // no trailing newline is preserved too
  writeFileSync(path, '- [ ] T01 — A');
  patchRoadmapFile(path, 'T01', 'failed');
  assert.equal(readFileSync(path, 'utf8'), '- [~] T01 — A ⟵ failed');
});
