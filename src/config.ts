import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PathOverrides, Paths } from './paths.js';
import type { ProviderName } from './providers/types.js';
import type { Task } from './tasks.js';
import { UsageError, fileExists, isRecord, parseTimeZone, type TimeZone } from './util.js';

export const PROVIDER_NAMES: ProviderName[] = ['claude', 'cursor', 'opencode', 'codex', 'gemini', 'antigravity', 'fake'];

export interface ProviderConfig {
  bin: string;
  model?: string;
  /**
   * The upstream provider a bare `model` runs on, for CLIs that address models as `provider/model`
   * (OpenCode). Symphony composes `modelProvider/model` before invoking the CLI, so configs can keep
   * `model` bare. Ignored by providers whose model is a bare id (Claude, Cursor, Codex, Gemini, …).
   */
  modelProvider?: string;
  /** Default reasoning-effort / variant for this provider (e.g. "high"). Ignored by providers without a knob. */
  variant?: string;
  extraArgs: string[];
  budgetUsd?: number;
  idleTimeoutMin?: number;
}

export interface HooksConfig {
  /** Run after every task finishes (done/failed/blocked/accepted), with the task in the environment. */
  afterTask?: string;
  /** Run when the run halts on a fatal error. */
  onHalt?: string;
  /** Run when a task reports `blocked`. */
  onBlocked?: string;
  /** Run once when `run` finishes, with SYMPHONY_EXIT set. */
  onRunEnd?: string;
}

export interface GitConfig {
  /** Before committing, append untracked ephemeral/secret files (node_modules/, .env*, *.log, …) to .gitignore. */
  autoIgnoreUntracked: boolean;
  /** Extra glob-ish basenames/segments to treat as ephemeral (e.g. "*.tfstate", "scratch"). */
  extraIgnore: string[];
}

/**
 * Escalation: when the workhorse model fails to *finish the task* (it reports `failed`, the
 * independent verify command rejects its `done`, or it burns through `maxContinuations`), give a
 * stronger provider/model a fresh shot instead of failing the task outright. Infrastructure
 * failures (auth, rate limits, timeouts, …) are never escalated — they are handled by the existing
 * retry/halt logic. Off by default so an existing run behaves exactly as before until you opt in.
 */
export interface EscalationConfig {
  enabled: boolean;
  /**
   * Provider the escalated sessions run on. Defaults to OpenCode, the provider that can reach the
   * shipped default model (GLM-5.3). Set it to your own provider for a same-provider model bump.
   */
  provider?: ProviderName;
  /** Model the escalation provider runs. For OpenCode this is a bare id; `modelProvider` names the upstream provider. */
  model: string;
  /** OpenCode only: upstream provider for a bare `model` (e.g. "openrouter"); defaults to the provider's own. */
  modelProvider?: string;
  /** How many escalation sessions a single task may take before it is failed for good. */
  maxAttempts: number;
  /** Failure categories that hand the task to the escalation model. */
  onCategories: string[];
}

/** Where a System One (Jev) decision call is routed. Only OpenRouter is built in. */
export const JEV_PROVIDERS = ['openrouter'] as const;
export type JevProviderName = (typeof JEV_PROVIDERS)[number];

/**
 * Optional Jev decision calls (TypeSafe's System One model) used as a fast fallback when a session
 * ends without a SYMPHONY_RESULT block: one cheap, typed classification instead of a whole resumed
 * nudge session. Off by default. When it is enabled but its API key is missing the run halts, so the
 * misconfiguration cannot be missed; a timeout or a low-confidence answer still falls back to the
 * deterministic path.
 */
export interface JevConfig {
  /** Master switch for every Jev workflow below. */
  enabled: boolean;
  /** Workflow: settle a session that ended cleanly without a SYMPHONY_RESULT block. */
  resultFallback: boolean;
  /** Workflow: place a failure the regex classifier could not (the `unknown` bucket). */
  failureTriage: boolean;
  /** Workflow: read the task + failure and decide whether escalating to the escalation model is worth it. */
  escalationDecision: boolean;
  /** Workflow: read the task and its progress and answer split / proceed / escalate / stop for an automatic breakdown. */
  breakdownDecision: boolean;
  provider: JevProviderName;
  /** Overrides the provider's base URL (e.g. a self-hosted gateway). */
  baseUrl?: string;
  /** System One model id; "jev-latest" tracks the newest Jev release. */
  model: string;
  /** Environment variable holding the bearer token. */
  apiKeyEnv: string;
  /** Hard cap on one decision call; on timeout the harness falls back to its deterministic path. */
  timeoutMs: number;
  /** Below this confidence the decision is discarded and the fallback runs instead. */
  minConfidence: number;
  /** Dispositions `resultFallback` is allowed to settle. Ending a task stays with the nudge by default. */
  acceptStatuses: string[];
}

/**
 * Optional vision tool: lets a task session analyze an image (a screenshot it captures, a photo, a
 * diagram) with a dedicated vision model and get a text description back. Off by default. The session
 * invokes it through the harness CLI (`symphony vision <image>`), so it works for every provider
 * without the agent needing its own image support. When enabled, every task prompt tells the session
 * the command exists.
 */
export interface VisionConfig {
  /** Master switch; off by default so an existing run behaves exactly as before until you opt in. */
  enabled: boolean;
  /** Router the vision request goes to. Only OpenRouter is built in. */
  provider: JevProviderName;
  /** Overrides the provider's base URL (e.g. a self-hosted gateway). */
  baseUrl?: string;
  /** Vision model id, e.g. "qwen/qwen3-vl-235b-a22b-instruct". */
  model: string;
  /** Environment variable holding the bearer token. */
  apiKeyEnv: string;
  /** Hard cap on one vision request; on timeout the command fails. */
  timeoutMs: number;
  /** Default instruction sent with an image when the caller passes none. */
  prompt: string;
  /** Largest image accepted, in bytes; a bigger file is rejected before it is uploaded. */
  maxImageBytes: number;
}

/**
 * Optional "pipeline watch": a separate, read-only LLM session the harness runs on a timer while a
 * run is in flight. It adds interpretation the TUI's live status table cannot show — how the run is
 * trending, where it looks fragile, what to expect — into the TUI's top panel and a dedicated log.
 * On by default; a failure never affects the run itself.
 */
export interface WatchConfig {
  /** Master switch. */
  enabled: boolean;
  /** How often to check, in minutes (the first check lands one interval after the run starts). */
  intervalMin: number;
  /** Provider the watcher runs on; independent of the run's provider. */
  provider: ProviderName;
  /** Model the watcher runs; empty = provider default. For OpenCode this is a bare id (see `modelProvider`). */
  model: string;
  /** OpenCode only: upstream provider for a bare `model` (e.g. "openrouter"); defaults to the provider's own. */
  modelProvider?: string;
  /**
   * Optional reasoning-effort override for the watcher model. Unset = the provider's default, which
   * avoids the synchronous provider-catalog lookup that validating a variant requires.
   */
  variant?: string;
  /** Hard wall clock for one check; on timeout the check is abandoned. */
  timeoutMin: number;
}

/**
 * Which lifecycle events post to Slack. Every event is gated twice: the master `slack.enabled`
 * switch and the event's own flag, so an integration can be armed without flooding a channel.
 */
export interface SlackEvents {
  /** The run acquired its lock and started its task queue. */
  runStart: boolean;
  /** A task started its first session this run (after any start-time breakdown). */
  taskStart: boolean;
  /** An automatic (or failure-time) breakdown replaced a task with subtasks. */
  taskSplit: boolean;
  /** A task failed and was handed to the escalation provider/model. */
  taskEscalated: boolean;
  /** A task finished `done` (its verify passed, if one is configured). */
  taskDone: boolean;
  /** A task session reported `continue` (a fresh slice is about to start). */
  taskContinue: boolean;
  /** A task finished `failed`. */
  taskFailed: boolean;
  /** A task finished `blocked` and needs a human. */
  taskBlocked: boolean;
  /**
   * The pipeline watcher produced a new in-progress read on the running task. Feature-flagged and
   * off by default; needs `watch.enabled` too, since it is the watcher that fires it.
   */
  watch: boolean;
  /** Reported run cost crossed the warning fraction of `maxCostUsdPerRun` (only when that cap is set). */
  budgetClose: boolean;
  /** Reported run cost reached `maxCostUsdPerRun` and the run halted (only when that cap is set). */
  budgetExceeded: boolean;
  /** The run halted on a fatal error (auth, billing, attempts, consecutive failures, …). */
  halt: boolean;
  /** `run` finished, whatever its exit code. */
  runEnd: boolean;
}

/**
 * Optional Slack notifications: post a short message to a channel or DM a user when a lifecycle
 * event fires. Off by default, and shipped with no channel/user so the example is workspace-agnostic.
 * Reached through the Slack Web API with the token named by `apiKeyEnv`; a missing token or a failed
 * post only warns and never breaks the run. A name target (`channel: "#general"`, `user: "@ada"`) is
 * resolved with `conversations.list` / `users.list`, so the token needs the matching read scope; an
 * id target (`C…`/`G…`, `U…`/`W…`) needs only `chat:write`.
 */
