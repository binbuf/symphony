import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CliOverrides, Config, McpServerConfig, McpSessionKind } from './config.js';
import type { ProviderName } from './providers/types.js';
import type { Task } from './tasks.js';
import { ensureDir } from './util.js';

/** One session's resolved MCP selection, before it is translated for a specific client. */
export interface McpProfile {
  kind: McpSessionKind;
  /** Server names the session should see, in selection order. */
  selected: string[];
  /** Every server the harness can define, selected or not. */
  servers: Record<string, McpServerConfig>;
  /** Where the selection came from, for logs (`--mcp`, `task front matter`, `mcp.sessions.watch`, …). */
  source: string;
}

/** What a client needs to enforce a profile: extra argv, environment, and notes for the run log. */
export interface McpPlan {
  args: string[];
  env?: Record<string, string>;
  notes: string[];
  /** The selected server names, for the session log. */
  selected: string[];
  /** `mcp: alpha, beta [task front matter]` or `mcp: none — the watch query gets no MCP tools; set mcp.sessions.watch to add some`. */
  label: string;
}

/** Split a front-matter list (`alpha, beta` / `alpha beta`) into names. */
function splitList(s: string): string[] {
  return s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
}

/**
 * Resolve which MCP servers one session should see. Precedence: `--no-mcp` / `--mcp` > task front
 * matter (`mcp:` and `capabilities:`, unioned) > `mcp.sessions.<kind>` > `mcp.defaultServers` for a
 * task, none for every other kind. Returns undefined when the master switch is off, which leaves
 * the client's own MCP configuration untouched.
 */
export function resolveMcpProfile(
  config: Config,
  kind: McpSessionKind,
  task: Task | undefined,
  cli: CliOverrides,
  warn?: (m: string) => void,
): McpProfile | undefined {
  if (!config.mcp.enabled) return undefined;
  const meta = task?.meta ?? {};
  let selected: string[];
  let source: string;
  if (cli.noMcp) { selected = []; source = '--no-mcp'; }
  else if (cli.mcp !== undefined) { selected = cli.mcp; source = '--mcp'; }
  else if (meta.mcp !== undefined || meta.capabilities !== undefined) {
    selected = [];
    if (meta.mcp?.trim()) selected.push(...splitList(meta.mcp));
    for (const capability of meta.capabilities?.trim() ? splitList(meta.capabilities) : []) {
      const servers = config.mcp.capabilities[capability];
      if (!servers) { warn?.(`capability "${capability}" is not defined under mcp.capabilities`); continue; }
      selected.push(...servers);
    }
    source = 'task front matter';
  } else if (config.mcp.sessions[kind] !== undefined) {
    selected = config.mcp.sessions[kind]!;
    source = `mcp.sessions.${kind}`;
  } else if (kind === 'task' || kind === 'escalation') {
    // An escalated session inherits the task default (it is the same work on a stronger model);
    // every other session kind (watch, prepare, split, replan, breakdown) defaults to none.
    selected = config.mcp.defaultServers;
    source = 'mcp.defaultServers';
  } else {
    selected = [];
    source = `mcp.sessions.${kind} default`;
  }
  return { kind, selected: dedupe(selected), servers: config.mcp.servers, source };
}

/** A JSON string is a valid TOML basic string for the values a command/env/config carries here. */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

function tomlArray(xs: string[]): string {
  return `[${xs.map(tomlString).join(', ')}]`;
}

/** Claude Code `mcpServers` entry: a stdio command or a remote URL. */
function claudeEntry(s: McpServerConfig): Record<string, unknown> | undefined {
  if (s.command?.length) {
    return {
      command: s.command[0],
      ...(s.command.length > 1 ? { args: s.command.slice(1) } : {}),
      ...(s.env ? { env: s.env } : {}),
    };
  }
  if (s.url) return { type: 'http', url: s.url };
  return undefined;
}

/** How to name each session kind in a log line written for a person, not the config file. */
const KIND_NOUN: Record<McpSessionKind, string> = {
  task: 'task session',
  escalation: 'escalation session',
  watch: 'watch query',
  prepare: 'prepare session',
  split: 'split session',
  replan: 'replan session',
  breakdown: 'breakdown session',
  judge: 'judge session',
};

/** Where a non-empty selection came from: `mcp.defaultServers` reads as the task/escalation default. */
function describeSource(source: string): string {
  return source === 'mcp.defaultServers' ? 'task/escalation default' : source;
}

/**
 * One line for the run log. With servers it names them and their source; with none it says in plain
 * words why this session has no MCP tools, so an unset kind cannot be mistaken for MCP being off.
 */
function mcpLabel(profile: McpProfile): string {
  if (profile.selected.length) return `mcp: ${profile.selected.join(', ')} [${describeSource(profile.source)}]`;
  const kind = profile.kind;
  switch (profile.source) {
    case '--no-mcp': return 'mcp: none — MCP is off for this run (--no-mcp)';
    case '--mcp': return 'mcp: none — --mcp listed no servers';
    case 'task front matter': return 'mcp: none — the task names no MCP servers';
    case 'mcp.defaultServers': return 'mcp: none — mcp.defaultServers is empty';
    default:
      if (profile.source === `mcp.sessions.${kind} default`) return `mcp: none — the ${KIND_NOUN[kind]} gets no MCP tools; set mcp.sessions.${kind} to add some`;
      if (profile.source === `mcp.sessions.${kind}`) return `mcp: none — mcp.sessions.${kind} is empty`;
      return `mcp: none — no servers selected (${profile.source})`;
  }
}

