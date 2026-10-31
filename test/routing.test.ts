import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, type Config, type ModelTierEntry, type SessionSpec } from '../src/config.js';
import type { AttemptDelta } from '../src/progress.js';
import { progressTrend } from '../src/progress.js';
import { nextTierEntry, routeTier, tierSpec } from '../src/routing.js';
import { newTaskState } from '../src/state.js';

const entry = (provider: 'claude' | 'opencode', model: string, tier: number, order: number): ModelTierEntry => ({
  provider,
  model,
  id: model,
  tier,
  order,
});

const config = (over: Partial<Config> = {}): Config => ({
  ...DEFAULTS,
  modelTiers: [entry('claude', 'small', 1, 0), entry('claude', 'medium', 2, 1), entry('opencode', 'big', 3, 2)],
  ...over,
});

const spec = (model = 'small', source = 'config'): SessionSpec => ({
  providerName: 'claude',
  bin: 'claude',
  model,
  extraArgs: [],
  timeoutMin: 30,
  idleTimeoutMin: 0,
  autoApprove: true,
  sources: { provider: 'config', model: source, modelProvider: 'config', variant: 'config' },
});

const delta = (fingerprint: string, metric?: number): AttemptDelta => ({
  at: '2026-01-01T00:00:00.000Z',
  attempt: 1,
  fingerprint,
  ...(metric !== undefined ? { metric } : {}),
  signals: [],
});

test('progressTrend reads the metric first and the fingerprint otherwise', () => {
  assert.equal(progressTrend([delta('a')], 'increase'), 'unknown');
  assert.equal(progressTrend([delta('a'), delta('b')], 'increase'), 'improving');
  assert.equal(progressTrend([delta('a'), delta('a')], 'increase'), 'flat');
  assert.equal(progressTrend([delta('a', 1), delta('b', 2)], 'increase'), 'improving');
  assert.equal(progressTrend([delta('a', 2), delta('b', 1)], 'increase'), 'regressing');
  assert.equal(progressTrend([delta('a', 1), delta('b', 1)], 'increase'), 'flat');
  assert.equal(progressTrend([delta('a', 0), delta('b', 0)], 'nonzero'), 'flat');
});

test('tier routing promotes one step on observable progress', () => {
  const st = newTaskState('t');
  st.deltas = [delta('a'), delta('b'), delta('c')];
  const route = routeTier(config({ tierRouting: { ...DEFAULTS.tierRouting, enabled: true, promoteAfterProgress: 2 } }), spec(), st);
  assert.ok(route);
  assert.equal(route.from.model, 'small');
  assert.equal(route.entry.model, 'medium');
  assert.equal(route.spec.providerName, 'claude');
  assert.equal(route.spec.model, 'medium');
  assert.match(route.reason, /observable-progress/);
});

test('tier routing does not fire on flat/regressing progress, a spent cap, or a pinned model', () => {
  const flat = newTaskState('t');
  flat.deltas = [delta('a'), delta('a'), delta('a')];
  const on = config({ tierRouting: { ...DEFAULTS.tierRouting, enabled: true } });
  assert.equal(routeTier(on, spec(), flat), undefined);

  const improving = newTaskState('t');
  improving.deltas = [delta('a'), delta('b'), delta('c')];
  improving.tierPromotions = 1;
  assert.equal(routeTier(on, spec(), improving), undefined, 'maxPromotions default is one');

  const pinned = newTaskState('t');
  pinned.deltas = [delta('a'), delta('b'), delta('c')];
  assert.equal(routeTier(on, spec('small', 'task front matter'), pinned), undefined);
  const loose = config({ tierRouting: { ...DEFAULTS.tierRouting, enabled: true, respectTaskOverride: false } });
  assert.ok(routeTier(loose, spec('small', 'task front matter'), pinned));
});

test('nextTierEntry picks the lowest higher tier, then registry order', () => {
  const c = config({ modelTiers: [entry('claude', 'small', 1, 0), entry('claude', 'medium-b', 2, 1), entry('claude', 'medium-a', 2, 2), entry('opencode', 'big', 3, 3)] });
  assert.equal(nextTierEntry(c, spec())?.model, 'medium-b');
  assert.equal(nextTierEntry(c, spec('medium-a'))?.model, 'big');
  assert.equal(nextTierEntry(c, spec('untiered')), undefined);
});

test('tierSpec keeps run bounds and marks its source', () => {
  const c = config();
  const routed = tierSpec(c, spec(), entry('opencode', 'big', 3, 2));
  assert.equal(routed.providerName, 'opencode');
  assert.equal(routed.model, 'big');
  assert.equal(routed.timeoutMin, 30);
  assert.equal(routed.autoApprove, true);
  assert.equal(routed.sources.model, 'tier routing');
});