export interface SlackConfig {
  /** Master switch; off by default so an existing run behaves exactly as before until you opt in. */
  enabled: boolean;
  /** Environment variable holding the token (bot `xoxb-`, user `xoxp-`, or a workspace app token). */
  apiKeyEnv: string;
  /** Overrides the API base (`https://slack.com/api`), e.g. a gateway or a test double. */
  baseUrl?: string;
  /** Label shown in every message so several repos can share a channel; empty = the project folder name. */
  project: string;
  /** Channel to post to: an id (`C…`/`G…`/`D…`) or a `#name`. Empty = derive the target from `user`. */
  channel: string;
  /** User to notify: a user id (`U…`/`W…`), an `@handle`, or a bare handle. Empty = channel-only. */
  user: string;
  /** When both `channel` and `user` are set, prefix the message with `<@id>` so Slack pings the user. */
  mention: boolean;
  /** Which lifecycle events post. */
  events: SlackEvents;
  /** Hard cap on one notification, including target resolution; on timeout the post is abandoned. */
  timeoutMs: number;
}

/**
 * One MCP server the harness can describe to a client. A `command` (stdio) or `url` (remote) is
 * required for a client to be able to define the server inline; a name-only entry can still be
 * allowlisted by name (Gemini) or left to the client's own configuration.
 */
export interface McpServerConfig {
  /** Launcher plus arguments for a stdio server. */
  command?: string[];
  /** Endpoint for a remote/HTTP server, where the client supports one. */
  url?: string;
  /** Environment variables set for the server process, where the client supports them. */
  env?: Record<string, string>;
  /** Tool allowlist, where the client supports one (Codex `enabled_tools`). */
  tools?: string[];
  /** Tool denylist, where the client supports one (Codex `disabled_tools`). */
  disabledTools?: string[];
}

export const MCP_SESSION_KINDS = ['task', 'watch', 'prepare', 'replan', 'split', 'breakdown', 'escalation'] as const;
export type McpSessionKind = (typeof MCP_SESSION_KINDS)[number];

/**
 * Per-session MCP selection. Off by default: with `enabled: false` the harness never touches a
 * client's MCP configuration. When on, each session is spawned with only the servers its selection
 * names — clients that can express it get an allowlist, and servers the registry defines are
 * disabled for the ones that need a full entry to be disabled. Sessions that are not tasks
 * (pipeline watch, prepare/replan/split, breakdown, escalation) default to no servers unless
 * `sessions.<kind>` says otherwise.
 */
export interface McpConfig {
  /** Master switch. */
  enabled: boolean;
  /** Servers the harness can define to a client, keyed by the name the client uses. */
  servers: Record<string, McpServerConfig>;
  /** Capability name → server names, selectable from task front matter `capabilities:`. */
  capabilities: Record<string, string[]>;
  /** Servers a task runs with when it names neither `mcp:` nor `capabilities:`. */
  defaultServers: string[];
  /** Per session-kind selection; an unset `task` kind falls back to `defaultServers`, others to none. */
  sessions: Partial<Record<McpSessionKind, string[]>>;
}

/** The deterministic triggers that open a breakdown decision, per stage. */
export interface BreakdownRules {
  /** `onStart` trigger: only ask when the task file body is at least this many bytes (0 = every task). */
  minTaskBytes: number;
  /** `onContinue` trigger: ask once this many continuation sessions have already run (0 = after the first slice). */
  afterContinuations: number;
  /** `onFailure` trigger: ask once the task has failed at least this many sessions. */
  afterFailedAttempts: number;
  /** `onFailure` trigger: failure categories that open the decision. */
  onCategories: string[];
}

/**
 * Automatic task breakdown: when a task looks too big (before it starts, after a `continue` slice,
 * or instead of escalating a failure), one decision — Jev, a fallback LLM, or the deterministic
 * rules — breaks it into subtasks with the same machinery as `symphony split`, and the run resumes
 * on the children. Off by default; the rules are the always-available last resort in the chain.
 */
export interface BreakdownConfig {
  /** Master switch for every stage below. */
  enabled: boolean;
  /** Ask before running a task whether it should be broken down first. */
  onStart: boolean;
  /** Ask at each `continue` boundary whether to run the next slice or break the task down. */
  onContinue: boolean;
  /** Ask when a task fails / its verify rejects a `done` / continuations run out, instead of escalating first. */
  onFailure: boolean;
  rules: BreakdownRules;
  /**
   * Which decision source answers: `auto` tries Jev, then the fallback LLM, then the rules; the other
   * values pin one source (each still falls back to the rules when it has no usable answer).
   */
  decision: 'auto' | 'jev' | 'llm' | 'rules';
  /** Provider the fallback LLM decision runs on (defaults to the watch block's provider). */
  provider?: ProviderName;
  /** Model the fallback LLM runs (defaults to the watch block's model). */
  model: string;
  /** OpenCode only: upstream provider for a bare `model` (defaults to the watch block's). */
  modelProvider?: string;
  /** Optional reasoning-effort override for the fallback LLM. Unset = the provider's default. */
  variant?: string;
  /** Hard wall clock for one fallback-LLM decision; on timeout the rules answer. */
  timeoutMin: number;
  /** With `decision: rules`, break the task down rather than escalating when both are possible. */
  preferOverEscalation: boolean;
  /** How many automatic breakdowns one task may take in a single run (0 = unlimited). */
  maxPerTask: number;
}

/**
 * A named, independent task set. It has its own roadmap, tasks, progress, design and logs, plus
 * harness state isolated under `.symphony/sets/<name>/`, so task ids never collide with another set.
 * The base docs package stays the default; a set runs only when selected with `--set <name>`.
 */
export interface TaskSetConfig {
  name: string;
  /** Planning locations for this set, resolved independently of the base `paths`. */
  paths: PathOverrides;
}

export interface Config {
  provider: ProviderName;
  providers: Record<ProviderName, ProviderConfig>;
  /** Overrides for every user-facing location (docs, tasks, progress, design, adr, logs, stop, state, runs, log). */
  paths: PathOverrides;
  /** Additional, independent task sets selected with `--set <name>`. The base docs package is the default. */
  taskSets: TaskSetConfig[];
  autoApprove: boolean;
  /** Full-screen run view (status table + live output) when stdout/stdin is a terminal. `--no-tui` overrides. */
  tui: boolean;
  /**
   * Zone used for the start/end stamps in the TUI status area and the per-task log: `"local"` (the
   * machine's zone, the default), `"utc"`, or a fixed offset like `"+05:30"` / `"-8"`.
   */
  timeZone: TimeZone;
  nudge: boolean;
  timeoutMin: number;
  idleTimeoutMin: number;
  nudgeTimeoutMin: number;
  prepareTimeoutMin: number;
  maxProgressBytes: number;
  /** Maintain a "Key facts" digest at the top of PROGRESS.md and inline digest + recent sections instead of the raw tail. */
  progressDigest: boolean;
  /** Inline the design docs a task names in its Context / Design notes, not just list them. */
  inlineDesignDocs: boolean;
  /** Generate `docs/INDEX.md` (design-doc summaries + a source map) before each task and inline it. */
  repoMap: boolean;
  /** Byte cap for the inlined repo map. */
  maxIndexBytes: number;
  /** Byte cap for the inlined task file body. */
  maxTaskBytes: number;
  /** When false, the design/ and adr/ folders are neither required nor used: tasks run standalone. */
  designDocs: boolean;
  /** How many extra fresh sessions a task may take when it reports `continue` (subtask iteration). Counted across a `.stop` pause. */
  maxContinuations: number;
  /** Max total sessions (task + retries + continuations) a single task may use in one run before it fails. 0 = unlimited. */
  maxIterationsPerTask: number;
  /** Max tasks a single `run` invocation will process. 0 = unlimited. */
  maxTasksPerRun: number;
  /** Stop the run once the session cost reported during this invocation reaches this many USD. 0 = unlimited. */
  maxCostUsdPerRun: number;
  /** Commit after every session, including intermediate `continue` sessions. */
  commitPerSession: boolean;
  /** What to do when a task reports `blocked`: 'stop' for a human, or 'continue' to the next task. */
  onBlocked: 'stop' | 'continue';
  retry: {
    /** How many transient (rate limit, 5xx, dropped socket) retries a task may take before it fails for good. */
    maxAttempts: number;
    /** Fixed backoff schedule in seconds; used when `exponential` is false, index-clamped at the last entry. */
    backoffSec: number[];
    /** When true (default), delay with exponential backoff instead of the fixed `backoffSec` schedule. */
    exponential: boolean;
    /** First exponential delay, in seconds. */
    baseSec: number;
    /** Multiplier applied once per retry. */
    factor: number;
    /** Ceiling for any single wait, in seconds. */
    maxSec: number;
    /** Fractional randomisation applied to each wait (± this fraction), to avoid a synchronised retry storm. */
    jitter: number;
    /** When the provider supplies a Retry-After, wait at least that long. */
    honorRetryAfter: boolean;
  };
  halt: { maxConsecutiveFailures: number; maxAttemptsPerTask: number; onCategories: string[] };
  commitMessageTemplate: string;
  /** Shell command the harness runs itself after a task reports `done`; non-zero demotes it to failed. */
  verifyCommand?: string;
  /** Wall clock for the verify command. */
  verifyTimeoutMin: number;
  /** When no verifyCommand is configured, use the project's package.json test script (`npm test`) as the verify command. */
  inferVerify: boolean;
  hooks: HooksConfig;
  git: GitConfig;
  /** Second provider/model a failed task can be handed to. See EscalationConfig. */
  escalation: EscalationConfig;
  /** Optional Jev decision calls as a nudge fallback. See JevConfig. */
  jev: JevConfig;
  /** Optional image-analysis tool a task session can invoke. See VisionConfig. */
  vision: VisionConfig;
  /** Optional Slack notifications on lifecycle events. See SlackConfig. */
  slack: SlackConfig;
  /** Periodic read-only progress/health summary in the TUI. See WatchConfig. */
  watch: WatchConfig;
  /** Per-session MCP server selection. See McpConfig. */
  mcp: McpConfig;
  /** Automatic task breakdown at task start, at a `continue` boundary, or instead of escalating. See BreakdownConfig. */
  breakdown: BreakdownConfig;
}

