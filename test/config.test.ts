import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, findTaskSet, loadConfig, resolveBreakdown, resolveEscalation, resolveSession, resolveVerify, resolveWatch } from '../src/config.js';
import { resolvePaths, taskSetOverrides } from '../src/paths.js';
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

test('keys beginning with "_" are comments: ignored silently at every level', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-cfg-comment-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({
    _models: 'current ids per provider: see Models.md',
    provider: 'cursor',
    providers: { _note: 'claude lives in the project config', cursor: { model: 'gpt-5' } },
    paths: { _note: 'defaults', docs: 'planning' },
    bogus: 1,
  }));
  const { config, warnings } = loadConfig(paths, {});
  assert.equal(config.provider, 'cursor');
  assert.equal(config.providers.cursor.model, 'gpt-5');
  assert.equal(config.paths.docs, 'planning');
  assert.ok(!warnings.some((w) => /_models|_note/.test(w)), 'comment keys must not warn');
  assert.ok(warnings.some((w) => w.includes('bogus')), 'a real unknown key still warns');
});

test('timeZone is parsed to local, utc or a fixed offset; bad values warn and fall back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-cfg-tz-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  assert.equal(loadConfig(paths, {}).config.timeZone, 'local');
  writeFileSync(paths.config, JSON.stringify({ timeZone: 'utc' }));
  assert.equal(loadConfig(paths, {}).config.timeZone, 'utc');
  writeFileSync(paths.config, JSON.stringify({ timeZone: '+05:30' }));
  assert.equal(loadConfig(paths, {}).config.timeZone, 330);
  writeFileSync(paths.config, JSON.stringify({ timeZone: 'nonsense' }));
  const bad = loadConfig(paths, {});
  assert.equal(bad.config.timeZone, 'local');
  assert.ok(bad.warnings.some((w) => w.includes('timeZone')));
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

test('variant: defaults to high, follows precedence, and is gated by model support', () => {
  const yes = () => true;
  // Shipped default for providers with an effort knob.
  const byConfig = resolveSession(DEFAULTS, task(), {}, {}, yes, yes).spec;
  assert.equal(byConfig.providerName, 'claude');
  assert.equal(byConfig.variant, 'high');
  assert.equal(byConfig.sources.variant, 'config');

  // Precedence: cli > env > front matter > config.
  const byCli = resolveSession(DEFAULTS, task({ variant: 'low' }), { variant: 'max' }, { SYMPHONY_VARIANT: 'medium' }, yes, yes).spec;
  assert.equal(byCli.variant, 'max');
  assert.equal(byCli.sources.variant, '--variant');
  const byEnv = resolveSession(DEFAULTS, task({ variant: 'low' }), {}, { SYMPHONY_VARIANT: 'medium' }, yes, yes).spec;
  assert.equal(byEnv.variant, 'medium');
  const byMeta = resolveSession(DEFAULTS, task({ variant: 'low' }), {}, {}, yes, yes).spec;
  assert.equal(byMeta.variant, 'low');
  assert.equal(byMeta.sources.variant, 'task front matter');

  // A provider with a variant knob but a model that does not advertise it: the default is dropped
  // silently, an explicit request warns.
  const opencode = { ...DEFAULTS, provider: 'opencode' as const };
  const dropped = resolveSession(opencode, task(), {}, {}, yes, () => false);
  assert.equal(dropped.spec.variant, undefined);
  assert.equal(dropped.warnings.length, 0);
  const explicit = resolveSession(opencode, task(), { variant: 'max' }, {}, yes, () => false);
  assert.equal(explicit.spec.variant, undefined);
  assert.ok(explicit.warnings.some((w) => /does not support variant/.test(w)));

  // Providers without a knob never get one, even from config.
  assert.equal(resolveSession(DEFAULTS, task({ provider: 'cursor' }), {}, {}, yes, yes).spec.variant, undefined);

  // A per-provider override in the config file wins over the shipped default.
  const dir = mkdtempSync(join(tmpdir(), 'symphony-cfg-variant-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ providers: { claude: { variant: 'xhigh' } } }));
  const { config } = loadConfig(paths, {});
  assert.equal(config.providers.claude.variant, 'xhigh');
  assert.equal(config.providers.opencode.variant, 'high');
});

test('escalation inherits the provider default variant and is gated the same way', () => {
  const cfg = { ...DEFAULTS, escalation: { ...DEFAULTS.escalation, enabled: true } };
  const primary = resolveSession(cfg, task(), {}, {}, () => true, () => true).spec;
  const esc = resolveEscalation(cfg, primary, () => true, () => true);
  assert.equal(esc?.spec.variant, 'high');
  assert.equal(esc?.spec.sources.variant, 'config');
  assert.equal(resolveEscalation(cfg, primary, () => true, () => false)?.spec.variant, undefined);
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

test('caps, verify, hooks and git settings parse, with CLI caps overriding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-limits-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({
    maxTasksPerRun: 3,
    maxIterationsPerTask: 7,
    verifyCommand: 'npm test',
    verifyTimeoutMin: 12,
    hooks: { afterTask: 'echo done', onHalt: 'echo halt' },
    git: { autoIgnoreUntracked: false, extraIgnore: ['*.tfstate'] },
  }));
  const { config, warnings } = loadConfig(paths, {});
  assert.equal(config.maxTasksPerRun, 3);
  assert.equal(config.maxIterationsPerTask, 7);
  assert.equal(config.verifyCommand, 'npm test');
  assert.equal(config.verifyTimeoutMin, 12);
  assert.equal(config.hooks.afterTask, 'echo done');
  assert.equal(config.hooks.onHalt, 'echo halt');
  assert.equal(config.hooks.onBlocked, undefined);
  assert.equal(config.git.autoIgnoreUntracked, false);
  assert.deepEqual(config.git.extraIgnore, ['*.tfstate']);
  assert.equal(warnings.length, 0);

  const overridden = loadConfig(paths, { maxTasks: 1, maxIterations: 2 }).config;
  assert.equal(overridden.maxTasksPerRun, 1);
  assert.equal(overridden.maxIterationsPerTask, 2);

  writeFileSync(paths.config, JSON.stringify({ hooks: { afterTask: 42 }, git: { extraIgnore: 'nope' } }));
  const bad = loadConfig(paths, {});
  assert.equal(bad.config.hooks.afterTask, undefined);
  assert.deepEqual(bad.config.git.extraIgnore, []);
  assert.ok(bad.warnings.some((w) => w.includes('hooks.afterTask')));
  assert.ok(bad.warnings.some((w) => w.includes('git.extraIgnore')));
});

test('verify resolution: front matter > config > inferred package.json test script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-verify-'));
  const cfg = { ...DEFAULTS };
  assert.equal(resolveVerify(cfg, task(), dir), undefined);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const inferred = resolveVerify(cfg, task(), dir);
  assert.deepEqual(inferred, { command: 'npm test', timeoutMin: DEFAULTS.verifyTimeoutMin, source: 'package.json' });
  assert.equal(resolveVerify({ ...cfg, inferVerify: false }, task(), dir), undefined);
  assert.equal(resolveVerify({ ...cfg, verifyCommand: 'make check' }, task(), dir)?.source, 'config');
  const byTask = resolveVerify(cfg, task({ verify: 'npm run verify' }), dir);
  assert.equal(byTask?.command, 'npm run verify');
  assert.equal(byTask?.source, 'task front matter');
  // npm's placeholder script is not a real verification command.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(resolveVerify(cfg, task(), dir), undefined);
});

