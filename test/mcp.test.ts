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
    servers: { ghidra: { command: ['ghidra-mcp'] }, mesen: { command: ['mesen-mcp'] }, blender: { command: ['b-mcp'] }, unity: { url: 'http://127.0.0.1:8080/mcp' } },
    capabilities: { reverse_engineering: ['ghidra', 'mesen'] },
    defaultServers: ['blender'],
    sessions: { watch: ['ghidra'], breakdown: [] },
  });
  assert.deepEqual(resolveMcpProfile(cfg, 'task', undefined, {})!.selected, ['blender'], 'task falls back to defaultServers');
  assert.deepEqual(resolveMcpProfile(cfg, 'watch', undefined, {})!.selected, ['ghidra'], 'a configured session kind wins');
  assert.deepEqual(resolveMcpProfile(cfg, 'breakdown', undefined, {})!.selected, [], 'an explicit empty list means none');
  assert.deepEqual(resolveMcpProfile(cfg, 'prepare', undefined, {})!.selected, [], 'an unset non-task kind means none');
  assert.deepEqual(resolveMcpProfile(cfg, 'escalation', undefined, {})!.selected, ['blender'], 'escalation inherits the task default');
  assert.deepEqual(resolveMcpProfile(cfg, 'task', taskWith({ capabilities: 'reverse_engineering' }), {})!.selected, ['ghidra', 'mesen']);
  assert.deepEqual(resolveMcpProfile(cfg, 'task', taskWith({ mcp: 'unity' }), {})!.selected, ['unity']);
  // `mcp:` and `capabilities:` are unioned and deduped.
  assert.deepEqual(resolveMcpProfile(cfg, 'task', taskWith({ mcp: 'ghidra', capabilities: 'reverse_engineering' }), {})!.selected, ['ghidra', 'mesen']);
  // CLI flags beat front matter and config.
  assert.deepEqual(resolveMcpProfile(cfg, 'task', taskWith({ mcp: 'unity' }), { mcp: ['blender'] })!.selected, ['blender']);
  assert.deepEqual(resolveMcpProfile(cfg, 'task', taskWith({ mcp: 'unity' }), { noMcp: true })!.selected, []);
  assert.equal(resolveMcpProfile(cfg, 'task', taskWith({ mcp: 'unity' }), {})!.source, 'task front matter');

  const warnings: string[] = [];
  assert.deepEqual(resolveMcpProfile(cfg, 'task', taskWith({ capabilities: 'nope' }), {}, (m) => warnings.push(m))!.selected, []);
  assert.equal(warnings.length, 1);
});

test('claude plan: strict config carries only the selected servers', () => {
  const cfg = configWith({
    servers: { ghidra: { command: ['ghidra-mcp', '--stdio'], env: { GHIDRA_HOME: 'C:/g' } }, blender: { command: ['b-mcp'] }, docs: { url: 'https://example.test/mcp' } },
    defaultServers: ['ghidra'],
  });
  const out = outFile();
  const plan = planMcp(cfg, 'task', undefined, {}, 'claude', out)!;
  assert.deepEqual(plan.args, ['--mcp-config', `${out}.mcp.json`, '--strict-mcp-config']);
  const written = JSON.parse(readFileSync(`${out}.mcp.json`, 'utf8')) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(written.mcpServers), ['ghidra']);
  assert.deepEqual(written.mcpServers.ghidra, { command: 'ghidra-mcp', args: ['--stdio'], env: { GHIDRA_HOME: 'C:/g' } });

  // A selected server with no definition cannot be expressed in strict mode: it is noted and skipped.
  const nameOnly = planMcp(configWith({ defaultServers: ['ghost'] }), 'task', undefined, {}, 'claude', outFile())!;
  assert.deepEqual(JSON.parse(readFileSync(nameOnly.args[1], 'utf8')), { mcpServers: {} });
  assert.match(nameOnly.notes[0], /"ghost" has no command\/url/);
});

test('codex plan: -c overrides enable the selection and disable every defined server', () => {
  const cfg = configWith({
    servers: {
      ghidra: { command: ['ghidra-mcp', '--stdio'], env: { GHIDRA_HOME: 'C:/g' }, tools: ['decompile'] },
      blender: { command: ['b-mcp'] },
      unity: { url: 'http://127.0.0.1:8080/mcp' },
      ghost: {},
    },
    defaultServers: ['ghidra'],
  });
  const plan = planMcp(cfg, 'task', undefined, {}, 'codex', outFile())!;
  const line = plan.args.join(' ');
  assert.ok(line.includes('mcp_servers.ghidra.command="ghidra-mcp"'));
  assert.ok(line.includes('mcp_servers.ghidra.args=["--stdio"]'));
  assert.ok(line.includes('mcp_servers.ghidra.env.GHIDRA_HOME="C:/g"'));
  assert.ok(line.includes('mcp_servers.ghidra.enabled_tools=["decompile"]'));
  assert.ok(line.includes('mcp_servers.ghidra.enabled=true'));
  assert.ok(line.includes('mcp_servers.blender.enabled=false'));
  assert.ok(line.includes('mcp_servers.unity.url="http://127.0.0.1:8080/mcp"'));
  assert.ok(line.includes('mcp_servers.unity.enabled=false'));
  assert.ok(!line.includes('mcp_servers.ghost'), 'a name-only server cannot be expressed (nor disabled) for codex');
  assert.ok(plan.notes.some((n) => /cannot disable "ghost"/.test(n)));
});

