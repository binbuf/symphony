import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, isModelDowngrade, loadConfig, lookupModelTier, resolveEscalation, resolveSession } from '../src/config.js';
import { resolvePaths } from '../src/paths.js';
import type { Task } from '../src/tasks.js';

const task = (meta: Record<string, string> = {}): Task => ({ id: 'T01', num: 1, title: 't', phase: 'p', order: 0, meta });

test('modelTiers parses an ordered registry, accepts tier aliases, and drops malformed entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-tiers-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({
    modelTiers: [
      { provider: 'opencode', model: 'deepseek-v4.1-flash', modelProvider: 'openrouter', tier: 3 },
      { provider: 'codex', model: 'gpt-6-sol', model_tier: 5 },
      { provider: 'codex', model: 'gpt-6-astra', modelTier: 7 },
      null,
      { provider: 'codex' },
      { provider: 'codex', model: 'x', tier: 'high' },
      { provider: 'nope', model: 'x', tier: 1 },
      { provider: 'codex', model: 'gpt-6-sol', tier: 9 },
    ],
  }));
  const { config, warnings } = loadConfig(paths, {});
  assert.deepEqual(config.modelTiers.map((e) => e.id), ['openrouter/deepseek-v4.1-flash', 'gpt-6-sol', 'gpt-6-astra']);
  assert.deepEqual(config.modelTiers.map((e) => e.order), [0, 1, 2]);
  assert.ok(warnings.some((w) => /modelTiers\[3\]/.test(w)));
  assert.ok(warnings.some((w) => /modelTiers\[4\]: missing a non-empty "model"/.test(w)));
  assert.ok(warnings.some((w) => /modelTiers\[5\]: missing a numeric "tier"/.test(w)));
  assert.ok(warnings.some((w) => /modelTiers\[6\].*unknown provider/.test(w)));
  assert.ok(warnings.some((w) => /modelTiers\[7\]: duplicate model "gpt-6-sol"/.test(w)));

  // Lookup is provider + composed id; an untiered (or absent) model yields undefined.
  assert.equal(lookupModelTier(config, 'opencode', 'openrouter/deepseek-v4.1-flash')?.tier, 3);
  assert.equal(lookupModelTier(config, 'codex', 'gpt-6-astra')?.tier, 7);
  assert.equal(lookupModelTier(config, 'codex', 'gpt-5.6-luna'), undefined);
  assert.equal(lookupModelTier(config, 'opencode', undefined), undefined);

  // Downgrade: lower tier, or same tier later in config; a tie earlier in config is not a downgrade.
  const deepseek = lookupModelTier(config, 'opencode', 'openrouter/deepseek-v4.1-flash');
  const sol = lookupModelTier(config, 'codex', 'gpt-6-sol');
  const astra = lookupModelTier(config, 'codex', 'gpt-6-astra');
  assert.equal(isModelDowngrade(astra, deepseek), true);
  assert.equal(isModelDowngrade(deepseek, astra), false);
  assert.equal(isModelDowngrade(sol, astra), false);
  assert.equal(isModelDowngrade(undefined, astra), false);
  assert.equal(isModelDowngrade(astra, undefined), false);

  // Order is the tie-breaker: a shared tier is a downgrade only when it ranks later.
  const tied = { ...DEFAULTS, modelTiers: [
    { provider: 'codex' as const, model: 'a', id: 'a', tier: 5, order: 0 },
    { provider: 'codex' as const, model: 'b', id: 'b', tier: 5, order: 1 },
  ] };
  assert.equal(isModelDowngrade(tied.modelTiers[0], tied.modelTiers[1]), true);
  assert.equal(isModelDowngrade(tied.modelTiers[1], tied.modelTiers[0]), false);
  assert.equal(isModelDowngrade(tied.modelTiers[0], tied.modelTiers[0]), false);
});