test('taskSets parse into named path bundles; invalid entries warn and are dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-sets-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({
    taskSets: [
      { name: 'phase-2', docs: 'docs/phase-2' },
      { name: 'audit', roadmap: 'audit/PLAN.md', design: 'docs/design' },
      { name: 'no-location' },
      { name: 'bad name', docs: 'x' },
      { name: 'phase-2', docs: 'dup' },
      'not-an-object',
      { name: 'weird', docs: 'x', bogus: 1 },
    ],
  }));
  const { config, warnings } = loadConfig(paths, {});
  assert.deepEqual(config.taskSets.map((s) => s.name), ['phase-2', 'audit', 'weird']);
  assert.equal(config.taskSets[0].paths.docs, 'docs/phase-2');
  assert.equal(config.taskSets[1].paths.roadmap, 'audit/PLAN.md');
  assert.equal(config.taskSets[1].paths.design, 'docs/design');
  assert.ok(warnings.some((w) => /needs "docs" or "roadmap"/.test(w)));
  assert.ok(warnings.some((w) => /must match/.test(w)));
  assert.ok(warnings.some((w) => /duplicate task set/.test(w)));
  assert.ok(warnings.some((w) => /expected an object/.test(w)));
  assert.ok(warnings.some((w) => /taskSets\[6\]\.bogus/.test(w)));
  assert.equal(findTaskSet(config, 'audit')?.paths.roadmap, 'audit/PLAN.md');
  assert.equal(findTaskSet(config, 'nope'), undefined);

  // A non-array taskSets is ignored with a warning rather than throwing.
  writeFileSync(paths.config, JSON.stringify({ taskSets: { phase2: { docs: 'x' } } }));
  const bad = loadConfig(paths, {});
  assert.deepEqual(bad.config.taskSets, []);
  assert.ok(bad.warnings.some((w) => /taskSets: expected an array/.test(w)));
});

