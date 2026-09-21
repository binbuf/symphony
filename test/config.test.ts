import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig, resolveSession } from '../src/config.js';
import { resolvePaths } from '../src/paths.js';
import type { Task } from '../src/tasks.js';

const task = (meta: Record<string, string> = {}): Task => ({ id: 'T01', num: 1, title: 't', phase: 'p', order: 0, meta });

test('missing config → defaults; invalid JSON → UsageError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-cfg-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  const { config, fileExists } = loadConfig(paths, {});
  assert.equal(fileExists, false);
  assert.equal(config.provider, 'claude');
  assert.deepEqual(config.retry, DEFAULTS.retry);
  writeFileSync(paths.config, '{ nope');
  assert.throws(() => loadConfig(paths, {}), /invalid JSON/);
  writeFileSync(paths.config, JSON.stringify({ provider: 'nope' }));
  assert.throws(() => loadConfig(paths, {}), /unknown provider/);
});

test('config file merges per provider and unknown keys warn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-cfg-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ provider: 'cursor', providers: { cursor: { model: 'gpt-5' }, claude: { bin: '/opt/claude' } }, bogus: 1, retry: { maxAttempts: 5 } }));
  const { config, warnings } = loadConfig(paths, { safe: true, noNudge: true, timeoutMin: 9 });
  assert.equal(config.provider, 'cursor');
  assert.equal(config.providers.cursor.model, 'gpt-5');
  assert.equal(config.providers.cursor.bin, 'agent');
  assert.equal(config.providers.claude.bin, '/opt/claude');
  assert.equal(config.providers.claude.model, DEFAULTS.providers.claude.model);
  assert.equal(config.retry.maxAttempts, 5);
  assert.equal(config.autoApprove, false);
  assert.equal(config.nudge, false);
  assert.equal(config.timeoutMin, 9);
  assert.ok(warnings.some((w) => w.includes('bogus')));
});

test('resolveSession precedence: cli > env > front matter > config', () => {
  const cfg = { ...DEFAULTS, provider: 'opencode' as const };
  const byConfig = resolveSession(cfg, task(), {}, {}).spec;
  assert.equal(byConfig.providerName, 'opencode');
  assert.equal(byConfig.model, 'anthropic/claude-sonnet-4-5');
  const byMeta = resolveSession(cfg, task({ provider: 'cursor', model: 'm-meta', timeoutMin: '7' }), {}, {}).spec;
  assert.equal(byMeta.providerName, 'cursor');
  assert.equal(byMeta.model, 'm-meta');
  assert.equal(byMeta.timeoutMin, 7);
  assert.equal(byMeta.idleTimeoutMin, 45);
  const byEnv = resolveSession(cfg, task({ provider: 'cursor' }), {}, { SYMPHONY_PROVIDER: 'claude', SYMPHONY_MODEL: 'm-env' }).spec;
  assert.equal(byEnv.providerName, 'claude');
  assert.equal(byEnv.model, 'm-env');
  const byCli = resolveSession(cfg, task(), { provider: 'codex', model: 'm-cli' }, { SYMPHONY_PROVIDER: 'claude' }).spec;
  assert.equal(byCli.providerName, 'codex');
  assert.equal(byCli.model, 'm-cli');
  assert.equal(byCli.sources.provider, '--provider');
  assert.throws(() => resolveSession(cfg, task(), { provider: 'not-a-provider' }, {}), /unknown provider/);
});

test('budget is dropped with a warning for providers without a budget flag', () => {
  const r = resolveSession(DEFAULTS, task(), { provider: 'cursor', budgetUsd: 3 }, {}, (p) => p === 'claude');
  assert.equal(r.spec.budgetUsd, undefined);
  assert.ok(r.warnings[0].includes('budget'));
  const ok = resolveSession(DEFAULTS, task(), { provider: 'claude', budgetUsd: 3 }, {}, (p) => p === 'claude');
  assert.equal(ok.spec.budgetUsd, 3);
});

test('paths section is parsed and drives every location; unknown keys warn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-cfg-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({
    paths: { docs: 'planning', tasks: 'planning/work', progress: 'notes/PROGRESS.md', stop: '.halt' },
    maxContinuations: 7,
    commitPerSession: false,
    onBlocked: 'continue',
  }));
  const { config, warnings } = loadConfig(paths, {});
  assert.equal(config.paths.docs, 'planning');
  assert.equal(config.paths.tasks, 'planning/work');
  assert.equal(config.paths.progress, 'notes/PROGRESS.md');
  assert.equal(config.paths.stop, '.halt');
  assert.equal(config.maxContinuations, 7);
  assert.equal(config.commitPerSession, false);
  assert.equal(config.onBlocked, 'continue');
  const rp = resolvePaths(dir, config.paths);
  assert.equal(rp.docs, join(dir, 'planning'));
  assert.equal(rp.roadmap, join(dir, 'planning', 'ROADMAP.md'));
  assert.equal(rp.tasksDir, join(dir, 'planning', 'work'));
  assert.equal(rp.adrDir, join(dir, 'planning', 'design', 'adr'));
  assert.equal(rp.stop, join(dir, '.halt'));

  writeFileSync(paths.config, JSON.stringify({ paths: { docs: 'x', nope: 'y' }, onBlocked: 'sometimes' }));
  const bad = loadConfig(paths, {});
  assert.equal(bad.config.paths.docs, 'x');
  assert.equal(bad.config.onBlocked, 'stop');
  assert.ok(bad.warnings.some((w) => w.includes('paths.nope')));
  assert.ok(bad.warnings.some((w) => w.includes('onBlocked')));
});

test('default docs dir is docs/, but a legacy .docs/ is honoured when docs/ is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-docs-'));
  assert.equal(resolvePaths(dir).docs, join(dir, 'docs'));
  mkdirSync(join(dir, '.docs'), { recursive: true });
  assert.equal(resolvePaths(dir).docs, join(dir, '.docs'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  assert.equal(resolvePaths(dir).docs, join(dir, 'docs'));
  assert.equal(resolvePaths(dir, { docs: 'custom' }).docs, join(dir, 'custom'));
});

test('designDocs can be switched off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-nodesign-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  assert.equal(loadConfig(paths, {}).config.designDocs, true);
  writeFileSync(paths.config, JSON.stringify({ designDocs: false }));
  assert.equal(loadConfig(paths, {}).config.designDocs, false);
});
