import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  appendApproval,
  appendGateResult,
  criterionEvidenceHash,
  decideAcceptance,
  evaluateAcceptance,
  parseAcceptanceSpec,
  readGateResults,
  type AcceptanceSpec,
  type GateResult,
} from '../src/acceptance.js';
import { DEFAULTS } from '../src/config.js';
import { changedFilesSince, worktreeRevision } from '../src/git.js';
import { resolvePaths } from '../src/paths.js';
import type { Task } from '../src/tasks.js';
import { runVerify } from '../src/verify.js';

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
      { id: 'dup', text: 'duplicate', gates: [{ kind: 'semantic' }] },
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

function task(): Task {
  return { id: 'T01', num: 1, title: 't', phase: 'p', order: 0, meta: {} };
}

function gateSpec(block: unknown): AcceptanceSpec {
  const parsed = parseAcceptanceSpec(taskBody(block));
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.spec);
  return parsed.spec;
}

test('metric gate parses parser, path, operator, target, samples, aggregate and warmup', () => {
  const parsed = parseAcceptanceSpec(taskBody({
    version: 2,
    criteria: [{
      id: 'perf',
      text: 'Performance',
      gates: [{
        kind: 'metric',
        command: 'node bench.js',
        parser: 'json',
        metric: 'results.0.score',
        operator: '>=',
        target: 10,
        samples: 3,
        aggregate: 'median',
        warmup: 1,
        timeoutMin: 2,
      }],
    }],
  }));
  assert.deepEqual(parsed.errors, []);
  const gate = parsed.spec!.criteria[0].gates[0];
  assert.equal(gate.kind, 'metric');
  assert.equal(gate.parser, 'json');
  assert.equal(gate.metric, 'results.0.score');
  assert.equal(gate.operator, '>=');
  assert.equal(gate.target, 10);
  assert.equal(gate.samples, 3);
  assert.equal(gate.aggregate, 'median');
  assert.equal(gate.warmup, 1);
  assert.equal(gate.timeoutMin, 2);
});

test('visual and human gates parse their explicit fields', () => {
  const parsed = parseAcceptanceSpec(taskBody({
    version: 2,
    criteria: [
      {
        id: 'look',
        text: 'Looks right',
        gates: [{ kind: 'visual-regression', capture: 'shot {actual}', compare: 'diff {baseline} {actual}', baseline: 'base/home.png', threshold: 0.01 }],
      },
      {
        id: 'signoff',
        text: 'Human sign-off',
        gates: [{ kind: 'human', approver: 'dan' }],
      },
      {
        id: 'meaning',
        text: 'Reads correctly',
        gates: [{ kind: 'visual-semantic', image: 'shot.png', prompt: 'The banner is green' }],
      },
    ],
  }));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.spec!.criteria[0].gates[0].threshold, 0.01);
  assert.equal(parsed.spec!.criteria[1].gates[0].approver, 'dan');
  assert.equal(parsed.spec!.criteria[2].gates[0].prompt, 'The banner is green');
});

test('metric gate samples, ignores warmup, aggregates and compares to its target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-metric-'));
  const paths = resolvePaths(dir);
  const spec = gateSpec({
    version: 2,
    criteria: [{
      id: 'perf',
      text: 'Fast enough',
      gates: [{ kind: 'metric', command: 'node bench.js', operator: '>=', target: 10, samples: 3, aggregate: 'median', warmup: 1 }],
    }],
  });
  const outputs = [1, 5, 20, 30];
  let call = 0;
  const { decision, results } = await evaluateAcceptance({
    paths,
    task: task(),
    spec,
    config: DEFAULTS,
    revision: { tree: 'tree-a' },
    runVerify: () => ({ ok: true, code: 0, output: `score: ${outputs[call++]}` }),
    changedFiles: () => [],
  });
  assert.equal(decision.status, 'accepted');
  const metric = results.find((r) => r.gate === 'metric')!;
  assert.equal(metric.status, 'pass');
  assert.equal(metric.value, 20);
  assert.deepEqual(metric.samples, [5, 20, 30]);
});