test('a task set isolates state/runs/log and keeps the base global stop, unless it overrides them', () => {
  const base = { stop: '.halt', state: 'custom/state.json' };
  const isolated = taskSetOverrides(base, 'phase-2', { docs: 'docs/phase-2' });
  assert.deepEqual(isolated, {
    docs: 'docs/phase-2',
    stop: '.halt',
    state: '.symphony/sets/phase-2/state.json',
    runs: '.symphony/sets/phase-2/runs',
    log: '.symphony/sets/phase-2/symphony.log',
  });
  // Base planning overrides do not leak into a set: only its own keys and harness paths are present.
  assert.equal('progress' in isolated, false);

  const explicit = taskSetOverrides(base, 'audit', { roadmap: 'audit/PLAN.md', state: 'audit/state.json', stop: '.audit-stop' });
  assert.equal(explicit.state, 'audit/state.json');
  assert.equal(explicit.stop, '.audit-stop');
  assert.equal(explicit.runs, '.symphony/sets/audit/runs');
});

test('cost cap, task byte cap and non-positive timeouts/caps validate and fall back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-cost-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ maxCostUsdPerRun: 2.5, maxTaskBytes: 1024, inferVerify: false }));
  const { config, warnings } = loadConfig(paths, {});
  assert.equal(config.maxCostUsdPerRun, 2.5);
  assert.equal(config.maxTaskBytes, 1024);
  assert.equal(config.inferVerify, false);
  assert.equal(warnings.length, 0);
  assert.equal(loadConfig(paths, { maxCostUsd: 4 }).config.maxCostUsdPerRun, 4);

  writeFileSync(paths.config, JSON.stringify({ timeoutMin: 0, maxIndexBytes: -1, maxTaskBytes: 0 }));
  const bad = loadConfig(paths, {});
  assert.equal(bad.config.timeoutMin, DEFAULTS.timeoutMin);
  assert.equal(bad.config.maxIndexBytes, DEFAULTS.maxIndexBytes);
  assert.equal(bad.config.maxTaskBytes, DEFAULTS.maxTaskBytes);
  assert.equal(bad.warnings.filter((w) => /positive/.test(w)).length, 3);

  // idleTimeoutMin 0 is meaningful (it disables stall detection), so it must stay 0.
  writeFileSync(paths.config, JSON.stringify({ idleTimeoutMin: 0, providers: { claude: { idleTimeoutMin: 0 } } }));
  const idle = loadConfig(paths, {});
  assert.equal(idle.config.idleTimeoutMin, 0);
  assert.equal(idle.config.providers.claude.idleTimeoutMin, 0);
  assert.equal(idle.warnings.length, 0);
});