export interface CliOverrides {
  provider?: string;
  model?: string;
  /** OpenCode only: upstream provider for a bare `--model` (e.g. "openrouter"). */
  modelProvider?: string;
  variant?: string;
  timeoutMin?: number;
  budgetUsd?: number;
  maxCostUsd?: number;
  /** `--mcp a,b`: explicit MCP server selection for this invocation (overrides task and config). */
  mcp?: string[];
  /** `--no-mcp`: run this invocation with no MCP servers at all. */
  noMcp?: boolean;
  safe?: boolean;
  noNudge?: boolean;
  maxTasks?: number;
  maxIterations?: number;
}

export const DEFAULTS: Config = {
  provider: 'claude',
  providers: {
    claude: { bin: 'claude', model: 'claude-opus-5', variant: 'high', extraArgs: [] },
    cursor: { bin: 'agent', model: 'claude-opus-5', extraArgs: [], idleTimeoutMin: 45 },
    opencode: { bin: 'opencode', model: 'claude-sonnet-4-5', modelProvider: 'anthropic', variant: 'high', extraArgs: [], idleTimeoutMin: 45 },
    codex: { bin: 'codex', model: 'gpt-6-sol', variant: 'high', extraArgs: [], idleTimeoutMin: 45 },
    gemini: { bin: 'gemini', model: 'gemini-3.1-pro-preview', extraArgs: [], idleTimeoutMin: 45 },
    antigravity: { bin: 'agy', model: 'gemini-3.1-pro-high', variant: 'high', extraArgs: [], idleTimeoutMin: 45 },
    fake: { bin: process.execPath, extraArgs: [] },
  },
  paths: {},
  taskSets: [],
  autoApprove: true,
  tui: true,
  timeZone: 'local',
  nudge: true,
  timeoutMin: 240,
  idleTimeoutMin: 20,
  nudgeTimeoutMin: 45,
  prepareTimeoutMin: 60,
  maxProgressBytes: 32768,
  progressDigest: true,
  inlineDesignDocs: true,
  repoMap: true,
  maxIndexBytes: 16384,
  maxTaskBytes: 32768,
  designDocs: true,
  maxContinuations: 4,
  maxIterationsPerTask: 0,
  maxTasksPerRun: 0,
  maxCostUsdPerRun: 0,
  commitPerSession: true,
  onBlocked: 'stop',
  retry: { maxAttempts: 8, backoffSec: [30, 120, 300], exponential: true, baseSec: 30, factor: 2, maxSec: 900, jitter: 0.2, honorRetryAfter: true },
  halt: {
    maxConsecutiveFailures: 2,
    maxAttemptsPerTask: 3,
    onCategories: ['auth', 'billing', 'usage_limit', 'model', 'config'],
  },
  commitMessageTemplate: '{id}: {title} [{status}]',
  verifyCommand: undefined,
  verifyTimeoutMin: 30,
  inferVerify: true,
  hooks: {},
  git: { autoIgnoreUntracked: true, extraIgnore: [] },
  escalation: {
    enabled: false,
    provider: 'opencode',
    model: 'z-ai/glm-5.3',
    modelProvider: 'openrouter',
    maxAttempts: 1,
    onCategories: ['task', 'verify'],
  },
  jev: {
    enabled: false,
    resultFallback: true,
    failureTriage: true,
    escalationDecision: true,
    breakdownDecision: true,
    provider: 'openrouter',
    model: 'jev-latest',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    timeoutMs: 4000,
    minConfidence: 0.7,
    acceptStatuses: ['done', 'continue'],
  },
  vision: {
    enabled: false,
    provider: 'openrouter',
    model: 'qwen/qwen3-vl-235b-a22b-instruct',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    timeoutMs: 60_000,
    prompt: 'Describe this image accurately for someone who cannot see it. If a specific question or focus follows, answer that first and include the visual evidence that supports it. Otherwise, describe the salient subjects, setting, visible actions, and spatial relationships; for screenshots, documents, charts, or diagrams, include important controls, labels, values, text, and connections as relevant. Quote only legible text, note uncertain or obscured details, and distinguish what is visible from inference. Do not claim identity, location, or behavior that the image does not establish.',
    maxImageBytes: 20 * 1024 * 1024,
  },
  slack: {
    enabled: false,
    apiKeyEnv: 'SLACK_BOT_TOKEN',
    project: '',
    channel: '',
    user: '',
    mention: true,
    events: {
      runStart: true,
      taskStart: true,
      taskSplit: true,
      taskEscalated: true,
      taskDone: true,
      taskContinue: true,
      taskFailed: true,
      taskBlocked: true,
      watch: false,
      budgetClose: true,
      budgetExceeded: true,
      halt: true,
      runEnd: true,
    },
    timeoutMs: 10_000,
  },
  watch: {
    enabled: true,
    intervalMin: 5,
    provider: 'opencode',
    model: 'deepseek/deepseek-v4.1-flash',
    modelProvider: 'openrouter',
    timeoutMin: 5,
  },
  mcp: {
    enabled: false,
    servers: {},
    capabilities: {},
    defaultServers: [],
    sessions: {},
  },
  breakdown: {
    enabled: false,
    onStart: false,
    onContinue: true,
    onFailure: true,
    rules: {
      minTaskBytes: 16384,
      afterContinuations: 1,
      afterFailedAttempts: 1,
      onCategories: ['task', 'verify'],
    },
    decision: 'auto',
    provider: undefined,
    model: '',
    modelProvider: undefined,
    timeoutMin: 5,
    preferOverEscalation: true,
    maxPerTask: 1,
  },
};

export interface LoadedConfig {
  config: Config;
  fileExists: boolean;
  warnings: string[];
}

function asProviderName(x: unknown, where: string): ProviderName {
  if (typeof x !== 'string' || !(PROVIDER_NAMES as string[]).includes(x)) {
    throw new UsageError(`${where}: unknown provider ${JSON.stringify(x)}; expected one of ${PROVIDER_NAMES.join(', ')}`);
  }
  return x as ProviderName;
}

function numberOr(x: unknown, fallback: number, where: string, warnings: string[]): number {
  if (x === undefined || x === null) return fallback;
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  warnings.push(`${where}: expected a number, got ${JSON.stringify(x)}; using ${fallback}`);
  return fallback;
}

/** Like numberOr, but a value that is not strictly positive falls back with a warning. */
function positiveOr(x: unknown, fallback: number, where: string, warnings: string[]): number {
  const n = numberOr(x, fallback, where, warnings);
  if (!(n > 0)) {
    warnings.push(`${where}: expected a positive number, got ${JSON.stringify(x ?? n)}; using ${fallback}`);
    return fallback;
  }
  return n;
}

/** Like numberOr, but a value below `min` falls back with a warning. */
function atLeastOr(x: unknown, fallback: number, min: number, where: string, warnings: string[]): number {
  const n = numberOr(x, fallback, where, warnings);
  if (!(n >= min)) {
    warnings.push(`${where}: expected a number >= ${min}, got ${JSON.stringify(x ?? n)}; using ${fallback}`);
    return fallback;
  }
  return n;
}

function boolOr(x: unknown, fallback: boolean, where: string, warnings: string[]): boolean {
  if (x === undefined || x === null) return fallback;
  if (typeof x === 'boolean') return x;
  warnings.push(`${where}: expected a boolean, got ${JSON.stringify(x)}; using ${fallback}`);
  return fallback;
}

function stringArray(x: unknown, fallback: string[], where: string, warnings: string[]): string[] {
  if (x === undefined || x === null) return fallback;
  if (Array.isArray(x) && x.every((v) => typeof v === 'string')) return x as string[];
  warnings.push(`${where}: expected an array of strings; using default`);
  return fallback;
}

function hookString(x: unknown, where: string, warnings: string[]): string | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x === 'string' && x.trim()) return x.trim();
  warnings.push(`${where}: expected a non-empty string; ignored`);
  return undefined;
}

const PATH_KEYS = ['docs', 'roadmap', 'progress', 'tasks', 'design', 'adr', 'logs', 'index', 'stop', 'state', 'runs', 'log'] as const;

function pathOverrides(x: unknown, warnings: string[], where = 'paths', ignore: readonly string[] = []): PathOverrides {
  if (x === undefined || x === null) return {};
  if (!isRecord(x)) { warnings.push(`${where}: expected an object; using defaults`); return {}; }
  const out: PathOverrides = {};
  for (const k of PATH_KEYS) {
    const v = x[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    else warnings.push(`${where}.${k}: expected a non-empty string; using default`);
  }
  for (const k of Object.keys(x)) if (!(PATH_KEYS as readonly string[]).includes(k) && !k.startsWith('_') && !ignore.includes(k)) warnings.push(`${where}.${k}: unknown key ignored`);
  return out;
}

/** A task-set name becomes a directory under `.symphony/sets/`, so keep it path-safe. */
const TASK_SET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parse the `taskSets` array. Each entry names a set and gives its own `paths`-style overrides.
 * A set that names neither `docs` nor `roadmap` would silently reuse the base package, so it is
 * rejected with a warning rather than run twice.
 */
function taskSetList(x: unknown, warnings: string[]): TaskSetConfig[] {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) { warnings.push('taskSets: expected an array; ignoring'); return []; }
  const out: TaskSetConfig[] = [];
  const seen = new Set<string>();
  x.forEach((raw, i) => {
    const where = `taskSets[${i}]`;
    if (!isRecord(raw)) { warnings.push(`${where}: expected an object; ignored`); return; }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) { warnings.push(`${where}: missing a non-empty "name"; ignored`); return; }
    if (!TASK_SET_NAME_RE.test(name)) { warnings.push(`${where}: name ${JSON.stringify(name)} must match ${TASK_SET_NAME_RE}; ignored`); return; }
    if (seen.has(name)) { warnings.push(`${where}: duplicate task set "${name}"; ignored`); return; }
    seen.add(name);
    const paths = pathOverrides(raw, warnings, where, ['name']);
    if (paths.docs === undefined && paths.roadmap === undefined) {
      warnings.push(`${where} ("${name}"): a set needs "docs" or "roadmap" so it does not reuse the base package; ignored`);
      return;
    }
    out.push({ name, paths });
  });
  return out;
}

