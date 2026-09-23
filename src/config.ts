import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PathOverrides, Paths } from './paths.js';
import type { ProviderName } from './providers/types.js';
import type { Task } from './tasks.js';
import { UsageError, fileExists, isRecord } from './util.js';

export const PROVIDER_NAMES: ProviderName[] = ['claude', 'cursor', 'opencode', 'codex', 'gemini', 'antigravity', 'fake'];

export interface ProviderConfig {
  bin: string;
  model?: string;
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
  /** Model the escalation provider runs, e.g. "z-ai/glm-5.3" (OpenCode) or a Claude model id. */
  model: string;
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
 * nudge session. Off by default, and every failure path falls back to the existing nudge.
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
  retry: { maxAttempts: number; backoffSec: number[] };
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
}

export interface CliOverrides {
  provider?: string;
  model?: string;
  timeoutMin?: number;
  budgetUsd?: number;
  maxCostUsd?: number;
  safe?: boolean;
  noNudge?: boolean;
  maxTasks?: number;
  maxIterations?: number;
}

export const DEFAULTS: Config = {
  provider: 'claude',
  providers: {
    claude: { bin: 'claude', model: 'claude-opus-5', extraArgs: [] },
    cursor: { bin: 'agent', model: 'claude-opus-5', extraArgs: [], idleTimeoutMin: 45 },
    opencode: { bin: 'opencode', model: 'anthropic/claude-sonnet-4-5', extraArgs: [], idleTimeoutMin: 45 },
    codex: { bin: 'codex', model: 'gpt-6-sol', extraArgs: [], idleTimeoutMin: 45 },
    gemini: { bin: 'gemini', model: 'gemini-3.1-pro-preview', extraArgs: [], idleTimeoutMin: 45 },
    antigravity: { bin: 'agy', model: 'gemini-3.1-pro-high', extraArgs: [], idleTimeoutMin: 45 },
    fake: { bin: process.execPath, extraArgs: [] },
  },
  paths: {},
  taskSets: [],
  autoApprove: true,
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
  retry: { maxAttempts: 3, backoffSec: [30, 120, 300] },
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
    maxAttempts: 1,
    onCategories: ['task', 'verify'],
  },
  jev: {
    enabled: false,
    resultFallback: true,
    failureTriage: true,
    escalationDecision: true,
    provider: 'openrouter',
    model: 'jev-latest',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    timeoutMs: 4000,
    minConfidence: 0.7,
    acceptStatuses: ['done', 'continue'],
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
      providers[pn] = {
        bin: typeof val.bin === 'string' && val.bin ? val.bin : base.bin,
        model: typeof val.model === 'string' && val.model ? val.model : base.model,
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

  const config: Config = {
    provider: raw.provider === undefined ? DEFAULTS.provider : asProviderName(raw.provider, 'symphony.config.json provider'),
    providers,
    paths: pathOverrides(raw.paths, warnings),
    taskSets: taskSetList(raw.taskSets, warnings),
    autoApprove: boolOr(raw.autoApprove, DEFAULTS.autoApprove, 'autoApprove', warnings),
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
      return {
        enabled,
        provider: escRaw.provider === undefined || escRaw.provider === null
          ? DEFAULTS.escalation.provider
          : asProviderName(escRaw.provider, 'symphony.config.json escalation.provider'),
        model,
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
  extraArgs: string[];
  budgetUsd?: number;
  timeoutMin: number;
  idleTimeoutMin: number;
  autoApprove: boolean;
  sources: { provider: string; model: string };
}

/**
 * Per-task resolution. Precedence: CLI flag > env > task front matter > config file > defaults.
 */
export function resolveSession(
  config: Config,
  task: Task | undefined,
  cli: CliOverrides,
  env: NodeJS.ProcessEnv = process.env,
  supportsBudget: (p: ProviderName) => boolean = () => true,
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

  let budgetUsd = cli.budgetUsd ?? pc.budgetUsd;
  if (budgetUsd !== undefined && !supportsBudget(providerName)) {
    warnings.push(`budget ${budgetUsd} USD ignored: provider ${providerName} has no budget flag`);
    budgetUsd = undefined;
  }
  if (providerName === 'opencode' && model && !model.includes('/')) {
    warnings.push(`opencode models are "provider/model" (e.g. anthropic/claude-sonnet-4-5); got "${model}"`);
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
      extraArgs: pc.extraArgs,
      budgetUsd,
      timeoutMin,
      idleTimeoutMin: pc.idleTimeoutMin ?? config.idleTimeoutMin,
      autoApprove: config.autoApprove,
      sources: { provider: providerSource, model: modelSource },
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
 * The escalation target, when one is configured and enabled. Returns undefined when escalation is
 * off or has no usable model (so the caller falls back to failing the task as before). The spec is
 * built from config alone: escalation is its own provider/model, not a per-task front-matter knob.
 */
export function resolveEscalation(
  config: Config,
  primary: SessionSpec,
  supportsBudget: (p: ProviderName) => boolean = () => true,
): { spec: SessionSpec; warnings: string[] } | undefined {
  if (!config.escalation.enabled) return undefined;
  const warnings: string[] = [];
  const providerName = config.escalation.provider ?? primary.providerName;
  const model = config.escalation.model.trim();
  if (!model) {
    warnings.push('escalation.model is empty; escalation stays off');
    return undefined;
  }
  const pc = config.providers[providerName];
  let budgetUsd = pc.budgetUsd;
  if (budgetUsd !== undefined && !supportsBudget(providerName)) {
    warnings.push(`escalation budget ${budgetUsd} USD ignored: provider ${providerName} has no budget flag`);
    budgetUsd = undefined;
  }
  if (providerName === 'opencode' && !model.includes('/')) {
    warnings.push(`opencode models are "provider/model" (e.g. z-ai/glm-5.3); escalation got "${model}"`);
  }
  return {
    spec: {
      providerName,
      bin: pc.bin,
      model,
      extraArgs: pc.extraArgs,
      budgetUsd,
      timeoutMin: config.timeoutMin,
      idleTimeoutMin: pc.idleTimeoutMin ?? config.idleTimeoutMin,
      autoApprove: config.autoApprove,
      sources: { provider: 'escalation', model: 'escalation' },
    },
    warnings,
  };
}