test('front matter timeoutMin must be a positive number and warns otherwise', () => {
  const ok = resolveSession(DEFAULTS, task({ timeoutMin: '7' }), {}, {});
  assert.equal(ok.spec.timeoutMin, 7);
  const bad = resolveSession(DEFAULTS, task({ timeoutMin: '0' }), {}, {});
  assert.equal(bad.spec.timeoutMin, DEFAULTS.timeoutMin);
  assert.ok(bad.warnings.some((w) => /timeoutMin/.test(w)));
  const negative = resolveSession(DEFAULTS, task({ timeoutMin: '-5' }), {}, {});
  assert.equal(negative.spec.timeoutMin, DEFAULTS.timeoutMin);
});

test('escalation defaults to GLM-5.3 via OpenCode, is off until enabled, and resolves to a spec', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-esc-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  // The shipped default is a real, usable pair even though escalation is off by default.
  assert.equal(DEFAULTS.escalation.enabled, false);
  assert.equal(DEFAULTS.escalation.provider, 'opencode');
  assert.equal(DEFAULTS.escalation.model, 'openrouter/z-ai/glm-5.3');
  const off = loadConfig(paths, {}).config;
  assert.equal(off.escalation.enabled, false);
  assert.equal(resolveEscalation(off, resolveSession(off, task(), {}, {}).spec), undefined);

  writeFileSync(paths.config, JSON.stringify({ escalation: { enabled: true, provider: 'codex', model: 'gpt-5', maxAttempts: 2, onCategories: ['task'] } }));
  const { config, warnings } = loadConfig(paths, {});
  assert.equal(config.escalation.enabled, true);
  assert.equal(config.escalation.provider, 'codex');
  assert.equal(config.escalation.model, 'gpt-5');
  assert.equal(config.escalation.maxAttempts, 2);
  assert.deepEqual(config.escalation.onCategories, ['task']);
  assert.equal(warnings.length, 0);
  const resolved = resolveEscalation(config, resolveSession(config, task(), {}, {}).spec);
  assert.equal(resolved?.spec.providerName, 'codex');
  assert.equal(resolved?.spec.model, 'gpt-5');
  assert.equal(resolved?.spec.sources.provider, 'escalation');
  assert.equal(resolved?.spec.sources.model, 'escalation');

  // An enabled escalation with no model is turned off with a warning rather than guessing.
  writeFileSync(paths.config, JSON.stringify({ escalation: { enabled: true, model: '' } }));
  const empty = loadConfig(paths, {});
  assert.equal(empty.config.escalation.enabled, false);
  assert.ok(empty.warnings.some((w) => /escalation.model is empty/.test(w)));

  // An unknown escalation provider is rejected outright.
  writeFileSync(paths.config, JSON.stringify({ escalation: { enabled: true, provider: 'nope' } }));
  assert.throws(() => loadConfig(paths, {}), /unknown provider/);
});

