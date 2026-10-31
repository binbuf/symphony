import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  appendGateResult,
  decideAcceptance,
  parseAcceptanceSpec,
  readGateResults,
  type AcceptanceSpec,
  type GateResult,
} from '../src/acceptance.js';
import { changedFilesSince, worktreeRevision } from '../src/git.js';
import { resolvePaths } from '../src/paths.js';

const fence = '```';
function taskBody(block: unknown): string {
  return `# T01 — Test\n\n## Goal\nx\n\n## Done when\n- [ ] tests pass\n\n${fence}symphony-acceptance\n${JSON.stringify(block, null, 2)}\n${fence}\n\n## Hand-off\n_(tbd)_\n`;
}

function spec(criteria: AcceptanceSpec['criteria']): AcceptanceSpec {
  return { version: 2, criteria };
}

function result(overrides: Partial<GateResult> & Pick<GateResult, 'criterionId' | 'gate' | 'status'>): GateResult {
  return {
    revision: { tree: 'tree-a' },
    evidence: [],
    evaluator: { kind: 'harness', version: 'acceptance-v1', configRevision: 'cfg' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('a task without a symphony-acceptance block keeps the legacy contract', () => {
  const parsed = parseAcceptanceSpec('# T01\n\n## Done when\n- [ ] tests pass\n');
  assert.equal(parsed.legacy, true);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.spec, undefined);
});

test('a v2 block parses explicit criteria, ids and gates', () => {
  const parsed = parseAcceptanceSpec(taskBody({
    version: 2,
    criteria: [
      {
        id: 'tests',
        text: 'Tests pass',
        blocking: true,
        gates: [{ kind: 'verify', command: 'npm test', timeoutMin: 10 }],
      },
      {
        id: 'feature',
        text: 'Feature implemented',
        blocking: true,
        gates: [{ kind: 'diff', paths: ['src/', 'test'] }],
      },
    ],
  }));
  assert.equal(parsed.legacy, false);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.spec?.version, 2);
  assert.equal(parsed.spec?.criteria.length, 2);
  assert.equal(parsed.spec?.criteria[0].id, 'tests');
  assert.equal(parsed.spec?.criteria[1].gates[0].kind, 'diff');
});

test('a malformed v2 block reports every contract error', () => {
  const parsed = parseAcceptanceSpec(taskBody({
    version: 2,
    criteria: [
      { id: 'dup', text: '', gates: [{ kind: 'verify' }] },
      { id: 'dup', text: 'duplicate', gates: [{ kind: 'metric' }] },
      { id: 'bad id', text: 'bad id', gates: [{ kind: 'diff' }] },
    ],
  }));
  assert.equal(parsed.legacy, false);
  assert.equal(parsed.spec, undefined);
  assert.ok(parsed.errors.some((e) => /id/.test(e)));
  assert.ok(parsed.errors.some((e) => /text/.test(e)));
  assert.ok(parsed.errors.some((e) => /command is required/.test(e)));
  assert.ok(parsed.errors.some((e) => /not supported/.test(e)));
  assert.ok(parsed.errors.some((e) => /duplicated/.test(e)));
});

test('acceptance requires every blocking gate to pass at the exact revision', () => {
  const s = spec([
    { id: 'feature', text: 'Feature', blocking: true, gates: [{ kind: 'diff' }] },
    { id: 'tests', text: 'Tests', blocking: true, gates: [{ kind: 'verify', command: 'npm test' }] },
  ]);
  const pass = [
    result({ criterionId: 'feature', gate: 'diff', status: 'pass', revision: { tree: 'tree-a' } }),
    result({ criterionId: 'tests', gate: 'verify', status: 'pass', revision: { tree: 'tree-a' } }),
  ];
  assert.equal(decideAcceptance(s, pass, 'tree-a').status, 'accepted');
  const stale = decideAcceptance(s, pass, 'tree-b');
  assert.equal(stale.status, 'inconclusive');
  assert.equal(stale.accepted, false);
  assert.ok(stale.reasons.some((r) => /stale evidence/.test(r)));
  const failed = decideAcceptance(s, [
    pass[0],
    result({ criterionId: 'tests', gate: 'verify', status: 'fail', revision: { tree: 'tree-a' } }),
  ], 'tree-a');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.accepted, false);
});

test('a non-blocking failure does not block acceptance', () => {
  const s = spec([
    { id: 'tests', text: 'Tests', blocking: true, gates: [{ kind: 'verify', command: 'npm test' }] },
    { id: 'docs', text: 'Docs', blocking: false, gates: [{ kind: 'diff' }] },
  ]);
  const decision = decideAcceptance(s, [
    result({ criterionId: 'tests', gate: 'verify', status: 'pass', revision: { tree: 't' } }),
    result({ criterionId: 'docs', gate: 'diff', status: 'fail', revision: { tree: 't' } }),
  ], 't');
  assert.equal(decision.status, 'accepted');
  assert.equal(decision.criteria.find((c) => c.id === 'docs')?.status, 'fail');
});

test('gate results are append-only and readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-acceptance-'));
  const paths = resolvePaths(dir);
  const r = result({ criterionId: 'tests', gate: 'verify', status: 'pass' });
  appendGateResult(paths, 'T01', r);
  appendGateResult(paths, 'T01', { ...r, status: 'fail' });
  const read = readGateResults(paths, 'T01');
  assert.equal(read.length, 2);
  assert.equal(read[0].status, 'pass');
  assert.equal(read[1].status, 'fail');
});

test('the worktree revision includes untracked files without changing the worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-revision-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  writeFileSync(join(dir, 'a.txt'), 'a');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  const clean = worktreeRevision(dir);
  assert.equal(clean?.dirty, false);

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'new.ts'), 'export const x = 1;');
  const dirty = worktreeRevision(dir);
  assert.equal(dirty?.dirty, true);
  assert.notEqual(dirty?.tree, clean?.tree);
  assert.match(execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }), /src\/new\.ts/);

  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'add']);
  const committed = worktreeRevision(dir);
  const headTree = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  assert.equal(committed?.tree, headTree);
});

test('harness-owned files can be excluded from the acceptance revision and diff evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-revision-exclude-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'ROADMAP.md'), '# roadmap\n');
  writeFileSync(join(dir, 'src.ts'), 'export const x = 1;\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  const base = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const before = worktreeRevision(dir, ['docs/ROADMAP.md'])?.tree;

  writeFileSync(join(dir, 'docs', 'ROADMAP.md'), '# roadmap changed by the harness\n');
  assert.equal(worktreeRevision(dir, ['docs/ROADMAP.md'])?.tree, before);
  assert.deepEqual(changedFilesSince(dir, base, ['docs/ROADMAP.md']), []);

  writeFileSync(join(dir, 'src.ts'), 'export const x = 2;\n');
  assert.deepEqual(changedFilesSince(dir, base, ['docs/ROADMAP.md']), ['src.ts']);
});