/**
 * Translate a profile for one client.
 *
 * - `claude`: a generated `--mcp-config` file plus `--strict-mcp-config`, so the session sees
 *   exactly the selected servers (anything else the machine has is ignored). Selected servers need
 *   a definition.
 * - `codex`: `-c mcp_servers.<name>…` overrides. A server can only be disabled when the registry
 *   defines it, because Codex rejects an entry with no transport.
 * - `opencode` (2.x): `OPENCODE_CONFIG_CONTENT`, an inline config merged above project and global
 *   config. Entries carry the 2.x shape (`mcp.servers.<name>` with `type: "local" | "remote"`,
 *   `command`, `environment`, and the inverse `disabled`); names without a definition fall back to
 *   the CLI's own configuration.
 * - `gemini`: `--allowed-mcp-server-names`, which is a complete allowlist, so a name alone is
 *   enough to include or exclude a configured server.
 * - `cursor` / `antigravity`: no per-invocation MCP configuration; the CLI's own config is used.
 */
export function applyMcp(providerName: ProviderName, profile: McpProfile, outFile: string): McpPlan {
  const selected = new Set(profile.selected);
  const notes: string[] = [];
  const label = mcpLabel(profile);
  switch (providerName) {
    case 'claude': {
      const mcpServers: Record<string, unknown> = {};
      for (const name of profile.selected) {
        const entry = profile.servers[name] ? claudeEntry(profile.servers[name]) : undefined;
        if (!entry) {
          notes.push(`"${name}" has no command/url in mcp.servers; claude runs with strict MCP config, so it will not be available`);
          continue;
        }
        mcpServers[name] = entry;
      }
      const file = `${outFile}.mcp.json`;
      ensureDir(dirname(file));
      writeFileSync(file, `${JSON.stringify({ mcpServers }, null, 2)}\n`);
      return { args: ['--mcp-config', file, '--strict-mcp-config'], notes, selected: profile.selected, label };
    }
    case 'codex': {
      const args: string[] = [];
      for (const [name, s] of Object.entries(profile.servers)) {
        const on = selected.has(name);
        if (s.command?.length) {
          args.push('-c', `mcp_servers.${name}.command=${tomlString(s.command[0])}`);
          args.push('-c', `mcp_servers.${name}.args=${tomlArray(s.command.slice(1))}`);
          for (const [k, v] of Object.entries(s.env ?? {})) args.push('-c', `mcp_servers.${name}.env.${k}=${tomlString(v)}`);
          if (s.tools?.length) args.push('-c', `mcp_servers.${name}.enabled_tools=${tomlArray(s.tools)}`);
          if (s.disabledTools?.length) args.push('-c', `mcp_servers.${name}.disabled_tools=${tomlArray(s.disabledTools)}`);
          args.push('-c', `mcp_servers.${name}.enabled=${on}`);
        } else if (s.url) {
          args.push('-c', `mcp_servers.${name}.url=${tomlString(s.url)}`);
          args.push('-c', `mcp_servers.${name}.enabled=${on}`);
        } else if (!on) {
          notes.push(`cannot disable "${name}" for codex: add mcp.servers.${name}.command or .url`);
        }
      }
      return { args, notes, selected: profile.selected, label };
    }
    case 'opencode': {
      // OpenCode 2.x: servers live under `mcp.servers.<name>`, each `{ type: "local", command:
      // string[], environment?, disabled? }` or `{ type: "remote", url, disabled? }`. `disabled` is
      // the inverse of the old `enabled`. Emitted inline via OPENCODE_CONFIG_CONTENT, which merges
      // above global and project config, so a `disabled: true` entry overrides the user's server.
      const servers: Record<string, unknown> = {};
      for (const [name, s] of Object.entries(profile.servers)) {
        const on = selected.has(name);
        if (s.command?.length) {
          servers[name] = { type: 'local', command: s.command, ...(s.env ? { environment: s.env } : {}), disabled: !on };
        } else if (s.url) {
          servers[name] = { type: 'remote', url: s.url, disabled: !on };
        } else if (!on) {
          notes.push(`cannot disable "${name}" for opencode: add mcp.servers.${name}.command or .url`);
        }
      }
      for (const name of profile.selected) {
        const s = profile.servers[name];
        if (!servers[name] && !s?.command?.length && !s?.url) {
          notes.push(`"${name}" has no command/url in mcp.servers; opencode will only expose it if its own config defines it`);
        }
      }
      if (!Object.keys(servers).length) return { args: [], notes, selected: profile.selected, label };
      return { args: [], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { servers } }) }, notes, selected: profile.selected, label };
    }
    case 'gemini': {
      // Repeated values form the allowlist; no values is an empty allowlist (no servers).
      return { args: ['--allowed-mcp-server-names', ...profile.selected], notes, selected: profile.selected, label };
    }
    default:
      return { args: [], notes: [`mcp selection has no effect on ${providerName}; its own MCP config is used`], selected: profile.selected, label };
  }
}

/** Resolve and translate in one step; undefined when MCP is off, so callers can leave the CLI alone. */
export function planMcp(
  config: Config,
  kind: McpSessionKind,
  task: Task | undefined,
  cli: CliOverrides,
  providerName: ProviderName,
  outFile: string,
  warn?: (m: string) => void,
): McpPlan | undefined {
  const profile = resolveMcpProfile(config, kind, task, cli, warn);
  if (!profile) return undefined;
  return applyMcp(providerName, profile, outFile);
}

/**
 * A short prompt note for a task session with a non-empty selection: MCP results enter the
 * conversation permanently, so the model is asked to query narrowly.
 */
export function mcpPromptNote(profile: McpProfile): string | undefined {
  if (!profile.selected.length) return undefined;
  return `MCP: this session has ${profile.selected.length} MCP server(s) enabled (${profile.selected.join(', ')}). Prefer the narrowest call that answers the question — one function, one address range, one object — and ask for summaries rather than whole-project dumps; anything a tool returns stays in the conversation for the rest of the session.`;
}