test('jev config parses, defaults to OpenRouter with jev-latest, and validates its keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-jev-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  assert.equal(DEFAULTS.jev.enabled, false);
  assert.equal(DEFAULTS.jev.provider, 'openrouter');
  assert.equal(DEFAULTS.jev.model, 'jev-latest');
  // Every workflow ships on, so flipping `enabled` turns them all on until you opt one out.
  assert.equal(DEFAULTS.jev.resultFallback, true);
  assert.equal(DEFAULTS.jev.failureTriage, true);
  assert.equal(DEFAULTS.jev.escalationDecision, true);
  assert.equal(loadConfig(paths, {}).config.jev.enabled, false);

  writeFileSync(paths.config, JSON.stringify({ jev: { enabled: true, model: 'typesafe/jev-1.13', minConfidence: 0.5, acceptStatuses: ['done'], resultFallback: false, escalationDecision: false } }));
  const { config, warnings } = loadConfig(paths, {});
  assert.equal(config.jev.enabled, true);
  assert.equal(config.jev.model, 'typesafe/jev-1.13');
  assert.equal(config.jev.minConfidence, 0.5);
  assert.deepEqual(config.jev.acceptStatuses, ['done']);
  assert.equal(config.jev.apiKeyEnv, 'OPENROUTER_API_KEY');
  assert.equal(config.jev.resultFallback, false);
  assert.equal(config.jev.failureTriage, true);
  assert.equal(config.jev.escalationDecision, false);
  assert.equal(warnings.length, 0);

  // Unknown provider, out-of-range confidence and an unknown status all warn and fall back.
  writeFileSync(paths.config, JSON.stringify({ jev: { enabled: true, provider: 'nope', minConfidence: 5, acceptStatuses: ['done', 'bogus'] } }));
  const bad = loadConfig(paths, {});
  assert.equal(bad.config.jev.provider, 'openrouter');
  assert.equal(bad.config.jev.minConfidence, DEFAULTS.jev.minConfidence);
  assert.deepEqual(bad.config.jev.acceptStatuses, ['done']);
  assert.ok(bad.warnings.some((w) => /jev\.provider/.test(w)));
  assert.ok(bad.warnings.some((w) => /jev\.minConfidence/.test(w)));
  assert.ok(bad.warnings.some((w) => /jev\.acceptStatuses/.test(w)));
});

test('watch config is on by default every 5 min on OpenCode, parses overrides, and validates keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-watchcfg-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });
  assert.equal(DEFAULTS.watch.enabled, true);
  assert.equal(DEFAULTS.watch.intervalMin, 5);
  assert.equal(DEFAULTS.watch.provider, 'opencode');
  assert.equal(DEFAULTS.watch.model, 'openrouter/deepseek/deepseek-v4.1-flash');
  assert.equal(loadConfig(paths, {}).config.watch.enabled, true);

  writeFileSync(paths.config, JSON.stringify({ watch: { enabled: false, intervalMin: 10, provider: 'codex', model: 'gpt-5', variant: 'high', timeoutMin: 3 } }));
  const { config, warnings } = loadConfig(paths, {});
  assert.equal(config.watch.enabled, false);
  assert.equal(config.watch.intervalMin, 10);
  assert.equal(config.watch.provider, 'codex');
  assert.equal(config.watch.model, 'gpt-5');
  assert.equal(config.watch.variant, 'high');
  assert.equal(config.watch.timeoutMin, 3);
  assert.equal(warnings.length, 0);

  writeFileSync(paths.config, JSON.stringify({ watch: { provider: 'nope', intervalMin: 0, variant: 5 } }));
  const bad = loadConfig(paths, {});
  assert.equal(bad.config.watch.provider, DEFAULTS.watch.provider);
  assert.equal(bad.config.watch.intervalMin, DEFAULTS.watch.intervalMin);
  assert.equal(bad.config.watch.variant, undefined);
  assert.ok(bad.warnings.some((w) => /watch\.provider/.test(w)));
  assert.ok(bad.warnings.some((w) => /watch\.intervalMin/.test(w)));
  assert.ok(bad.warnings.some((w) => /watch\.variant/.test(w)));

  // resolveWatch builds a read-only spec from the watch block alone. An unset variant is not
  // resolved at all (so no provider-catalog lookup); an explicit one is gated by support.
  const rw = resolveWatch({ ...DEFAULTS, watch: { ...DEFAULTS.watch, provider: 'fake', model: '', timeoutMin: 2 } });
  assert.equal(rw.spec.providerName, 'fake');
  assert.equal(rw.spec.autoApprove, false);
  assert.equal(rw.spec.timeoutMin, 2);
  assert.equal(rw.spec.variant, undefined);
  let looked = false;
  resolveWatch(
    { ...DEFAULTS, watch: { ...DEFAULTS.watch, provider: 'fake', model: '' } },
    () => { looked = true; return true; },
  );
  assert.equal(looked, false, 'an unset watch variant never triggers a support lookup');

  const supported = resolveWatch({ ...DEFAULTS, watch: { ...DEFAULTS.watch, provider: 'fake', model: '', variant: 'high' } }, () => true);
  assert.equal(supported.spec.variant, 'high');
  assert.equal(supported.spec.sources.variant, 'watch');
  const dropped = resolveWatch({ ...DEFAULTS, watch: { ...DEFAULTS.watch, provider: 'fake', model: '', variant: 'high' } }, () => false);
  assert.equal(dropped.spec.variant, undefined);
  assert.ok(dropped.warnings.some((w) => /does not support variant/.test(w)));
});