test('modelTierPolicy parses onDowngrade and warns only when a configured registry has untiered models', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-tierpolicy-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  assert.deepEqual(DEFAULTS.modelTierPolicy, { onDowngrade: 'downgrade' });
  writeFileSync(paths.config, JSON.stringify({ modelTierPolicy: { onDowngrade: 'block' } }));
  assert.equal(loadConfig(paths, {}).config.modelTierPolicy.onDowngrade, 'block');

  writeFileSync(paths.config, JSON.stringify({ modelTierPolicy: { onDowngrade: 'nonsense' } }));
  const bad = loadConfig(paths, {});
  assert.equal(bad.config.modelTierPolicy.onDowngrade, 'downgrade');
  assert.ok(bad.warnings.some((w) => /modelTierPolicy\.onDowngrade/.test(w)));

  // With no registry there is nothing to nudge about.
  writeFileSync(paths.config, JSON.stringify({}));
  assert.ok(!loadConfig(paths, {}).warnings.some((w) => /modelTiers/.test(w)));

  // A registry flags the active provider's models that have no tier (watch off so only the model
  // under test is checked).
  writeFileSync(paths.config, JSON.stringify({
    provider: 'codex',
    providers: { codex: { model: 'gpt-6-astra', models: [{ id: 'gpt-6-astra' }] } },
    watch: { enabled: false },
    modelTiers: [{ provider: 'codex', model: 'gpt-6-astra', tier: 7 }],
  }));
  const ok = loadConfig(paths, {});
  assert.ok(!ok.warnings.some((w) => /no tier for/.test(w)));

  writeFileSync(paths.config, JSON.stringify({
    provider: 'codex',
    providers: { codex: { model: 'gpt-6-astra', models: [{ id: 'gpt-6-astra' }] } },
    watch: { enabled: false },
    modelTiers: [{ provider: 'codex', model: 'gpt-6-luna', tier: 2 }],
  }));
  const missing = loadConfig(paths, {});
  assert.ok(missing.warnings.some((w) => /no tier for codex:gpt-6-astra/.test(w)));
});

test('per-task escalation front matter enables and retargets escalation for that task alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-taskesc-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  // Escalation is off in config; the task turns it on and names its own target.
  writeFileSync(paths.config, JSON.stringify({ provider: 'codex', providers: { codex: { model: 'gpt-6-sol', models: [
    { id: 'gpt-6-sol', variants: ['low', 'high'] },
    { id: 'gpt-6-astra', variants: ['low', 'high'] },
  ] } } }));
  const { config } = loadConfig(paths, {});
  const primary = resolveSession(config, task({ model: 'gpt-6-sol' }), {}, {}, () => true, () => true).spec;
  assert.equal(resolveEscalation(config, primary, () => true, () => true), undefined);

  const enabled = resolveEscalation(config, primary, () => true, () => true, task({ escalation: 'true', escalationProvider: 'codex', escalationModel: 'gpt-6-astra', escalationVariant: 'high' }));
  assert.equal(enabled?.spec.providerName, 'codex');
  assert.equal(enabled?.spec.model, 'gpt-6-astra');
  assert.equal(enabled?.spec.variant, 'high');
  assert.equal(enabled?.spec.sources.provider, 'task front matter');
  assert.equal(enabled?.spec.sources.model, 'task front matter');
  assert.equal(enabled?.spec.sources.variant, 'task front matter');

  // `escalation: false` turns a configured escalation off for this task.
  const cfgOn = { ...config, escalation: { ...config.escalation, enabled: true } };
  assert.equal(resolveEscalation(cfgOn, primary, () => true, () => true, task({ escalation: 'false' })), undefined);
  assert.ok(resolveEscalation(cfgOn, primary, () => true, () => true, task()));

  // A task-only escalation with no model anywhere is refused (the harness logs the reason).
  const noModel = { ...config, escalation: { ...config.escalation, enabled: false, model: '' } };
  assert.equal(resolveEscalation(noModel, primary, () => true, () => true, task({ escalation: 'true' })), undefined);
});