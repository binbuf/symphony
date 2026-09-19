import { readFileSync } from 'node:fs';
import type { Paths } from './paths.js';
import type { ProviderName } from './providers/types.js';
import type { Task } from './tasks.js';
import { UsageError, fileExists, isRecord } from './util.js';

export const PROVIDER_NAMES: ProviderName[] = ['claude', 'cursor', 'opencode', 'codex', 'fake'];

export interface ProviderConfig {
  bin: string;
  model?: string;
  extraArgs: string[];
  budgetUsd?: number;
  idleTimeoutMin?: number;
}

export interface Config {
  provider: ProviderName;
  providers: Record<ProviderName, ProviderConfig>;
  autoApprove: boolean;
  nudge: boolean;
  timeoutMin: number;
  idleTimeoutMin: number;
  nudgeTimeoutMin: number;
  prepareTimeoutMin: number;
  maxProgressBytes: number;
  retry: { maxAttempts: number; backoffSec: number[] };
  halt: { maxConsecutiveFailures: number; maxAttemptsPerTask: number; onCategories: string[] };
  commitMessageTemplate: string;
}

export interface CliOverrides {
  provider?: string;
  model?: string;
  timeoutMin?: number;
  budgetUsd?: number;
  safe?: boolean;
  noNudge?: boolean;
}

export const DEFAULTS: Config = {
  provider: 'claude',
  providers: {
    claude: { bin: 'claude', model: 'claude-fable-5-1', extraArgs: [] },
    cursor: { bin: 'agent', extraArgs: [], idleTimeoutMin: 45 },
    opencode: { bin: 'opencode', model: 'anthropic/claude-sonnet-4-5', extraArgs: [], idleTimeoutMin: 45 },
    codex: { bin: 'codex', extraArgs: [], idleTimeoutMin: 45 },
    fake: { bin: process.execPath, extraArgs: [] },
  },
  autoApprove: true,
  nudge: true,
  timeoutMin: 240,
  idleTimeoutMin: 20,
  nudgeTimeoutMin: 45,
  prepareTimeoutMin: 60,
  maxProgressBytes: 32768,
  retry: { maxAttempts: 3, backoffSec: [30, 120, 300] },
  halt: {
    maxConsecutiveFailures: 2,
    maxAttemptsPerTask: 3,
    onCategories: ['auth', 'billing', 'usage_limit', 'model', 'config'],
  },
  commitMessageTemplate: '{id}: {title} [{status}]',
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

  const config: Config = {
    provider: raw.provider === undefined ? DEFAULTS.provider : asProviderName(raw.provider, 'symphony.config.json provider'),
    providers,
    autoApprove: boolOr(raw.autoApprove, DEFAULTS.autoApprove, 'autoApprove', warnings),
    nudge: boolOr(raw.nudge, DEFAULTS.nudge, 'nudge', warnings),
    timeoutMin: numberOr(raw.timeoutMin, DEFAULTS.timeoutMin, 'timeoutMin', warnings),
    idleTimeoutMin: numberOr(raw.idleTimeoutMin, DEFAULTS.idleTimeoutMin, 'idleTimeoutMin', warnings),
    nudgeTimeoutMin: numberOr(raw.nudgeTimeoutMin, DEFAULTS.nudgeTimeoutMin, 'nudgeTimeoutMin', warnings),
    prepareTimeoutMin: numberOr(raw.prepareTimeoutMin, DEFAULTS.prepareTimeoutMin, 'prepareTimeoutMin', warnings),
    maxProgressBytes: numberOr(raw.maxProgressBytes, DEFAULTS.maxProgressBytes, 'maxProgressBytes', warnings),
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
  };

  if (cli.timeoutMin !== undefined) config.timeoutMin = cli.timeoutMin;
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
