import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, resolveSession } from '../src/config.js';
import { runDoctor } from '../src/doctor.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import { getProvider } from '../src/providers/index.js';
import { loadState, type State } from '../src/state.js';

function project(): { dir: string; paths: Paths; state: State } {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-doctor-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [ ] T01 — One\n');
  writeFileSync(join(paths.tasksDir, '01-one.md'), '# T01 — One\n\n## Goal\nx\n\n## Scope\n- a\n\n## Done when\n- pass\n\n## Hand-off\n_(tbd)_\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  return { dir, paths, state: loadState(paths) };
}

test('doctor warns when no verify command or test script exists, and reports an inferred one', () => {
  const { dir, paths, state } = project();
  const config = { ...DEFAULTS, provider: 'fake' as const };
  const spec = resolveSession(config, undefined, {}, {}).spec;
  const base = { paths, config, state, spec, provider: getProvider('fake'), taskCount: 1 };

  const before = runDoctor(base);
  const verify = before.find((c) => c.name === 'verify');
  assert.equal(verify?.level, 'warn');
  assert.match(verify?.detail ?? '', /self-reported|not independently checked/);

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const after = runDoctor(base);
  assert.equal(after.find((c) => c.name === 'verify')?.level, 'ok');
  assert.match(after.find((c) => c.name === 'verify')?.detail ?? '', /npm test \[package\.json\]/);
});

test('doctor checks every provider a run will use, not just the first', () => {
  const { paths, state } = project();
  const config = { ...DEFAULTS, provider: 'fake' as const };
  const spec = resolveSession(config, undefined, {}, {}).spec;
  const missing = { ...spec, providerName: 'gemini' as const, bin: 'symphony-no-such-binary-xyz' };
  const checks = runDoctor({
    paths, config, state, spec, provider: getProvider('fake'),
    extraProviders: [{ spec: missing, provider: getProvider('gemini'), label: 'T02' }],
  });
  const fail = checks.find((c) => c.level === 'fail');
  assert.ok(fail, `expected a failure, got ${JSON.stringify(checks)}`);
  assert.match(fail.detail, /gemini/);
  assert.match(fail.detail, /T02/);
});

test('doctor fails clearly when a configured binary path does not exist', () => {
  const { dir, paths, state } = project();
  const config = { ...DEFAULTS, provider: 'fake' as const };
  const spec = { ...resolveSession(config, undefined, {}, {}).spec, providerName: 'opencode' as const, bin: join(dir, 'no-such-opencode') };
  const checks = runDoctor({ paths, config, state, spec, provider: getProvider('opencode') });
  const fail = checks.find((c) => c.level === 'fail' && c.name === 'provider');
  assert.match(fail?.detail ?? '', /configured binary .* not found at/);
});

test('doctor reports MCP scoping: defined servers, name-only entries and unsupported clients', () => {
  const { paths, state } = project();
  const config = {
    ...DEFAULTS,
    provider: 'fake' as const,
    mcp: {
      ...DEFAULTS.mcp,
      enabled: true,
      servers: { ghidra: { command: [process.execPath] }, ghost: {} },
      defaultServers: ['ghidra'],
    },
  };
  const spec = resolveSession(config, undefined, {}, {}).spec;
  const checks = runDoctor({ paths, config, state, spec, provider: getProvider('fake') });
  const mcp = checks.filter((c) => c.name === 'mcp');
  assert.ok(mcp.length >= 2, `expected mcp checks, got ${JSON.stringify(checks)}`);
  assert.ok(mcp.some((c) => /cannot scope MCP per session/.test(c.detail)), 'fake provider cannot scope MCP');
  assert.ok(mcp.some((c) => /without a command\/url/.test(c.detail) && /ghost/.test(c.detail)));

  const off = runDoctor({ paths, config: { ...config, mcp: { ...config.mcp, enabled: false } }, state, spec, provider: getProvider('fake') });
  assert.equal(off.filter((c) => c.name === 'mcp').length, 0, 'nothing is reported while MCP selection is off');
});

test('doctor fails on a lock held by a live process and on a sticky halt', async () => {
  const { paths, state } = project();
  mkdirSync(paths.symphony, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
  try {
    assert.ok(child.pid, 'child process did not start');
    writeFileSync(paths.lock, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), heartbeat: new Date().toISOString() }));
    const checks = runDoctor({ paths, config: { ...DEFAULTS, provider: 'fake' }, state });
    assert.ok(checks.some((c) => c.level === 'fail' && /another run/.test(c.detail)));
    state.halted = { at: new Date().toISOString(), category: 'auth', reason: 'nope' };
    const halted = runDoctor({ paths, config: { ...DEFAULTS, provider: 'fake' }, state });
    assert.ok(halted.some((c) => c.level === 'fail' && c.name === 'halt'));
  } finally {
    child.kill();
  }
});

test('doctor reports the breakdown block: stages, decision chain and rules', () => {
  const { paths, state } = project();
  const off = runDoctor({ paths, config: { ...DEFAULTS, provider: 'fake' }, state });
  assert.equal(off.find((c) => c.name === 'breakdown'), undefined, 'silent while the block is off');

  const config = {
    ...DEFAULTS, provider: 'fake' as const,
    breakdown: { ...DEFAULTS.breakdown, enabled: true, onStart: true, decision: 'auto' as const },
  };
  const checks = runDoctor({ paths, config, state });
  const line = checks.find((c) => c.name === 'breakdown');
  assert.equal(line?.level, 'ok');
  assert.match(line?.detail ?? '', /on start\/continue\/failure/);
  assert.match(line?.detail ?? '', /decision auto \(jev → opencode · openrouter\/deepseek\/deepseek-v4\.1-flash → rules\)/);
  assert.match(line?.detail ?? '', /max 1 per task/);

  // Enabled but no stage on is a warning, not a failure.
  const noStage = runDoctor({ paths, config: { ...config, breakdown: { ...config.breakdown, onStart: false, onContinue: false, onFailure: false } }, state });
  assert.equal(noStage.find((c) => c.name === 'breakdown')?.level, 'warn');
  assert.match(noStage.find((c) => c.name === 'breakdown')?.detail ?? '', /nothing will trigger/);
});

test('doctor halt advice names --retry for an attempts halt, clear-halt otherwise', () => {
  const { paths, state } = project();
  const config = { ...DEFAULTS, provider: 'fake' as const };
  state.halted = { at: new Date().toISOString(), taskId: 'T03', category: 'attempts', reason: 'T03 has failed 3 times' };
  const attempts = runDoctor({ paths, config, state }).find((c) => c.name === 'halt')?.detail ?? '';
  assert.match(attempts, /--retry --only T03/);
  state.halted = { at: new Date().toISOString(), category: 'auth', reason: 'no key' };
  const auth = runDoctor({ paths, config, state }).find((c) => c.name === 'halt')?.detail ?? '';
  assert.match(auth, /symphony clear-halt/);
  assert.doesNotMatch(auth, /--retry/);
});