/** The declared task set with this name, if any. */
export function findTaskSet(config: Config, name: string): TaskSetConfig | undefined {
  return config.taskSets.find((s) => s.name === name);
}

/** A non-empty array of strings, else the fallback with a warning. */
function mcpNames(x: unknown, fallback: string[], where: string, warnings: string[]): string[] {
  return stringArray(x, fallback, where, warnings).map((s) => s.trim()).filter(Boolean);
}

/** One client-side MCP server definition; a malformed entry is dropped with a warning. */
function mcpServer(where: string, x: unknown, warnings: string[]): McpServerConfig | undefined {
  if (!isRecord(x)) { warnings.push(`${where}: expected an object; ignored`); return undefined; }
  const out: McpServerConfig = {};
  const command = x.command === undefined || x.command === null ? undefined : mcpNames(x.command, [], `${where}.command`, warnings);
  if (command?.length) out.command = command;
  if (typeof x.url === 'string' && x.url.trim()) out.url = x.url.trim();
  if (x.env !== undefined && x.env !== null) {
    if (isRecord(x.env) && Object.values(x.env).every((v) => typeof v === 'string')) out.env = x.env as Record<string, string>;
    else warnings.push(`${where}.env: expected an object of strings; ignored`);
  }
  if (x.tools !== undefined && x.tools !== null) {
    const tools = mcpNames(x.tools, [], `${where}.tools`, warnings);
    if (tools.length) out.tools = tools;
  }
  if (x.disabledTools !== undefined && x.disabledTools !== null) {
    const tools = mcpNames(x.disabledTools, [], `${where}.disabledTools`, warnings);
    if (tools.length) out.disabledTools = tools;
  }
  if (!out.command?.length && !out.url) {
    warnings.push(`${where}: no "command" or "url"; clients that define servers inline cannot enable or disable it by name alone (Gemini's allowlist still can)`);
  }
  return out;
}

function mcpServerList(x: unknown, warnings: string[]): Record<string, McpServerConfig> {
  if (x === undefined || x === null) return {};
  if (!isRecord(x)) { warnings.push('mcp.servers: expected an object; ignoring'); return {}; }
  const out: Record<string, McpServerConfig> = {};
  for (const [name, val] of Object.entries(x)) {
    if (name.startsWith('_')) continue;
    const parsed = mcpServer(`mcp.servers.${name}`, val, warnings);
    if (parsed) out[name] = parsed;
  }
  return out;
}

function mcpCapabilityMap(x: unknown, warnings: string[]): Record<string, string[]> {
  if (x === undefined || x === null) return {};
  if (!isRecord(x)) { warnings.push('mcp.capabilities: expected an object; ignoring'); return {}; }
  const out: Record<string, string[]> = {};
  for (const [name, val] of Object.entries(x)) {
    if (name.startsWith('_')) continue;
    const servers = mcpNames(val, [], `mcp.capabilities.${name}`, warnings);
    if (!servers.length) warnings.push(`mcp.capabilities.${name}: expected an array of server names; ignored`);
    else out[name] = servers;
  }
  return out;
}

function mcpSessions(x: unknown, warnings: string[]): Partial<Record<McpSessionKind, string[]>> {
  if (x === undefined || x === null) return {};
  if (!isRecord(x)) { warnings.push('mcp.sessions: expected an object; ignoring'); return {}; }
  const out: Partial<Record<McpSessionKind, string[]>> = {};
  for (const [name, val] of Object.entries(x)) {
    if (name.startsWith('_')) continue;
    if (!(MCP_SESSION_KINDS as readonly string[]).includes(name)) {
      warnings.push(`mcp.sessions.${name}: unknown session kind; expected one of ${MCP_SESSION_KINDS.join(', ')}`);
      continue;
    }
    out[name as McpSessionKind] = mcpNames(val, [], `mcp.sessions.${name}`, warnings);
  }
  return out;
}

