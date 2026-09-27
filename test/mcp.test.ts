import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig, type Config } from '../src/config.js';
import { applyMcp, mcpPromptNote, planMcp, resolveMcpProfile } from '../src/mcp.js';
import { resolvePaths } from '../src/paths.js';
import type { ProviderName } from '../src/providers/types.js';
import type { Task } from '../src/tasks.js';

const taskWith = (meta: Record<string, string>): Task => ({ id: 'T01', num: 1, title: 'Investigate inventory', phase: 'Phase 1', order: 0, meta });

const configWith = (mcp: Partial<Config['mcp']>): Config => ({
  ...DEFAULTS,
  mcp: { enabled: true, servers: {}, capabilities: {}, defaultServers: [], sessions: {}, ...mcp },
});

const outFile = (): string => join(mkdtempSync(join(tmpdir(), 'symphony-mcp-')), 'session');

test('resolveMcpProfile: off by default, precedence from flags through front matter to session defaults', () => {
  const off = { ...DEFAULTS };
  assert.equal(resolveMcpProfile(off, 'task', undefined, {}), undefined, 'the master switch is off');

  const cfg = configWith({
    servers: { alpha: { command: ['alpha-mcp'] }, beta: { command: ['beta-mcp'] }, gamma: { command: ['gamma-mcp'] }, delta: { url: 'http://127.0.0.1:8080/mcp' } },
    capabilities: { analysis: ['alpha', 'beta'] },
    defaultServers: ['gamma'],
    sessions: { watch: ['alpha'], breakdown: [] },
  });
  assert.deepEqual(resolveMcpProfile(cfg, 'task', undefined, {})!.selected, ['gamma'], 'task falls back to defaultServers');
  assert.deepEqual(resolveMcpProfile(cfg, 'watch', undefined, {})!.selected, ['alpha'], 'a configured session kind wins');
  assert.deepEqual(resolveMcpProfile(cfg, 'breakdown', undefined, {})!.selected, [], 'an explicit empty list means none');
  assert.deepEqual(resolveMcpProfile(cfg, 'prepare', undefined, {})!.selected, [], 'an unset non-task kind means none');
  assert.deepEqual(resolveMcpProfile(cfg, 'escalation', undefined, {})!.selected, ['gamma'], 'escalation inherits the task default');
  assert.deepEqual(resolveMcpProfile(cfg, 'task', taskWith({ capabilities: 'analysis' }), {})!.selected, ['alpha', 'beta']);
  assert.deepEqual(resolveMcpProfile(cfg, 'task', taskWith({ mcp: 'delta' }), {})!.selected, ['delta']);
  // `mcp:` and `capabilities:` are unioned and deduped.
  assert.deepEqual(resolveMcpProfile(cfg, 'task', taskWith({ mcp: 'alpha', capabilities: 'analysis' }), {})!.selected, ['alpha', 'beta']);
  // CLI flags beat front matter and config.
  assert.deepEqual(resolveMcpProfile(cfg, 'task', taskWith({ mcp: 'delta' }), { mcp: ['gamma'] })!.selected, ['gamma']);
  assert.deepEqual(resolveMcpProfile(cfg, 'task', taskWith({ mcp: 'delta' }), { noMcp: true })!.selected, []);
  assert.equal(resolveMcpProfile(cfg, 'task', taskWith({ mcp: 'delta' }), {})!.source, 'task front matter');

  const warnings: string[] = [];
  assert.deepEqual(resolveMcpProfile(cfg, 'task', taskWith({ capabilities: 'nope' }), {}, (m) => warnings.push(m))!.selected, []);
  assert.equal(warnings.length, 1);
});