test('a metric below target fails, while unusable samples are inconclusive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-metric-fail-'));
  const paths = resolvePaths(dir);
  const spec = gateSpec({
    version: 2,
    criteria: [{
      id: 'perf',
      text: 'Fast enough',
      gates: [{ kind: 'metric', command: 'bench', operator: '>=', target: 10, samples: 2, aggregate: 'max' }],
    }],
  });
  const low = await evaluateAcceptance({
    paths,
    task: task(),
    spec,
    config: DEFAULTS,
    revision: { tree: 'tree-a' },
    runVerify: () => ({ ok: true, code: 0, output: '2\n4' }),
    changedFiles: () => [],
  });
  assert.equal(low.decision.status, 'failed');
  assert.equal(low.results[0].status, 'fail');

  const missing = await evaluateAcceptance({
    paths,
    task: task(),
    spec,
    config: DEFAULTS,
    revision: { tree: 'tree-a' },
    runVerify: () => ({ ok: true, code: 0, output: 'no number here' }),
    changedFiles: () => [],
  });
  assert.equal(missing.decision.status, 'inconclusive');
  assert.equal(missing.results.find((r) => r.gate === 'metric')!.status, 'inconclusive');
});

test('metric evidence acquisition is retried before it is called inconclusive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-metric-retry-'));
  const paths = resolvePaths(dir);
  const spec = gateSpec({
    version: 2,
    criteria: [{
      id: 'perf',
      text: 'Fast enough',
      gates: [{ kind: 'metric', command: 'bench', operator: '>=', target: 1, samples: 1 }],
    }],
  });
  let calls = 0;
  const { decision, results } = await evaluateAcceptance({
    paths,
    task: task(),
    spec,
    config: DEFAULTS,
    revision: { tree: 'tree-a' },
    verifyRetries: 2,
    runVerify: () => {
      calls += 1;
      return calls < 3
        ? { ok: false, code: null, output: 'temporary failure' }
        : { ok: true, code: 0, output: '42' };
    },
    changedFiles: () => [],
  });
  assert.equal(calls, 3);
  assert.equal(decision.status, 'accepted');
  assert.equal(results[0].status, 'pass');
});

test('visual regression compares against a baseline and reports missing evidence as inconclusive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-visual-'));
  const paths = resolvePaths(dir);
  writeFileSync(join(dir, 'baseline.png'), 'baseline');
  const capture = `node -e "require('node:fs').writeFileSync(process.env.SYMPHONY_VISUAL_ACTUAL,'shot')"`;
  const spec = (compare: string) => gateSpec({
    version: 2,
    criteria: [{
      id: 'look',
      text: 'Looks right',
      gates: [{ kind: 'visual-regression', capture, compare, baseline: 'baseline.png', threshold: 0.01 }],
    }],
  });

  const pass = await evaluateAcceptance({
    paths, task: task(), spec: spec(`node -e "process.exit(0)"`), config: DEFAULTS,
    revision: { tree: 'tree-a' }, runVerify: (command, timeoutMs, env) => runVerify(dir, command, timeoutMs, env), changedFiles: () => [],
  });
  assert.equal(pass.decision.status, 'accepted');
  assert.ok(pass.results[0].evidence.some((e) => e.kind === 'image'));

  const fail = await evaluateAcceptance({
    paths, task: task(), spec: spec(`node -e "process.exit(1)"`), config: DEFAULTS,
    revision: { tree: 'tree-a' }, runVerify: (command, timeoutMs, env) => runVerify(dir, command, timeoutMs, env), changedFiles: () => [],
  });
  assert.equal(fail.decision.status, 'failed');

  const missing = await evaluateAcceptance({
    paths, task: task(), spec: gateSpec({
      version: 2,
      criteria: [{ id: 'look', text: 'Looks right', gates: [{ kind: 'visual-regression', capture, compare: `node -e "process.exit(0)"`, baseline: 'missing.png' }] }],
    }), config: DEFAULTS,
    revision: { tree: 'tree-a' }, runVerify: (command, timeoutMs, env) => runVerify(dir, command, timeoutMs, env), changedFiles: () => [],
  });
  assert.equal(missing.decision.status, 'inconclusive');
  assert.match(missing.results[0].details ?? '', /baseline is missing/);
});