/** Merge defaults ← config file ← CLI flags. Missing file = defaults. */
export function loadConfig(paths: Paths, cli: CliOverrides = {}): LoadedConfig {
  const warnings: string[] = [];
  let raw: Record<string, unknown> = {};
  const exists = fileExists(paths.config);
  if (exists) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(paths.config, 'utf8'));
    } catch (e) {
      throw new UsageError(`${paths.config}: invalid JSON (${(e as Error).message})`);
    }
    if (!isRecord(parsed)) throw new UsageError(`${paths.config}: expected a JSON object at the top level`);
    raw = parsed;
  }

  const known = new Set(Object.keys(DEFAULTS));
  for (const k of Object.keys(raw)) if (!known.has(k) && !k.startsWith('_')) warnings.push(`symphony.config.json: unknown key "${k}" ignored`);

  const providers = { ...DEFAULTS.providers } as Record<ProviderName, ProviderConfig>;
  if (raw.providers !== undefined) {
    if (!isRecord(raw.providers)) throw new UsageError('symphony.config.json: "providers" must be an object');
    for (const [name, val] of Object.entries(raw.providers)) {
      if (name.startsWith('_')) continue;
      const pn = asProviderName(name, 'symphony.config.json providers');
      if (!isRecord(val)) throw new UsageError(`symphony.config.json: providers.${name} must be an object`);
      const base = providers[pn];
      let modelProvider = typeof val.modelProvider === 'string' && val.modelProvider.trim() ? val.modelProvider.trim() : base.modelProvider;
      if (modelProvider && pn !== 'opencode') {
        warnings.push(`providers.${name}.modelProvider is only used by opencode; ignored`);
        modelProvider = undefined;
      }
      providers[pn] = {
        bin: typeof val.bin === 'string' && val.bin ? val.bin : base.bin,
        model: typeof val.model === 'string' && val.model ? val.model : base.model,
        modelProvider,
        variant: typeof val.variant === 'string' && val.variant ? val.variant : base.variant,
        extraArgs: stringArray(val.extraArgs, base.extraArgs, `providers.${name}.extraArgs`, warnings),
        budgetUsd: val.budgetUsd === undefined || val.budgetUsd === null ? base.budgetUsd : numberOr(val.budgetUsd, 0, `providers.${name}.budgetUsd`, warnings),
        idleTimeoutMin: val.idleTimeoutMin === undefined || val.idleTimeoutMin === null ? base.idleTimeoutMin : atLeastOr(val.idleTimeoutMin, DEFAULTS.idleTimeoutMin, 0, `providers.${name}.idleTimeoutMin`, warnings),
      };
    }
  }

  const retryRaw = isRecord(raw.retry) ? raw.retry : {};
  const haltRaw = isRecord(raw.halt) ? raw.halt : {};
  const hooksRaw = isRecord(raw.hooks) ? raw.hooks : {};
  const gitRaw = isRecord(raw.git) ? raw.git : {};
  const escRaw = isRecord(raw.escalation) ? raw.escalation : {};
  const jevRaw = isRecord(raw.jev) ? raw.jev : {};
  const visionRaw = isRecord(raw.vision) ? raw.vision : {};
  const slackRaw = isRecord(raw.slack) ? raw.slack : {};
  const slackEventsRaw = isRecord(slackRaw.events) ? slackRaw.events : {};
  const watchRaw = isRecord(raw.watch) ? raw.watch : {};
  const mcpRaw = isRecord(raw.mcp) ? raw.mcp : {};
  const breakRaw = isRecord(raw.breakdown) ? raw.breakdown : {};
  const breakRulesRaw = isRecord(breakRaw.rules) ? breakRaw.rules : {};

  const config: Config = {
    provider: raw.provider === undefined ? DEFAULTS.provider : asProviderName(raw.provider, 'symphony.config.json provider'),
    providers,
    paths: pathOverrides(raw.paths, warnings),
    taskSets: taskSetList(raw.taskSets, warnings),
    autoApprove: boolOr(raw.autoApprove, DEFAULTS.autoApprove, 'autoApprove', warnings),
    tui: boolOr(raw.tui, DEFAULTS.tui, 'tui', warnings),
    timeZone: (() => {
      if (raw.timeZone === undefined || raw.timeZone === null) return DEFAULTS.timeZone;
      const tz = parseTimeZone(raw.timeZone);
      if (tz === undefined) {
        warnings.push(`timeZone: expected "local", "utc", or an offset like "+05:30", got ${JSON.stringify(raw.timeZone)}; using ${DEFAULTS.timeZone}`);
        return DEFAULTS.timeZone;
      }
      return tz;
    })(),
    nudge: boolOr(raw.nudge, DEFAULTS.nudge, 'nudge', warnings),
    timeoutMin: positiveOr(raw.timeoutMin, DEFAULTS.timeoutMin, 'timeoutMin', warnings),
    idleTimeoutMin: atLeastOr(raw.idleTimeoutMin, DEFAULTS.idleTimeoutMin, 0, 'idleTimeoutMin', warnings),
    nudgeTimeoutMin: positiveOr(raw.nudgeTimeoutMin, DEFAULTS.nudgeTimeoutMin, 'nudgeTimeoutMin', warnings),
    prepareTimeoutMin: positiveOr(raw.prepareTimeoutMin, DEFAULTS.prepareTimeoutMin, 'prepareTimeoutMin', warnings),
    maxProgressBytes: positiveOr(raw.maxProgressBytes, DEFAULTS.maxProgressBytes, 'maxProgressBytes', warnings),
    progressDigest: boolOr(raw.progressDigest, DEFAULTS.progressDigest, 'progressDigest', warnings),
    inlineDesignDocs: boolOr(raw.inlineDesignDocs, DEFAULTS.inlineDesignDocs, 'inlineDesignDocs', warnings),
    repoMap: boolOr(raw.repoMap, DEFAULTS.repoMap, 'repoMap', warnings),
    maxIndexBytes: positiveOr(raw.maxIndexBytes, DEFAULTS.maxIndexBytes, 'maxIndexBytes', warnings),
    maxTaskBytes: positiveOr(raw.maxTaskBytes, DEFAULTS.maxTaskBytes, 'maxTaskBytes', warnings),
    designDocs: boolOr(raw.designDocs, DEFAULTS.designDocs, 'designDocs', warnings),
    maxContinuations: Math.max(0, numberOr(raw.maxContinuations, DEFAULTS.maxContinuations, 'maxContinuations', warnings)),
    maxIterationsPerTask: Math.max(0, numberOr(raw.maxIterationsPerTask, DEFAULTS.maxIterationsPerTask, 'maxIterationsPerTask', warnings)),
    maxTasksPerRun: Math.max(0, numberOr(raw.maxTasksPerRun, DEFAULTS.maxTasksPerRun, 'maxTasksPerRun', warnings)),
    maxCostUsdPerRun: Math.max(0, numberOr(raw.maxCostUsdPerRun, DEFAULTS.maxCostUsdPerRun, 'maxCostUsdPerRun', warnings)),
    commitPerSession: boolOr(raw.commitPerSession, DEFAULTS.commitPerSession, 'commitPerSession', warnings),
    onBlocked: (() => {
      if (raw.onBlocked === undefined || raw.onBlocked === null) return DEFAULTS.onBlocked;
      if (raw.onBlocked === 'stop' || raw.onBlocked === 'continue') return raw.onBlocked;
      warnings.push(`onBlocked: expected "stop" or "continue", got ${JSON.stringify(raw.onBlocked)}; using ${DEFAULTS.onBlocked}`);
      return DEFAULTS.onBlocked;
    })(),
    retry: {
      maxAttempts: Math.max(1, numberOr(retryRaw.maxAttempts, DEFAULTS.retry.maxAttempts, 'retry.maxAttempts', warnings)),
      backoffSec: (() => {
        const arr = retryRaw.backoffSec;
        if (arr === undefined) return DEFAULTS.retry.backoffSec;
        if (Array.isArray(arr) && arr.length > 0 && arr.every((n) => typeof n === 'number' && n >= 0)) return arr as number[];
        warnings.push('retry.backoffSec: expected a non-empty array of numbers; using default');
        return DEFAULTS.retry.backoffSec;
      })(),
      exponential: boolOr(retryRaw.exponential, DEFAULTS.retry.exponential, 'retry.exponential', warnings),
      baseSec: positiveOr(retryRaw.baseSec, DEFAULTS.retry.baseSec, 'retry.baseSec', warnings),
      factor: (() => {
        const n = numberOr(retryRaw.factor, DEFAULTS.retry.factor, 'retry.factor', warnings);
        if (!(n > 1)) {
          warnings.push(`retry.factor: expected a number > 1, got ${JSON.stringify(retryRaw.factor ?? n)}; using ${DEFAULTS.retry.factor}`);
          return DEFAULTS.retry.factor;
        }
        return n;
      })(),
      maxSec: positiveOr(retryRaw.maxSec, DEFAULTS.retry.maxSec, 'retry.maxSec', warnings),
      jitter: (() => {
        const n = numberOr(retryRaw.jitter, DEFAULTS.retry.jitter, 'retry.jitter', warnings);
        if (n < 0 || n > 1) {
          warnings.push(`retry.jitter: expected a number between 0 and 1, got ${JSON.stringify(retryRaw.jitter ?? n)}; using ${DEFAULTS.retry.jitter}`);
          return DEFAULTS.retry.jitter;
        }
        return n;
      })(),
      honorRetryAfter: boolOr(retryRaw.honorRetryAfter, DEFAULTS.retry.honorRetryAfter, 'retry.honorRetryAfter', warnings),
    },
    halt: {
      maxConsecutiveFailures: numberOr(haltRaw.maxConsecutiveFailures, DEFAULTS.halt.maxConsecutiveFailures, 'halt.maxConsecutiveFailures', warnings),
      maxAttemptsPerTask: numberOr(haltRaw.maxAttemptsPerTask, DEFAULTS.halt.maxAttemptsPerTask, 'halt.maxAttemptsPerTask', warnings),
      onCategories: stringArray(haltRaw.onCategories, DEFAULTS.halt.onCategories, 'halt.onCategories', warnings),
    },
    commitMessageTemplate: typeof raw.commitMessageTemplate === 'string' && raw.commitMessageTemplate ? raw.commitMessageTemplate : DEFAULTS.commitMessageTemplate,
    verifyCommand: hookString(raw.verifyCommand, 'verifyCommand', warnings),
    verifyTimeoutMin: positiveOr(raw.verifyTimeoutMin, DEFAULTS.verifyTimeoutMin, 'verifyTimeoutMin', warnings),
    inferVerify: boolOr(raw.inferVerify, DEFAULTS.inferVerify, 'inferVerify', warnings),
    hooks: {
      afterTask: hookString(hooksRaw.afterTask, 'hooks.afterTask', warnings),
      onHalt: hookString(hooksRaw.onHalt, 'hooks.onHalt', warnings),
      onBlocked: hookString(hooksRaw.onBlocked, 'hooks.onBlocked', warnings),
      onRunEnd: hookString(hooksRaw.onRunEnd, 'hooks.onRunEnd', warnings),
    },
    git: {
      autoIgnoreUntracked: boolOr(gitRaw.autoIgnoreUntracked, DEFAULTS.git.autoIgnoreUntracked, 'git.autoIgnoreUntracked', warnings),
      extraIgnore: stringArray(gitRaw.extraIgnore, DEFAULTS.git.extraIgnore, 'git.extraIgnore', warnings),
    },
    escalation: (() => {
      const model = typeof escRaw.model === 'string' ? escRaw.model.trim() : DEFAULTS.escalation.model;
      let enabled = boolOr(escRaw.enabled, DEFAULTS.escalation.enabled, 'escalation.enabled', warnings);
      if (enabled && !model) {
        warnings.push('escalation.enabled is true but escalation.model is empty; escalation stays off');
        enabled = false;
      }
      const provider = escRaw.provider === undefined || escRaw.provider === null
        ? DEFAULTS.escalation.provider
        : asProviderName(escRaw.provider, 'symphony.config.json escalation.provider');
      let modelProvider = typeof escRaw.modelProvider === 'string' && escRaw.modelProvider.trim() ? escRaw.modelProvider.trim() : DEFAULTS.escalation.modelProvider;
      if (provider !== 'opencode' && modelProvider) {
        warnings.push('escalation.modelProvider is only used by opencode; ignored');
        modelProvider = undefined;
      }
      return {
        enabled,
        provider,
        model,
        modelProvider,
        maxAttempts: Math.max(0, numberOr(escRaw.maxAttempts, DEFAULTS.escalation.maxAttempts, 'escalation.maxAttempts', warnings)),
        onCategories: stringArray(escRaw.onCategories, DEFAULTS.escalation.onCategories, 'escalation.onCategories', warnings),
      };
    })(),
    jev: (() => {
      let provider: JevProviderName = DEFAULTS.jev.provider;
      if (jevRaw.provider !== undefined && jevRaw.provider !== null) {
        if (typeof jevRaw.provider === 'string' && (JEV_PROVIDERS as readonly string[]).includes(jevRaw.provider)) {
          provider = jevRaw.provider as JevProviderName;
        } else {
          warnings.push(`jev.provider: expected one of ${JEV_PROVIDERS.join(', ')}, got ${JSON.stringify(jevRaw.provider)}; using ${DEFAULTS.jev.provider}`);
        }
      }
      const model = typeof jevRaw.model === 'string' && jevRaw.model.trim() ? jevRaw.model.trim() : DEFAULTS.jev.model;
      let enabled = boolOr(jevRaw.enabled, DEFAULTS.jev.enabled, 'jev.enabled', warnings);
      if (enabled && !model) {
        warnings.push('jev.enabled is true but jev.model is empty; Jev stays off');
        enabled = false;
      }
      const acceptStatuses = stringArray(jevRaw.acceptStatuses, DEFAULTS.jev.acceptStatuses, 'jev.acceptStatuses', warnings).filter((s) => {
        if (['done', 'continue', 'blocked', 'failed'].includes(s)) return true;
        warnings.push(`jev.acceptStatuses: ignoring unknown status ${JSON.stringify(s)}`);
        return false;
      });
      return {
        enabled,
        resultFallback: boolOr(jevRaw.resultFallback, DEFAULTS.jev.resultFallback, 'jev.resultFallback', warnings),
        failureTriage: boolOr(jevRaw.failureTriage, DEFAULTS.jev.failureTriage, 'jev.failureTriage', warnings),
        escalationDecision: boolOr(jevRaw.escalationDecision, DEFAULTS.jev.escalationDecision, 'jev.escalationDecision', warnings),
        breakdownDecision: boolOr(jevRaw.breakdownDecision, DEFAULTS.jev.breakdownDecision, 'jev.breakdownDecision', warnings),
        provider,
        baseUrl: typeof jevRaw.baseUrl === 'string' && jevRaw.baseUrl.trim() ? jevRaw.baseUrl.trim() : undefined,
        model,
        apiKeyEnv: typeof jevRaw.apiKeyEnv === 'string' && jevRaw.apiKeyEnv.trim() ? jevRaw.apiKeyEnv.trim() : DEFAULTS.jev.apiKeyEnv,
        timeoutMs: positiveOr(jevRaw.timeoutMs, DEFAULTS.jev.timeoutMs, 'jev.timeoutMs', warnings),
        minConfidence: (() => {
          const n = numberOr(jevRaw.minConfidence, DEFAULTS.jev.minConfidence, 'jev.minConfidence', warnings);
          if (n < 0 || n > 1) {
            warnings.push(`jev.minConfidence: expected a number in 0..1, got ${JSON.stringify(jevRaw.minConfidence)}; using ${DEFAULTS.jev.minConfidence}`);
            return DEFAULTS.jev.minConfidence;
          }
          return n;
        })(),
        acceptStatuses,
      };
    })(),
    vision: (() => {
      let provider: JevProviderName = DEFAULTS.vision.provider;
      if (visionRaw.provider !== undefined && visionRaw.provider !== null) {
        if (typeof visionRaw.provider === 'string' && (JEV_PROVIDERS as readonly string[]).includes(visionRaw.provider)) {
          provider = visionRaw.provider as JevProviderName;
        } else {
          warnings.push(`vision.provider: expected one of ${JEV_PROVIDERS.join(', ')}, got ${JSON.stringify(visionRaw.provider)}; using ${DEFAULTS.vision.provider}`);
        }
      }
      const model = typeof visionRaw.model === 'string' && visionRaw.model.trim() ? visionRaw.model.trim() : DEFAULTS.vision.model;
      let enabled = boolOr(visionRaw.enabled, DEFAULTS.vision.enabled, 'vision.enabled', warnings);
      if (enabled && !model) {
        warnings.push('vision.enabled is true but vision.model is empty; vision stays off');
        enabled = false;
      }
      return {
        enabled,
        provider,
        baseUrl: typeof visionRaw.baseUrl === 'string' && visionRaw.baseUrl.trim() ? visionRaw.baseUrl.trim() : undefined,
        model,
        apiKeyEnv: typeof visionRaw.apiKeyEnv === 'string' && visionRaw.apiKeyEnv.trim() ? visionRaw.apiKeyEnv.trim() : DEFAULTS.vision.apiKeyEnv,
        timeoutMs: positiveOr(visionRaw.timeoutMs, DEFAULTS.vision.timeoutMs, 'vision.timeoutMs', warnings),
        prompt: typeof visionRaw.prompt === 'string' && visionRaw.prompt.trim() ? visionRaw.prompt.trim() : DEFAULTS.vision.prompt,
        maxImageBytes: positiveOr(visionRaw.maxImageBytes, DEFAULTS.vision.maxImageBytes, 'vision.maxImageBytes', warnings),
      };
    })(),
    slack: (() => {
      const channel = typeof slackRaw.channel === 'string' ? slackRaw.channel.trim() : DEFAULTS.slack.channel;
      const user = typeof slackRaw.user === 'string' ? slackRaw.user.trim() : DEFAULTS.slack.user;
      let enabled = boolOr(slackRaw.enabled, DEFAULTS.slack.enabled, 'slack.enabled', warnings);
      if (enabled && !channel && !user) {
        warnings.push('slack.enabled is true but neither slack.channel nor slack.user is set; Slack stays off');
        enabled = false;
      }
      return {
        enabled,
        apiKeyEnv: typeof slackRaw.apiKeyEnv === 'string' && slackRaw.apiKeyEnv.trim() ? slackRaw.apiKeyEnv.trim() : DEFAULTS.slack.apiKeyEnv,
        baseUrl: typeof slackRaw.baseUrl === 'string' && slackRaw.baseUrl.trim() ? slackRaw.baseUrl.trim() : undefined,
        project: typeof slackRaw.project === 'string' ? slackRaw.project.trim() : DEFAULTS.slack.project,
        channel,
        user,
        mention: boolOr(slackRaw.mention, DEFAULTS.slack.mention, 'slack.mention', warnings),
        events: {
          runStart: boolOr(slackEventsRaw.runStart, DEFAULTS.slack.events.runStart, 'slack.events.runStart', warnings),
          taskStart: boolOr(slackEventsRaw.taskStart, DEFAULTS.slack.events.taskStart, 'slack.events.taskStart', warnings),
          taskSplit: boolOr(slackEventsRaw.taskSplit, DEFAULTS.slack.events.taskSplit, 'slack.events.taskSplit', warnings),
          taskEscalated: boolOr(slackEventsRaw.taskEscalated, DEFAULTS.slack.events.taskEscalated, 'slack.events.taskEscalated', warnings),
          taskDone: boolOr(slackEventsRaw.taskDone, DEFAULTS.slack.events.taskDone, 'slack.events.taskDone', warnings),
          taskContinue: boolOr(slackEventsRaw.taskContinue, DEFAULTS.slack.events.taskContinue, 'slack.events.taskContinue', warnings),
          taskFailed: boolOr(slackEventsRaw.taskFailed, DEFAULTS.slack.events.taskFailed, 'slack.events.taskFailed', warnings),
          taskBlocked: boolOr(slackEventsRaw.taskBlocked, DEFAULTS.slack.events.taskBlocked, 'slack.events.taskBlocked', warnings),
          watch: boolOr(slackEventsRaw.watch, DEFAULTS.slack.events.watch, 'slack.events.watch', warnings),
          budgetClose: boolOr(slackEventsRaw.budgetClose, DEFAULTS.slack.events.budgetClose, 'slack.events.budgetClose', warnings),
          budgetExceeded: boolOr(slackEventsRaw.budgetExceeded, DEFAULTS.slack.events.budgetExceeded, 'slack.events.budgetExceeded', warnings),
          halt: boolOr(slackEventsRaw.halt, DEFAULTS.slack.events.halt, 'slack.events.halt', warnings),
          runEnd: boolOr(slackEventsRaw.runEnd, DEFAULTS.slack.events.runEnd, 'slack.events.runEnd', warnings),
        },
        timeoutMs: positiveOr(slackRaw.timeoutMs, DEFAULTS.slack.timeoutMs, 'slack.timeoutMs', warnings),
      };
    })(),
    watch: (() => {
      const model = typeof watchRaw.model === 'string' && watchRaw.model.trim() ? watchRaw.model.trim() : DEFAULTS.watch.model;
      let provider = DEFAULTS.watch.provider;
      if (watchRaw.provider !== undefined && watchRaw.provider !== null) {
        if (typeof watchRaw.provider === 'string' && (PROVIDER_NAMES as string[]).includes(watchRaw.provider)) {
          provider = watchRaw.provider as ProviderName;
        } else {
          warnings.push(`watch.provider: expected one of ${PROVIDER_NAMES.join(', ')}, got ${JSON.stringify(watchRaw.provider)}; using ${DEFAULTS.watch.provider}`);
        }
      }
      let enabled = boolOr(watchRaw.enabled, DEFAULTS.watch.enabled, 'watch.enabled', warnings);
      if (enabled && !model) {
        warnings.push('watch.enabled is true but watch.model is empty and the provider declares none; pipeline watch stays off');
        enabled = false;
      }
      let modelProvider = typeof watchRaw.modelProvider === 'string' && watchRaw.modelProvider.trim() ? watchRaw.modelProvider.trim() : DEFAULTS.watch.modelProvider;
      if (provider !== 'opencode' && modelProvider) {
        warnings.push('watch.modelProvider is only used by opencode; ignored');
        modelProvider = undefined;
      }
      return {
        enabled,
        intervalMin: positiveOr(watchRaw.intervalMin, DEFAULTS.watch.intervalMin, 'watch.intervalMin', warnings),
        provider,
        model,
        modelProvider,
        variant: (() => {
          const v = watchRaw.variant;
          if (v === undefined || v === null) return undefined;
          if (typeof v === 'string') return v.trim() || undefined;
          warnings.push(`watch.variant: expected a string, got ${JSON.stringify(v)}; using provider default`);
          return undefined;
        })(),
        timeoutMin: positiveOr(watchRaw.timeoutMin, DEFAULTS.watch.timeoutMin, 'watch.timeoutMin', warnings),
      };
    })(),
    mcp: {
      enabled: boolOr(mcpRaw.enabled, DEFAULTS.mcp.enabled, 'mcp.enabled', warnings),
      servers: mcpServerList(mcpRaw.servers, warnings),
      capabilities: mcpCapabilityMap(mcpRaw.capabilities, warnings),
      defaultServers: mcpNames(mcpRaw.defaultServers, DEFAULTS.mcp.defaultServers, 'mcp.defaultServers', warnings),
      sessions: mcpSessions(mcpRaw.sessions, warnings),
    },
    breakdown: (() => {
      let provider: ProviderName | undefined;
      if (breakRaw.provider !== undefined && breakRaw.provider !== null) {
        if (typeof breakRaw.provider === 'string' && (PROVIDER_NAMES as string[]).includes(breakRaw.provider)) {
          provider = breakRaw.provider as ProviderName;
        } else {
          warnings.push(`breakdown.provider: expected one of ${PROVIDER_NAMES.join(', ')}, got ${JSON.stringify(breakRaw.provider)}; using the watch provider`);
        }
      }
      const decision = (() => {
        const v = breakRaw.decision;
        if (v === undefined || v === null) return DEFAULTS.breakdown.decision;
        if (v === 'auto' || v === 'jev' || v === 'llm' || v === 'rules') return v;
        warnings.push(`breakdown.decision: expected "auto", "jev", "llm" or "rules", got ${JSON.stringify(v)}; using ${DEFAULTS.breakdown.decision}`);
        return DEFAULTS.breakdown.decision;
      })();
      return {
        enabled: boolOr(breakRaw.enabled, DEFAULTS.breakdown.enabled, 'breakdown.enabled', warnings),
        onStart: boolOr(breakRaw.onStart, DEFAULTS.breakdown.onStart, 'breakdown.onStart', warnings),
        onContinue: boolOr(breakRaw.onContinue, DEFAULTS.breakdown.onContinue, 'breakdown.onContinue', warnings),
        onFailure: boolOr(breakRaw.onFailure, DEFAULTS.breakdown.onFailure, 'breakdown.onFailure', warnings),
        rules: {
          minTaskBytes: Math.max(0, numberOr(breakRulesRaw.minTaskBytes, DEFAULTS.breakdown.rules.minTaskBytes, 'breakdown.rules.minTaskBytes', warnings)),
          afterContinuations: Math.max(0, numberOr(breakRulesRaw.afterContinuations, DEFAULTS.breakdown.rules.afterContinuations, 'breakdown.rules.afterContinuations', warnings)),
          afterFailedAttempts: Math.max(0, numberOr(breakRulesRaw.afterFailedAttempts, DEFAULTS.breakdown.rules.afterFailedAttempts, 'breakdown.rules.afterFailedAttempts', warnings)),
          onCategories: stringArray(breakRulesRaw.onCategories, DEFAULTS.breakdown.rules.onCategories, 'breakdown.rules.onCategories', warnings),
        },
        decision,
        provider,
        model: typeof breakRaw.model === 'string' ? breakRaw.model.trim() : DEFAULTS.breakdown.model,
        modelProvider: typeof breakRaw.modelProvider === 'string' && breakRaw.modelProvider.trim() ? breakRaw.modelProvider.trim() : DEFAULTS.breakdown.modelProvider,
        variant: (() => {
          const v = breakRaw.variant;
          if (v === undefined || v === null) return undefined;
          if (typeof v === 'string') return v.trim() || undefined;
          warnings.push(`breakdown.variant: expected a string, got ${JSON.stringify(v)}; using provider default`);
          return undefined;
        })(),
        timeoutMin: positiveOr(breakRaw.timeoutMin, DEFAULTS.breakdown.timeoutMin, 'breakdown.timeoutMin', warnings),
        preferOverEscalation: boolOr(breakRaw.preferOverEscalation, DEFAULTS.breakdown.preferOverEscalation, 'breakdown.preferOverEscalation', warnings),
        maxPerTask: Math.max(0, numberOr(breakRaw.maxPerTask, DEFAULTS.breakdown.maxPerTask, 'breakdown.maxPerTask', warnings)),
      };
    })(),
  };

  if (cli.timeoutMin !== undefined) config.timeoutMin = cli.timeoutMin;
  if (cli.maxTasks !== undefined) config.maxTasksPerRun = Math.max(0, cli.maxTasks);
  if (cli.maxIterations !== undefined) config.maxIterationsPerTask = Math.max(0, cli.maxIterations);
  if (cli.maxCostUsd !== undefined) config.maxCostUsdPerRun = Math.max(0, cli.maxCostUsd);
  if (cli.safe) config.autoApprove = false;
  if (cli.noNudge) config.nudge = false;
  return { config, fileExists: exists, warnings };
}