test('the plan label states why a session has no servers, in plain words', () => {
  // An unset session kind is spelled out, so `none` cannot be mistaken for MCP being off.
  const watch = planMcp(configWith({}), 'watch', undefined, {}, 'gemini', outFile())!;
  assert.equal(watch.label, 'mcp: none — the watch query gets no MCP tools; set mcp.sessions.watch to add some');

  const explicitEmpty = planMcp(configWith({ sessions: { watch: [] } }), 'watch', undefined, {}, 'gemini', outFile())!;
  assert.equal(explicitEmpty.label, 'mcp: none — mcp.sessions.watch is empty');

  const disabled = planMcp(configWith({ defaultServers: ['alpha'] }), 'task', undefined, { noMcp: true }, 'gemini', outFile())!;
  assert.equal(disabled.label, 'mcp: none — MCP is off for this run (--no-mcp)');

  const taskCfg = configWith({ defaultServers: ['alpha'] });
  const taskPlan = planMcp(taskCfg, 'task', undefined, {}, 'gemini', outFile())!;
  assert.equal(taskPlan.label, 'mcp: alpha [task/escalation default]');

  const front = planMcp(taskCfg, 'task', taskWith({ mcp: 'alpha' }), {}, 'gemini', outFile())!;
  assert.equal(front.label, 'mcp: alpha [task front matter]');
});

test('claude plan: strict config carries only the selected servers', () => {
  const cfg = configWith({
    servers: { alpha: { command: ['alpha-mcp', '--stdio'], env: { ALPHA_HOME: 'C:/alpha' } }, gamma: { command: ['gamma-mcp'] }, docs: { url: 'https://example.test/mcp' } },
    defaultServers: ['alpha'],
  });
  const out = outFile();
  const plan = planMcp(cfg, 'task', undefined, {}, 'claude', out)!;
  assert.deepEqual(plan.args, ['--mcp-config', `${out}.mcp.json`, '--strict-mcp-config']);
  const written = JSON.parse(readFileSync(`${out}.mcp.json`, 'utf8')) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(written.mcpServers), ['alpha']);
  assert.deepEqual(written.mcpServers.alpha, { command: 'alpha-mcp', args: ['--stdio'], env: { ALPHA_HOME: 'C:/alpha' } });

  // A selected server with no definition cannot be expressed in strict mode: it is noted and skipped.
  const nameOnly = planMcp(configWith({ defaultServers: ['ghost'] }), 'task', undefined, {}, 'claude', outFile())!;
  assert.deepEqual(JSON.parse(readFileSync(nameOnly.args[1], 'utf8')), { mcpServers: {} });
  assert.match(nameOnly.notes[0], /"ghost" has no command\/url/);
});

test('codex plan: -c overrides enable the selection and disable every defined server', () => {
  const cfg = configWith({
    servers: {
      alpha: { command: ['alpha-mcp', '--stdio'], env: { ALPHA_HOME: 'C:/alpha' }, tools: ['inspect'] },
      gamma: { command: ['gamma-mcp'] },
      delta: { url: 'http://127.0.0.1:8080/mcp' },
      ghost: {},
    },
    defaultServers: ['alpha'],
  });
  const plan = planMcp(cfg, 'task', undefined, {}, 'codex', outFile())!;
  const line = plan.args.join(' ');
  assert.ok(line.includes('mcp_servers.alpha.command="alpha-mcp"'));
  assert.ok(line.includes('mcp_servers.alpha.args=["--stdio"]'));
  assert.ok(line.includes('mcp_servers.alpha.env.ALPHA_HOME="C:/alpha"'));
  assert.ok(line.includes('mcp_servers.alpha.enabled_tools=["inspect"]'));
  assert.ok(line.includes('mcp_servers.alpha.enabled=true'));
  assert.ok(line.includes('mcp_servers.gamma.enabled=false'));
  assert.ok(line.includes('mcp_servers.delta.url="http://127.0.0.1:8080/mcp"'));
  assert.ok(line.includes('mcp_servers.delta.enabled=false'));
  assert.ok(!line.includes('mcp_servers.ghost'), 'a name-only server cannot be expressed (nor disabled) for codex');
  assert.ok(plan.notes.some((n) => /cannot disable "ghost"/.test(n)));
});