test('visual-semantic review records PASS, FAIL and an unparseable verdict correctly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-visual-semantic-'));
  const paths = resolvePaths(dir);
  const capture = `node -e "require('node:fs').writeFileSync(process.env.SYMPHONY_VISUAL_ACTUAL,'shot')"`;
  const spec = gateSpec({
    version: 2,
    criteria: [{ id: 'meaning', text: 'Reads right', gates: [{ kind: 'visual-semantic', capture, prompt: 'The banner says OK' }] }],
  });
  const review = async (text: string) => evaluateAcceptance({
    paths, task: task(), spec, config: DEFAULTS, revision: { tree: 'tree-a' },
    runVerify: (command, timeoutMs, env) => runVerify(dir, command, timeoutMs, env),
    changedFiles: () => [],
    reviewImage: async () => ({ text }),
  });
  assert.equal((await review('banner is green\nVERDICT: PASS')).decision.status, 'accepted');
  assert.equal((await review('banner is red\nVERDICT: FAIL')).decision.status, 'failed');
  assert.equal((await review('unclear')).decision.status, 'inconclusive');
});

test('human approval passes only at the approved revision and evidence set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-human-'));
  const paths = resolvePaths(dir);
  const spec = gateSpec({
    version: 2,
    criteria: [{
      id: 'review',
      text: 'Design review',
      gates: [{ kind: 'verify', command: 'check' }, { kind: 'human', approver: 'dan' }],
    }],
  });
  const evaluate = (tree: string) => evaluateAcceptance({
    paths, task: task(), spec, config: DEFAULTS, revision: { tree },
    runVerify: () => ({ ok: true, code: 0, output: 'ok' }), changedFiles: () => [],
  });

  const first = await evaluate('tree-a');
  assert.equal(first.decision.status, 'pending_human');
  const criterion = spec.criteria[0];
  const evidenceHash = criterionEvidenceHash(criterion, first.results, 'tree-a');
  appendApproval(paths, {
    taskId: 'T01',
    criterionId: 'review',
    approver: 'dan',
    at: '2026-01-01T00:00:00.000Z',
    revision: 'tree-a',
    evidenceHash,
    note: 'looks good',
  });

  const approved = await evaluate('tree-a');
  assert.equal(approved.decision.status, 'accepted');
  assert.ok(approved.results.find((r) => r.gate === 'human')?.evidence[0].approver);

  const stale = await evaluate('tree-b');
  assert.equal(stale.decision.status, 'pending_human');
  assert.match(stale.decision.reasons.join(' '), /stale/);
});

test('a human approval only counts for the named approver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-human-approver-'));
  const paths = resolvePaths(dir);
  const spec = gateSpec({
    version: 2,
    criteria: [{ id: 'review', text: 'Review', gates: [{ kind: 'human', approver: 'dan' }] }],
  });
  const criterion = spec.criteria[0];
  appendApproval(paths, {
    taskId: 'T01',
    criterionId: 'review',
    approver: 'someone-else',
    at: '2026-01-01T00:00:00.000Z',
    revision: 'tree-a',
    evidenceHash: criterionEvidenceHash(criterion, [], 'tree-a'),
  });
  const { decision } = await evaluateAcceptance({
    paths, task: task(), spec, config: DEFAULTS, revision: { tree: 'tree-a' },
    runVerify: () => ({ ok: true, code: 0, output: '' }), changedFiles: () => [],
  });
  assert.equal(decision.status, 'pending_human');
});