export interface SessionSpec {
  providerName: ProviderName;
  bin: string;
  model?: string;
  /** Effective reasoning-effort / variant for this session, after support checks (e.g. "high"). */
  variant?: string;
  extraArgs: string[];
  budgetUsd?: number;
  timeoutMin: number;
  idleTimeoutMin: number;
  autoApprove: boolean;
  /**
   * Read-only session: it may read files (so the watcher can inspect a named log) but must not edit
   * or run commands. Adapters map this to their own read-only permission mode; `autoApprove` is
   * ignored when set.
   */
  readOnly?: boolean;
  sources: { provider: string; model: string; modelProvider: string; variant: string };
}

/**
 * Compose the model string handed to the CLI. OpenCode addresses a model as `provider/model`, but
 * every other provider takes a bare id, so `modelProvider` names that upstream provider and `model`
 * stays bare; the two are joined here. A model that already starts with the prefix is left alone.
 */
export function composeModel(providerName: ProviderName, modelProvider: string | undefined, model: string | undefined): string | undefined {
  if (providerName !== 'opencode' || !model || !modelProvider) return model;
  const prefix = `${modelProvider}/`;
  return model.startsWith(prefix) ? model : `${prefix}${model}`;
}

/**
 * Per-task resolution. Precedence: CLI flag > env > task front matter > config file > defaults.
 * `variantSupport` decides whether the resolved variant may be sent to this provider/model; it
 * defaults to "no" so a caller that omits it never emits a variant the provider cannot take.
 */