test('breakdown config is off by default, parses overrides, and validates keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-breakdowncfg-'));
  const paths = resolvePaths(dir);
  mkdirSync(paths.symphony, { recursive: true });

  assert.equal(DEFAULTS.breakdown.enabled, false);
  assert.equal(DEFAULTS.breakdown.decision, 'auto');
  assert.equal(DEFAULTS.breakdown.onStart, false);
  assert.equal(DEFAULTS.breakdown.onContinue, true);
  assert.equal(DEFAULTS.breakdown.onFailure, true);
  assert.deepEqual(DEFAULTS.breakdown.rules, { minTaskBytes: 16384, afterContinuations: 1, afterFailedAttempts: 1, onCategories: ['task', 'verify'] });
  assert.equal(loadConfig(paths, {}).config.breakdown.enabled, false);

  writeFileSync(paths.config, JSON.stringify({
    breakdown: {
      enabled: true, onStart: true, onContinue: false, onFailure: false, decision: 'rules', preferOverEscalation: false, maxPerTask: 3,
      rules: { minTaskBytes: 0, afterContinuations: 0, afterFailedAttempts: 2, onCategories: ['verify'] },
    },
  }));
  const config = loadConfig(paths, {}).config;
  assert.equal(config.breakdown.enabled, true);
  assert.equal(config.breakdown.onStart, true);
  assert.equal(config.breakdown.onContinue, false);
  assert.equal(config.breakdown.onFailure, false);
  assert.equal(config.breakdown.decision, 'rules');
  assert.equal(config.breakdown.preferOverEscalation, false);
  assert.equal(config.breakdown.maxPerTask, 3);
  assert.deepEqual(config.breakdown.rules, { minTaskBytes: 0, afterContinuations: 0, afterFailedAttempts: 2, onCategories: ['verify'] });

  writeFileSync(paths.config, JSON.stringify({ breakdown: { provider: 'nope', decision: 'maybe', maxPerTask: -1 } }));
  const bad = loadConfig(paths, {});
  assert.equal(bad.config.breakdown.provider, undefined);
  assert.equal(bad.config.breakdown.decision, DEFAULTS.breakdown.decision);
  assert.equal(bad.config.breakdown.maxPerTask, 0);
  assert.ok(bad.warnings.some((w) => /breakdown\.provider/.test(w)));
  assert.ok(bad.warnings.some((w) => /breakdown\.decision/.test(w)));

  // resolveBreakdown builds a read-only spec, defaulting to the watch block's provider/model.
  writeFileSync(paths.config, JSON.stringify({ breakdown: { enabled: true, decision: 'llm', model: '' }, watch: { provider: 'fake', model: 'watch-model' } }));
  const cfg = loadConfig(paths, {}).config;
  const rb = resolveBreakdown(cfg);
  assert.equal(rb.spec.providerName, 'fake');
  assert.equal(rb.spec.model, 'watch-model');
  assert.equal(rb.spec.autoApprove, false);
  assert.equal(rb.spec.sources.provider, 'watch');
  assert.equal(rb.spec.sources.model, 'watch');

  const own = resolveBreakdown({ ...cfg, breakdown: { ...cfg.breakdown, provider: 'fake', model: 'own-model' } });
  assert.equal(own.spec.model, 'own-model');
  assert.equal(own.spec.sources.model, 'breakdown');
  assert.equal(own.spec.autoApprove, false);
});
