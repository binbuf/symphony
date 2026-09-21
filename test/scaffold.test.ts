import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scaffoldDocs } from '../src/commands.js';
import { resolvePaths } from '../src/paths.js';

test('scaffoldDocs creates the design/adr skeleton by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-scaffold-'));
  const paths = resolvePaths(dir);
  scaffoldDocs(paths, { roadmap: true, config: false });
  assert.ok(existsSync(join(paths.designDir, 'README.md')));
  assert.ok(existsSync(join(paths.adrDir, '0000-template.md')));
  assert.ok(existsSync(paths.roadmap));
  assert.ok(existsSync(paths.progress));
});

test('scaffoldDocs with design: false creates tasks/progress/roadmap but no design folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-scaffold-'));
  const paths = resolvePaths(dir);
  scaffoldDocs(paths, { roadmap: true, config: false, design: false });
  assert.equal(existsSync(paths.designDir), false);
  assert.equal(existsSync(paths.adrDir), false);
  assert.ok(existsSync(paths.roadmap));
  assert.ok(existsSync(paths.progress));
  assert.ok(existsSync(join(paths.tasksDir, 'TEMPLATE.md')));
});