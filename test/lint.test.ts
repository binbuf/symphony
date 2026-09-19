import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lintDocs, scanCandidates } from '../src/lint.js';
import { resolvePaths } from '../src/paths.js';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-lint-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  writeFileSync(join(dir, '.gitignore'), '.symphony/\n');
  return dir;
}
const codes = (r: ReturnType<typeof lintDocs>, level?: string) => r.findings.filter((f) => !level || f.level === level).map((f) => f.code);

test('valid layout lints clean', () => {
  const dir = repo();
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(paths.adrDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1 — A\n\n- [ ] T01 — First → [tasks/01-first.md](tasks/01-first.md)\n- [ ] T02 — Second\n');
  writeFileSync(join(paths.tasksDir, '01-first.md'), '# T01 — First\n\n## Goal\nx\n\n## Scope\n- [ ] a\n\n## Done when\n- [ ] b\n\n## Hand-off\n_(tbd)_\n');
  writeFileSync(join(paths.tasksDir, '02-second.md'), '# T02\n\n## Goal\nx\n');
  writeFileSync(join(paths.designDir, 'overview.md'), '# Overview\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  const r = lintDocs(paths);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.taskCount, 2);
  assert.ok(codes(r, 'warn').includes('task-sections'));
  assert.ok(!codes(r).includes('gitignore'));
});

test('missing .docs with planning docs elsewhere → docs-missing error + candidates', () => {
  const dir = repo();
  writeFileSync(join(dir, 'ROADMAP.md'), '# plan\n');
  writeFileSync(join(dir, 'PLAN.md'), '# plan\n');
  writeFileSync(join(dir, 'README.md'), '# readme\n');
  mkdirSync(join(dir, 'docs', 'adr'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'architecture.md'), '# arch\n');
  writeFileSync(join(dir, 'docs', 'adr', '001-db.md'), '# adr\n');
  const paths = resolvePaths(dir);
  assert.deepEqual(scanCandidates(paths), ['PLAN.md', 'ROADMAP.md', 'docs/adr/001-db.md', 'docs/architecture.md']);
  const r = lintDocs(paths);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r, 'error'), ['docs-missing']);
  assert.ok(r.findings.find((f) => f.code === 'docs-missing')!.message.includes('PLAN.md'));
});

test('malformed .docs: wrong case, misplaced adr, task-like lines that do not parse, bad filename, broken link', () => {
  const dir = repo();
  const paths = resolvePaths(dir);
  mkdirSync(join(paths.docs, 'adr'), { recursive: true });
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(join(paths.docs, 'Roadmap.md'), '# wrong case\n');
  writeFileSync(paths.roadmap, [
    '# R', '', '## Phase 1', '',
    '- [ ] T01 — Real task → [tasks/01-missing.md](tasks/01-missing.md)',
    '  - [ ] T02 — nested, ignored',
    '1. Task 3: numbered item',
    '### T04 — heading task',
    '- [ ] **T05** bold id',
    '- [ ] T03 — out of order is fine but warned',
    '- [ ] T02 — comes after T03, so the order warning fires',
    '',
  ].join('\n'));
  writeFileSync(join(paths.tasksDir, 'task-one.md'), '# no prefix\n');
  writeFileSync(join(paths.tasksDir, '03-three.md'), '---\nprovider: gemini\n---\n# T03\n## Goal\n## Scope\n## Done when\n## Hand-off\n');
  const r = lintDocs(paths);
  assert.equal(r.ok, false);
  const errs = codes(r, 'error');
  assert.ok(errs.includes('roadmap-case'));
  assert.ok(errs.includes('adr-location'));
  assert.ok(errs.includes('task-link-broken'));
  assert.ok(errs.includes('task-frontmatter'));
  assert.equal(errs.filter((c) => c === 'roadmap-unparsed').length, 4, JSON.stringify(r.findings));
  const warns = codes(r, 'warn');
  assert.ok(warns.includes('roadmap-order'));
  assert.ok(warns.includes('task-filename'));
});

test('empty roadmap and duplicate ids are errors', () => {
  const dir = repo();
  const paths = resolvePaths(dir);
  mkdirSync(paths.docs, { recursive: true });
  writeFileSync(paths.roadmap, '# nothing here\n');
  assert.ok(codes(lintDocs(paths), 'error').includes('roadmap-empty'));
  writeFileSync(paths.roadmap, '- [ ] T01 — a\n- [ ] 1 — b\n');
  assert.ok(codes(lintDocs(paths), 'error').includes('roadmap-parse'));
});