export function resolveSession(
  config: Config,
  task: Task | undefined,
  cli: CliOverrides,
  env: NodeJS.ProcessEnv = process.env,
  supportsBudget: (p: ProviderName) => boolean = () => true,
  variantSupport: (p: ProviderName, bin: string, model: string | undefined, variant: string) => boolean = () => false,
): { spec: SessionSpec; warnings: string[] } {
  const warnings: string[] = [];
  const meta = task?.meta ?? {};

  let providerName: ProviderName;
  let providerSource: string;
  if (cli.provider) { providerName = asProviderName(cli.provider, '--provider'); providerSource = '--provider'; }
  else if (env.SYMPHONY_PROVIDER) { providerName = asProviderName(env.SYMPHONY_PROVIDER, 'SYMPHONY_PROVIDER'); providerSource = 'env SYMPHONY_PROVIDER'; }
  else if (meta.provider) { providerName = asProviderName(meta.provider, `${task?.taskFileRel ?? 'task'} front matter`); providerSource = 'task front matter'; }
  else { providerName = config.provider; providerSource = 'config'; }

  const pc = config.providers[providerName];
  let model: string | undefined;
  let modelSource: string;
  if (cli.model) { model = cli.model; modelSource = '--model'; }
  else if (env.SYMPHONY_MODEL) { model = env.SYMPHONY_MODEL; modelSource = 'env SYMPHONY_MODEL'; }
  else if (meta.model) { model = meta.model; modelSource = 'task front matter'; }
  else { model = pc.model || undefined; modelSource = pc.model ? 'config' : 'provider default'; }

  // The upstream provider for CLIs that address a model as `provider/model` (OpenCode). Precedence
  // mirrors `model`. Only OpenCode uses it; on any other provider it is dropped with a warning when
  // the value was set explicitly rather than inherited from config.
  let modelProvider: string | undefined;
  let modelProviderSource: string;
  if (cli.modelProvider !== undefined) { modelProvider = cli.modelProvider.trim() || undefined; modelProviderSource = '--model-provider'; }
  else if (env.SYMPHONY_MODEL_PROVIDER) { modelProvider = env.SYMPHONY_MODEL_PROVIDER.trim() || undefined; modelProviderSource = 'env SYMPHONY_MODEL_PROVIDER'; }
  else if (meta.modelProvider) { modelProvider = meta.modelProvider.trim() || undefined; modelProviderSource = 'task front matter'; }
  else if (pc.modelProvider) { modelProvider = pc.modelProvider; modelProviderSource = 'config'; }
  else { modelProvider = undefined; modelProviderSource = 'provider default'; }
  if (modelProvider && providerName !== 'opencode') {
    const explicit = modelProviderSource === '--model-provider' || modelProviderSource === 'env SYMPHONY_MODEL_PROVIDER' || modelProviderSource === 'task front matter';
    if (explicit) warnings.push(`modelProvider "${modelProvider}" ignored: provider ${providerName} takes a bare model id [${modelProviderSource}]`);
    modelProvider = undefined;
    modelProviderSource = 'provider default';
  }
  model = composeModel(providerName, modelProvider, model);

  // Reasoning effort. Default comes from the provider config (shipped as "high" where supported);
  // it is dropped when the provider has no knob or the model does not advertise it.
  let variant: string | undefined;
  let variantSource: string;
  if (cli.variant !== undefined) { variant = cli.variant.trim() || undefined; variantSource = '--variant'; }
  else if (env.SYMPHONY_VARIANT) { variant = env.SYMPHONY_VARIANT.trim() || undefined; variantSource = 'env SYMPHONY_VARIANT'; }
  else if (meta.variant) { variant = meta.variant.trim() || undefined; variantSource = 'task front matter'; }
  else if (pc.variant) { variant = pc.variant; variantSource = 'config'; }
  else { variant = undefined; variantSource = 'provider default'; }
  if (!variant) variantSource = 'provider default';
  if (variant && !variantSupport(providerName, pc.bin, model, variant)) {
    const explicit = variantSource === '--variant' || variantSource === 'env SYMPHONY_VARIANT' || variantSource === 'task front matter';
    if (explicit) warnings.push(`${providerName}${model ? ` model ${model}` : ''} does not support variant "${variant}" [${variantSource}]; ignoring`);
    variant = undefined;
    variantSource = 'provider default';
  }

  let budgetUsd = cli.budgetUsd ?? pc.budgetUsd;
  if (budgetUsd !== undefined && !supportsBudget(providerName)) {
    warnings.push(`budget ${budgetUsd} USD ignored: provider ${providerName} has no budget flag`);
    budgetUsd = undefined;
  }
  if (providerName === 'opencode' && model && !model.includes('/')) {
    warnings.push(`opencode addresses a model as "provider/model"; set providers.opencode.modelProvider (or use a "provider/model" model); got "${model}"`);
  }

  let timeoutMin = config.timeoutMin;
  if (meta.timeoutMin !== undefined && meta.timeoutMin !== '') {
    const n = Number(meta.timeoutMin);
    if (Number.isFinite(n) && n > 0) timeoutMin = n;
    else warnings.push(`${task?.taskFileRel ?? 'task front matter'}: timeoutMin "${meta.timeoutMin}" is not a positive number; using ${config.timeoutMin}`);
  }

  return {
    spec: {
      providerName,
      bin: pc.bin,
      model,
      variant,
      extraArgs: pc.extraArgs,
      budgetUsd,
      timeoutMin,
      idleTimeoutMin: pc.idleTimeoutMin ?? config.idleTimeoutMin,
      autoApprove: config.autoApprove,
      sources: { provider: providerSource, model: modelSource, modelProvider: modelProviderSource, variant: variantSource },
    },
    warnings,
  };
}