test('opencode plan: 1.x LOCAL/REMOTE entries ride in OPENCODE_CONFIG_CONTENT', () => {
  const cfg = configWith({
    servers: {
      ghidra: { command: ['ghidra-mcp'], env: { GHIDRA_HOME: 'C:/g' } },
      blender: { command: ['b-mcp'] },
      unity: { url: 'http://127.0.0.1:8080/mcp' },
    },
    defaultServers: ['ghidra', 'unity'],
  });
  const plan = planMcp(cfg, 'task', undefined, {}, 'opencode', outFile())!;
  assert.deepEqual(plan.args, []);
  const content = JSON.parse(plan.env!.OPENCODE_CONFIG_CONTENT) as { mcp: Record<string, unknown> };
  assert.deepEqual(content.mcp.ghidra, { type: 'local', command: ['ghidra-mcp'], environment: { GHIDRA_HOME: 'C:/g' }, enabled: true });
  assert.deepEqual(content.mcp.unity, { type: 'remote', url: 'http://127.0.0.1:8080/mcp', enabled: true });
  assert.deepEqual(content.mcp.blender, { type: 'local', command: ['b-mcp'], enabled: false });
});

test('gemini plan is a complete allowlist; cursor/antigravity keep their own config', () => {
  const cfg = configWith({ servers: { ghidra: { command: ['g'] }, blender: { command: ['b'] } }, defaultServers: ['ghidra'] });
  assert.deepEqual(applyMcp('gemini', resolveMcpProfile(cfg, 'task', undefined, {})!, outFile()).args, ['--allowed-mcp-server-names', 'ghidra']);
  assert.deepEqual(applyMcp('gemini', resolveMcpProfile(cfg, 'watch', undefined, {})!, outFile()).args, ['--allowed-mcp-server-names'], 'an empty allowlist disables every server');

  for (const provider of ['cursor', 'antigravity'] as ProviderName[]) {
    const plan = applyMcp(provider, resolveMcpProfile(cfg, 'task', undefined, {})!, outFile());
    assert.deepEqual(plan.args, []);
    assert.deepEqual(plan.selected, ['ghidra']);
    assert.match(plan.notes[0], /has no effect/);
  }
});

test('mcpPromptNote names the servers and only appears with a non-empty selection', () => {
  const cfg = configWith({ servers: { ghidra: { command: ['g'] }, blender: { command: ['b'] } }, defaultServers: ['ghidra', 'blender'] });
  const selected = resolveMcpProfile(cfg, 'task', undefined, {})!;
  assert.match(mcpPromptNote(selected) ?? '', /ghidra, blender/);
  assert.match(mcpPromptNote(selected) ?? '', /narrowest call/);
  assert.equal(mcpPromptNote(resolveMcpProfile(cfg, 'watch', undefined, {})!), undefined);
});

test('config parsing: the mcp block is validated and per-session overrides are typed', () => {
  const root = mkdtempSync(join(tmpdir(), 'symphony-mcp-cfg-'));
  mkdirSync(join(root, '.symphony'), { recursive: true });
  writeFileSync(join(root, '.symphony', 'symphony.config.json'), JSON.stringify({
    mcp: {
      enabled: true,
      servers: { ghidra: { command: ['ghidra-mcp'], tools: ['decompile', 'symbols'] }, ghost: {}, bad: { command: 'not-an-array' } },
      capabilities: { reverse_engineering: ['ghidra', 'mesen'] },
      defaultServers: ['ghidra'],
      sessions: { watch: [], nonsense: ['x'] },
    },
  }));
  const { config, warnings } = loadConfig(resolvePaths(root));
  assert.equal(config.mcp.enabled, true);
  assert.deepEqual(config.mcp.servers.ghidra, { command: ['ghidra-mcp'], tools: ['decompile', 'symbols'] });
  assert.deepEqual(config.mcp.capabilities, { reverse_engineering: ['ghidra', 'mesen'] });
  assert.deepEqual(config.mcp.defaultServers, ['ghidra']);
  assert.deepEqual(config.mcp.sessions, { watch: [] });
  assert.ok(warnings.some((w) => /mcp.sessions.nonsense/.test(w)));
  assert.ok(warnings.some((w) => /mcp.servers.ghost: no "command" or "url"/.test(w)));
  assert.ok(warnings.some((w) => /mcp.servers.bad.command/.test(w)));
  const profile = resolveMcpProfile(config, 'task', taskWith({ capabilities: 'reverse_engineering' }), {})!;
  assert.deepEqual(profile.selected, ['ghidra', 'mesen']);
});