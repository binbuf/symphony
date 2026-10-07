import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, isFlexVariant, loadConfig } from '../src/config.js';
import { resolvePaths } from '../src/paths.js';

function paths(): ReturnType<typeof resolvePaths> {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-flex-'));
  const p = resolvePaths(dir);
  mkdirSync(p.symphony, { recursive: true });
  return p;
}

test('flex defaults to waiting, and detects flex- variants plus the explicit list', () => {
  assert.deepEqual(DEFAULTS.flex, {
    variantPrefix: 'flex-',
    variants: [],
    onUnavailable: 'wait',
    pollSec: 60,
    maxWaitMin: 0,
    onCategories: ['rate_limit', 'overloaded', 'server'],
  });
  const p = paths();
  const { config } = loadConfig(p, {});
  assert.equal(isFlexVariant(config, 'flex-high'), true);
  assert.equal(isFlexVariant(config, 'high'), false);
  assert.equal(isFlexVariant(config, undefined), false);

  writeFileSync(p.config, JSON.stringify({
    flex: { variantPrefix: 'eco-', variants: ['cheap'], onUnavailable: 'block', pollSec: 0, maxWaitMin: 30, onCategories: ['rate_limit'] },
  }));
  const c = loadConfig(p, {}).config;
  assert.equal(isFlexVariant(c, 'eco-low'), true);
  assert.equal(isFlexVariant(c, 'flex-high'), false);
  assert.equal(isFlexVariant(c, 'cheap'), true);
  assert.equal(c.flex.onUnavailable, 'block');
  assert.equal(c.flex.pollSec, 0);
  assert.equal(c.flex.maxWaitMin, 30);
  assert.deepEqual(c.flex.onCategories, ['rate_limit']);
});

test('flex parsing falls back on bad values with warnings', () => {
  const p = paths();
  writeFileSync(p.config, JSON.stringify({ flex: { onUnavailable: 'nope', pollSec: -5, variantPrefix: 7 } }));
  const { config, warnings } = loadConfig(p, {});
  assert.equal(config.flex.onUnavailable, 'wait');
  assert.equal(config.flex.pollSec, 60);
  assert.equal(config.flex.variantPrefix, 'flex-');
  assert.ok(warnings.some((w) => /flex\.onUnavailable/.test(w)));
  assert.ok(warnings.some((w) => /flex\.pollSec/.test(w)));
  assert.ok(warnings.some((w) => /flex\.variantPrefix/.test(w)));
});