/**
 * The independent check the harness runs after a task reports `done`. Per-task front matter wins,
 * then `verifyCommand`, then (when `inferVerify` is on) the project's package.json test script.
 * Provider-agnostic: it is a plain shell command run in the project root.
 */
export interface ResolvedVerify {
  command: string;
  timeoutMin: number;
  /** Where the command came from: task front matter, config, or package.json inference. */
  source: 'task front matter' | 'config' | 'package.json';
}

const NPM_DEFAULT_TEST = /^\s*echo\s+["']?Error:\s*no test specified["']?\s*&&\s*exit\s+1\s*$/i;

/** The `npm test` command when package.json defines a real test script, else undefined. */
export function inferVerifyCommand(root: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) return undefined;
    const test = parsed.scripts.test;
    if (typeof test !== 'string' || !test.trim() || NPM_DEFAULT_TEST.test(test)) return undefined;
    return 'npm test';
  } catch {
    return undefined;
  }
}

export function resolveVerify(config: Config, task: Task | undefined, root?: string): ResolvedVerify | undefined {
  const fromTask = (task?.meta?.verify ?? '').trim();
  if (fromTask) return { command: fromTask, timeoutMin: config.verifyTimeoutMin, source: 'task front matter' };
  const fromConfig = (config.verifyCommand ?? '').trim();
  if (fromConfig) return { command: fromConfig, timeoutMin: config.verifyTimeoutMin, source: 'config' };
  if (config.inferVerify && root) {
    const inferred = inferVerifyCommand(root);
    if (inferred) return { command: inferred, timeoutMin: config.verifyTimeoutMin, source: 'package.json' };
  }
  return undefined;
}

/**
 * The read-only fallback-LLM decision spec for automatic breakdowns. Like the watcher it ignores CLI
 * flags, env and front matter: `breakdown.provider`/`.model` win and fall back to the `watch` block,
 * so a cheap model can answer the split-or-not question. Pinned to `autoApprove: false`.
 */
export function resolveBreakdown(
  config: Config,
  variantSupport: (p: ProviderName, bin: string, model: string | undefined, variant: string) => boolean = () => false,
): { spec: SessionSpec; warnings: string[] } {
  const b = config.breakdown;
  const warnings: string[] = [];
  const providerName = b.provider ?? config.watch.provider;
  const pc = config.providers[providerName];
  const modelProvider = b.modelProvider ?? config.watch.modelProvider ?? pc.modelProvider;
  if (b.modelProvider && providerName !== 'opencode') warnings.push('breakdown.modelProvider is only used by opencode; ignored');
  const model = composeModel(providerName, modelProvider, b.model.trim() || config.watch.model.trim() || pc.model);
  let variant = b.variant ?? config.watch.variant;
  if (variant && !variantSupport(providerName, pc.bin, model, variant)) {
    warnings.push(`${providerName}${model ? ` model ${model}` : ''} does not support variant "${variant}" (breakdown.variant); using provider default`);
    variant = undefined;
  }
  if (providerName === 'opencode' && model && !model.includes('/')) {
    warnings.push(`opencode addresses a model as "provider/model"; set breakdown.modelProvider or watch.modelProvider (or use a "provider/model" model); got "${model}"`);
  }
  return {
    spec: {
      providerName,
      bin: pc.bin,
      model: model || undefined,
      variant,
      extraArgs: pc.extraArgs,
      budgetUsd: undefined,
      timeoutMin: b.timeoutMin,
      idleTimeoutMin: pc.idleTimeoutMin ?? config.idleTimeoutMin,
      autoApprove: false,
      sources: { provider: b.provider ? 'breakdown' : 'watch', model: b.model ? 'breakdown' : 'watch', modelProvider: b.modelProvider ? 'breakdown' : config.watch.modelProvider ? 'watch' : pc.modelProvider ? 'config' : 'provider default', variant: b.variant ? 'breakdown' : variant ? 'watch' : 'provider default' },
    },
    warnings,
  };
}

/**
 * The escalation target, when one is configured and enabled. Returns undefined when escalation is
 * off or has no usable model (so the caller falls back to failing the task as before). The spec is
 * built from config alone: escalation is its own provider/model, not a per-task front-matter knob.
 */
export function resolveEscalation(
  config: Config,
  primary: SessionSpec,
  supportsBudget: (p: ProviderName) => boolean = () => true,
  variantSupport: (p: ProviderName, bin: string, model: string | undefined, variant: string) => boolean = () => false,
): { spec: SessionSpec; warnings: string[] } | undefined {
  if (!config.escalation.enabled) return undefined;
  const warnings: string[] = [];
  const providerName = config.escalation.provider ?? primary.providerName;
  const rawModel = config.escalation.model.trim();
  if (!rawModel) {
    warnings.push('escalation.model is empty; escalation stays off');
    return undefined;
  }
  const pc = config.providers[providerName];
  const modelProvider = config.escalation.modelProvider ?? pc.modelProvider;
  if (config.escalation.modelProvider && providerName !== 'opencode') warnings.push('escalation.modelProvider is only used by opencode; ignored');
  const model = composeModel(providerName, modelProvider, rawModel)!;
  let budgetUsd = pc.budgetUsd;
  if (budgetUsd !== undefined && !supportsBudget(providerName)) {
    warnings.push(`escalation budget ${budgetUsd} USD ignored: provider ${providerName} has no budget flag`);
    budgetUsd = undefined;
  }
  let variant = pc.variant;
  if (variant && !variantSupport(providerName, pc.bin, model, variant)) variant = undefined;
  if (providerName === 'opencode' && !model.includes('/')) {
    warnings.push(`opencode addresses a model as "provider/model"; set escalation.modelProvider (or use a "provider/model" model); got "${model}"`);
  }
  return {
    spec: {
      providerName,
      bin: pc.bin,
      model,
      variant,
      extraArgs: pc.extraArgs,
      budgetUsd,
      timeoutMin: config.timeoutMin,
      idleTimeoutMin: pc.idleTimeoutMin ?? config.idleTimeoutMin,
      autoApprove: config.autoApprove,
      sources: { provider: 'escalation', model: 'escalation', modelProvider: config.escalation.modelProvider ? 'escalation' : pc.modelProvider ? 'config' : 'provider default', variant: variant ? 'config' : 'provider default' },
    },
    warnings,
  };
}

/**
 * The read-only pipeline-watch spec. Unlike a task it ignores CLI flags, env and front matter: the
 * watcher's provider/model come from the `watch` block alone so it can be a different, cheaper model
 * than the workhorse. A variant is only resolved when `watch.variant` is set explicitly — that keeps
 * the common case free of the synchronous provider-catalog lookup a variant check needs, and lets the
 * watcher default to the provider's own reasoning effort. Pinned to `autoApprove: false` and
 * `readOnly: true` so a mis-prompted watcher cannot edit the tree but can still read the one log the
 * prompt names.
 */
export function resolveWatch(
  config: Config,
  variantSupport: (p: ProviderName, bin: string, model: string | undefined, variant: string) => boolean = () => false,
): { spec: SessionSpec; warnings: string[] } {
  const w = config.watch;
  const warnings: string[] = [];
  const providerName = w.provider;
  const pc = config.providers[providerName];
  const modelProvider = w.modelProvider ?? pc.modelProvider;
  if (w.modelProvider && providerName !== 'opencode') warnings.push('watch.modelProvider is only used by opencode; ignored');
  const model = composeModel(providerName, modelProvider, w.model.trim() || pc.model);
  let variant = w.variant;
  if (variant && !variantSupport(providerName, pc.bin, model, variant)) {
    warnings.push(`${providerName}${model ? ` model ${model}` : ''} does not support variant "${variant}" (watch.variant); using provider default`);
    variant = undefined;
  }
  if (providerName === 'opencode' && model && !model.includes('/')) {
    warnings.push(`opencode addresses a model as "provider/model"; set watch.modelProvider (or use a "provider/model" model); got "${model}"`);
  }
  return {
    spec: {
      providerName,
      bin: pc.bin,
      model: model || undefined,
      variant,
      extraArgs: pc.extraArgs,
      budgetUsd: undefined,
      timeoutMin: w.timeoutMin,
      idleTimeoutMin: pc.idleTimeoutMin ?? config.idleTimeoutMin,
      autoApprove: false,
      readOnly: true,
      sources: { provider: 'watch', model: 'watch', modelProvider: w.modelProvider ? 'watch' : pc.modelProvider ? 'config' : 'provider default', variant: variant ? 'watch' : 'provider default' },
    },
    warnings,
  };
}
