import { readFileSync } from 'node:fs';
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

export interface Config {
  provider: ProviderName;
  providers: Record<ProviderName, ProviderConfig>;
  /** Overrides for every user-facing location (docs, tasks, progress, design, adr, logs, stop, state, runs, log). */
  paths: PathOverrides;
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
  /** When false, the design/ and adr/ folders are neither required nor used: tasks run standalone. */
  designDocs: boolean;
  /** How many extra fresh sessions a task may take when it reports `continue` (subtask iteration). */
  maxContinuations: number;
  /** Max total sessions (task + retries + continuations) a single task may use in one run before it fails. 0 = unlimited. */
  maxIterationsPerTask: number;
  /** Max tasks a single `run` invocation will process. 0 = unlimited. */
  maxTasksPerRun: number;
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
  hooks: HooksConfig;
  git: GitConfig;
}

export interface CliOverrides {
  provider?: string;
  model?: string;
  timeoutMin?: number;
  budgetUsd?: number;
  safe?: boolean;
  noNudge?: boolean;
  maxTasks?: number;
  maxIterations?: number;
}

export const DEFAULTS: Config = {
  provider: 'claude',
  providers: {
    claude: { bin: 'claude', model: 'claude-fable-5-1', extraArgs: [] },
    cursor: { bin: 'agent', extraArgs: [], idleTimeoutMin: 45 },
    opencode: { bin: 'opencode', model: 'anthropic/claude-sonnet-4-5', extraArgs: [], idleTimeoutMin: 45 },
    codex: { bin: 'codex', extraArgs: [], idleTimeoutMin: 45 },
    gemini: { bin: 'gemini', extraArgs: [], idleTimeoutMin: 45 },
    antigravity: { bin: 'antigravity', extraArgs: [], idleTimeoutMin: 45 },
    fake: { bin: process.execPath, extraArgs: [] },
  },
  paths: {},
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
  designDocs: true,
  maxContinuations: 4,
  maxIterationsPerTask: 0,
  maxTasksPerRun: 0,
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
  hooks: {},
  git: { autoIgnoreUntracked: true, extraIgnore: [] },
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

function pathOverrides(x: unknown, warnings: string[]): PathOverrides {
  if (x === undefined || x === null) return {};
  if (!isRecord(x)) { warnings.push('paths: expected an object; using defaults'); return {}; }
  const out: PathOverrides = {};
  for (const k of PATH_KEYS) {
    const v = x[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    else warnings.push(`paths.${k}: expected a non-empty string; using default`);
  }
  for (const k of Object.keys(x)) if (!(PATH_KEYS as readonly string[]).includes(k)) warnings.push(`paths.${k}: unknown key ignored`);
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
  for (const k of Object.keys(raw)) if (!known.has(k)) warnings.push(`symphony.config.json: unknown key "${k}" ignored`);

  const providers = { ...DEFAULTS.providers } as Record<ProviderName, ProviderConfig>;
  if (raw.providers !== undefined) {
    if (!isRecord(raw.providers)) throw new UsageError('symphony.config.json: "providers" must be an object');
    for (const [name, val] of Object.entries(raw.providers)) {
      const pn = asProviderName(name, 'symphony.config.json providers');
      if (!isRecord(val)) throw new UsageError(`symphony.config.json: providers.${name} must be an object`);
      const base = providers[pn];
      providers[pn] = {
        bin: typeof val.bin === 'string' && val.bin ? val.bin : base.bin,
        model: typeof val.model === 'string' && val.model ? val.model : base.model,
        extraArgs: stringArray(val.extraArgs, base.extraArgs, `providers.${name}.extraArgs`, warnings),
        budgetUsd: val.budgetUsd === undefined || val.budgetUsd === null ? base.budgetUsd : numberOr(val.budgetUsd, 0, `providers.${name}.budgetUsd`, warnings),
        idleTimeoutMin: val.idleTimeoutMin === undefined || val.idleTimeoutMin === null ? base.idleTimeoutMin : numberOr(val.idleTimeoutMin, DEFAULTS.idleTimeoutMin, `providers.${name}.idleTimeoutMin`, warnings),
      };
    }
  }

  const retryRaw = isRecord(raw.retry) ? raw.retry : {};
  const haltRaw = isRecord(raw.halt) ? raw.halt : {};
  const hooksRaw = isRecord(raw.hooks) ? raw.hooks : {};
  const gitRaw = isRecord(raw.git) ? raw.git : {};

  const config: Config = {
    provider: raw.provider === undefined ? DEFAULTS.provider : asProviderName(raw.provider, 'symphony.config.json provider'),
    providers,
    paths: pathOverrides(raw.paths, warnings),
    autoApprove: boolOr(raw.autoApprove, DEFAULTS.autoApprove, 'autoApprove', warnings),
    nudge: boolOr(raw.nudge, DEFAULTS.nudge, 'nudge', warnings),
    timeoutMin: numberOr(raw.timeoutMin, DEFAULTS.timeoutMin, 'timeoutMin', warnings),
    idleTimeoutMin: numberOr(raw.idleTimeoutMin, DEFAULTS.idleTimeoutMin, 'idleTimeoutMin', warnings),
    nudgeTimeoutMin: numberOr(raw.nudgeTimeoutMin, DEFAULTS.nudgeTimeoutMin, 'nudgeTimeoutMin', warnings),
    prepareTimeoutMin: numberOr(raw.prepareTimeoutMin, DEFAULTS.prepareTimeoutMin, 'prepareTimeoutMin', warnings),
    maxProgressBytes: numberOr(raw.maxProgressBytes, DEFAULTS.maxProgressBytes, 'maxProgressBytes', warnings),
    progressDigest: boolOr(raw.progressDigest, DEFAULTS.progressDigest, 'progressDigest', warnings),
    inlineDesignDocs: boolOr(raw.inlineDesignDocs, DEFAULTS.inlineDesignDocs, 'inlineDesignDocs', warnings),
    repoMap: boolOr(raw.repoMap, DEFAULTS.repoMap, 'repoMap', warnings),
    maxIndexBytes: numberOr(raw.maxIndexBytes, DEFAULTS.maxIndexBytes, 'maxIndexBytes', warnings),
    designDocs: boolOr(raw.designDocs, DEFAULTS.designDocs, 'designDocs', warnings),
    maxContinuations: Math.max(0, numberOr(raw.maxContinuations, DEFAULTS.maxContinuations, 'maxContinuations', warnings)),
    maxIterationsPerTask: Math.max(0, numberOr(raw.maxIterationsPerTask, DEFAULTS.maxIterationsPerTask, 'maxIterationsPerTask', warnings)),
    maxTasksPerRun: Math.max(0, numberOr(raw.maxTasksPerRun, DEFAULTS.maxTasksPerRun, 'maxTasksPerRun', warnings)),
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
    verifyTimeoutMin: numberOr(raw.verifyTimeoutMin, DEFAULTS.verifyTimeoutMin, 'verifyTimeoutMin', warnings),
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
  };

  if (cli.timeoutMin !== undefined) config.timeoutMin = cli.timeoutMin;
  if (cli.maxTasks !== undefined) config.maxTasksPerRun = Math.max(0, cli.maxTasks);
  if (cli.maxIterations !== undefined) config.maxIterationsPerTask = Math.max(0, cli.maxIterations);
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

  const timeoutMin = meta.timeoutMin && Number.isFinite(Number(meta.timeoutMin)) ? Number(meta.timeoutMin) : config.timeoutMin;

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
 * The independent check the harness runs after a task reports `done`. Per-task front matter wins.
 * Provider-agnostic: it is a plain shell command run in the project root.
 */
export function resolveVerify(config: Config, task: Task | undefined): { command: string; timeoutMin: number } | undefined {
  const command = (task?.meta?.verify ?? '').trim() || (config.verifyCommand ?? '').trim();
  if (!command) return undefined;
  return { command, timeoutMin: config.verifyTimeoutMin };
}