test('opencode plan: 1.x LOCAL/REMOTE entries ride in OPENCODE_CONFIG_CONTENT', () => {
  const cfg = configWith({
    servers: {
      alpha: { command: ['alpha-mcp'], env: { ALPHA_HOME: 'C:/alpha' } },
      gamma: { command: ['gamma-mcp'] },
      delta: { url: 'http://127.0.0.1:8080/mcp' },
    },
    defaultServers: ['alpha', 'delta'],
  });
  const plan = planMcp(cfg, 'task', undefined, {}, 'opencode', outFile())!;
  assert.deepEqual(plan.args, []);
  const content = JSON.parse(plan.env!.OPENCODE_CONFIG_CONTENT) as { mcp: Record<string, unknown> };
  assert.deepEqual(content.mcp.alpha, { type: 'local', command: ['alpha-mcp'], environment: { ALPHA_HOME: 'C:/alpha' }, enabled: true });
  assert.deepEqual(content.mcp.delta, { type: 'remote', url: 'http://127.0.0.1:8080/mcp', enabled: true });
  assert.deepEqual(content.mcp.gamma, { type: 'local', command: ['gamma-mcp'], enabled: false });
});

test('gemini plan is a complete allowlist; cursor/antigravity keep their own config', () => {
  const cfg = configWith({ servers: { alpha: { command: ['a'] }, gamma: { command: ['g'] } }, defaultServers: ['alpha'] });
  assert.deepEqual(applyMcp('gemini', resolveMcpProfile(cfg, 'task', undefined, {})!, outFile()).args, ['--allowed-mcp-server-names', 'alpha']);
  assert.deepEqual(applyMcp('gemini', resolveMcpProfile(cfg, 'watch', undefined, {})!, outFile()).args, ['--allowed-mcp-server-names'], 'an empty allowlist disables every server');

  for (const provider of ['cursor', 'antigravity'] as ProviderName[]) {
    const plan = applyMcp(provider, resolveMcpProfile(cfg, 'task', undefined, {})!, outFile());
    assert.deepEqual(plan.args, []);
    assert.deepEqual(plan.selected, ['alpha']);
    assert.match(plan.notes[0], /has no effect/);
  }
});

test('mcpPromptNote names the servers and only appears with a non-empty selection', () => {
  const cfg = configWith({ servers: { alpha: { command: ['a'] }, gamma: { command: ['g'] } }, defaultServers: ['alpha', 'gamma'] });
  const selected = resolveMcpProfile(cfg, 'task', undefined, {})!;
  assert.match(mcpPromptNote(selected) ?? '', /alpha, gamma/);
  assert.match(mcpPromptNote(selected) ?? '', /narrowest call/);
  assert.equal(mcpPromptNote(resolveMcpProfile(cfg, 'watch', undefined, {})!), undefined);
});

test('config parsing: the mcp block is validated and per-session overrides are typed', () => {
  const root = mkdtempSync(join(tmpdir(), 'symphony-mcp-cfg-'));
  mkdirSync(join(root, '.symphony'), { recursive: true });
  writeFileSync(join(root, '.symphony', 'symphony.config.json'), JSON.stringify({
    mcp: {
      enabled: true,
      servers: { alpha: { command: ['alpha-mcp'], tools: ['inspect', 'lookup'] }, ghost: {}, bad: { command: 'not-an-array' } },
      capabilities: { analysis: ['alpha', 'beta'] },
      defaultServers: ['alpha'],
      sessions: { watch: [], nonsense: ['x'] },
    },
  }));
  const { config, warnings } = loadConfig(resolvePaths(root));
  assert.equal(config.mcp.enabled, true);
  assert.deepEqual(config.mcp.servers.alpha, { command: ['alpha-mcp'], tools: ['inspect', 'lookup'] });
  assert.deepEqual(config.mcp.capabilities, { analysis: ['alpha', 'beta'] });
  assert.deepEqual(config.mcp.defaultServers, ['alpha']);
  assert.deepEqual(config.mcp.sessions, { watch: [] });
  assert.ok(warnings.some((w) => /mcp.sessions.nonsense/.test(w)));
  assert.ok(warnings.some((w) => /mcp.servers.ghost: no "command" or "url"/.test(w)));
  assert.ok(warnings.some((w) => /mcp.servers.bad.command/.test(w)));
  const profile = resolveMcpProfile(config, 'task', taskWith({ capabilities: 'analysis' }), {})!;
  assert.deepEqual(profile.selected, ['alpha', 'beta']);
});