import type { ErrorCategory } from './classify.js';
import type { JevConfig, JevProviderName } from './config.js';
import type { ReportedStatus } from './result.js';
import { isRecord } from './util.js';

/** Base URL per built-in provider; `jev.baseUrl` overrides it. */
const BASE_URLS: Record<JevProviderName, string> = {
  openrouter: 'https://openrouter.ai/api',
};

const STATUSES: ReportedStatus[] = ['done', 'continue', 'blocked', 'failed'];

/**
 * Categories Jev may assign to a failure the harness could not classify itself. Only the ones whose
 * handling differs are offered; harness-set categories (timeout, stall, interrupted, budget, …) are
 * derived from evidence the model never sees.
 */
export const JEV_ERROR_CATEGORIES: ErrorCategory[] = ['auth', 'billing', 'usage_limit', 'rate_limit', 'overloaded', 'server', 'network', 'model', 'config', 'task', 'unknown'];

const ERROR_CRITERIA: Record<string, string> = {
  auth: 'Credentials, token, login or permission problem with the provider.',
  billing: 'Payment, credits or account balance problem (e.g. 402, out of credits).',
  usage_limit: 'A subscription or plan usage limit was hit; it resets later.',
  rate_limit: 'Too many requests or throttling (e.g. 429); retrying shortly may work.',
  overloaded: 'The provider is overloaded or at capacity (e.g. 529).',
  server: 'A provider-side 5xx or internal server error.',
  network: 'A transport problem: connection reset/refused, DNS, socket, fetch failure.',
  model: 'The requested model does not exist or is not available.',
  config: 'Bad flags, arguments or request shape (unknown option, invalid request).',
  task: 'No provider problem: the agent simply did not complete the task.',
  unknown: 'None of the above, or the evidence is too thin to tell.',
};

export interface JevDecision {
  status: ReportedStatus;
  /** Jev's confidence in the chosen option, 0..1. */
  confidence: number;
  /** Probability Jev assigned to each option. */
  probabilities?: Record<string, number>;
  /** The dated model snapshot that served the request. */
  model?: string;
  /** What the call cost, from the response's usage block. */
  costUsd?: number;
}

export interface JevErrorDecision {
  category: ErrorCategory;
  confidence: number;
  probabilities?: Record<string, number>;
  model?: string;
  costUsd?: number;
}

export interface JevDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

interface Choice {
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
  model?: string;
  costUsd?: number;
}

export function jevBaseUrl(config: JevConfig): string {
  return (config.baseUrl ?? BASE_URLS[config.provider]).replace(/\/+$/, '');
}

/** Why Jev cannot run right now, or undefined when it can. Cheap: no network. */
export function jevProblem(config: JevConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!config.enabled) return 'disabled';
  if (!config.model.trim()) return 'jev.model is empty';
  if (!env[config.apiKeyEnv]) return `no API key in ${config.apiKeyEnv}`;
  return undefined;
}

/** Keep the tail: conclusions sit at the end, and the head is usually boilerplate. */
function tail(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `…${t.slice(t.length - max)}`;
}

/**
 * One System One call. Never throws and never hangs past `timeoutMs`: resolves to the parsed JSON
 * body, or undefined on any problem so the caller can fall back to its deterministic path.
 */
async function callSystemOne(config: JevConfig, state: unknown, questions: unknown, deps: JevDeps): Promise<unknown | undefined> {
  const env = deps.env ?? process.env;
  const key = env[config.apiKeyEnv];
  if (!config.enabled || !key) return undefined;

  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const onAbort = () => controller.abort();
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await doFetch(`${jevBaseUrl(config)}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, state, questions }),
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}

/** Read a named `choice` answer out of a System One response. */
function readChoice(json: unknown, key: string): Choice | undefined {
  if (!isRecord(json) || !isRecord(json.answers)) return undefined;
  const answer = json.answers[key];
  if (!isRecord(answer) || answer.type !== 'choice' || typeof answer.choice !== 'string') return undefined;
  const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : 0;
  const probabilities = isRecord(answer.probabilities)
    ? (Object.fromEntries(Object.entries(answer.probabilities).filter(([, v]) => typeof v === 'number')) as Record<string, number>)
    : undefined;
  const usage = isRecord(json.usage) ? json.usage : undefined;
  return {
    choice: answer.choice.toLowerCase(),
    confidence,
    probabilities,
    model: typeof json.model === 'string' ? json.model : undefined,
    costUsd: usage && typeof usage.cost === 'number' ? usage.cost : undefined,
  };
}

/**
 * Ask Jev which disposition a session's final output reports, so the harness can skip a nudge.
 * Used only when a session ended cleanly without a SYMPHONY_RESULT block.
 */
export async function classifySessionResult(
  config: JevConfig,
  input: { taskTitle: string; output: string },
  deps: JevDeps = {},
): Promise<JevDecision | undefined> {
  const json = await callSystemOne(
    config,
    { task_title: input.taskTitle, agent_final_output: tail(input.output, 12_000) },
    {
      disposition: {
        type: 'choice',
        instructions:
          'A coding agent was given one task and ended its session. From its final output only, which single disposition does the session report?',
        criteria: {
          done: 'The output states the task is complete and finished.',
          continue: 'The output says the task is unfinished and more work remains.',
          blocked: 'The output needs a human decision, input, or approval to proceed.',
          failed: 'The output reports an error, or that it could not complete the task.',
        },
      },
    },
    deps,
  );
  const choice = readChoice(json, 'disposition');
  if (!choice || !(STATUSES as string[]).includes(choice.choice)) return undefined;
  return { status: choice.choice as ReportedStatus, confidence: choice.confidence, probabilities: choice.probabilities, model: choice.model, costUsd: choice.costUsd };
}

/**
 * Ask Jev to place a failure the harness could not classify into one of the categories it already
 * understands. The harness's regex stays the primary classifier; this only fills the `unknown` gap.
 */
export async function classifyError(
  config: JevConfig,
  input: { evidence: string; exitCode?: number | null; resultSubtype?: string },
  deps: JevDeps = {},
): Promise<JevErrorDecision | undefined> {
  const json = await callSystemOne(
    config,
    { error_text: tail(input.evidence, 8000), exit_code: input.exitCode ?? null, result_subtype: input.resultSubtype ?? null },
    {
      category: {
        type: 'choice',
        instructions: 'A coding-agent CLI session failed and its error text did not match any known pattern. Which single category best describes the failure?',
        criteria: ERROR_CRITERIA,
      },
    },
    deps,
  );
  const choice = readChoice(json, 'category');
  if (!choice || !(JEV_ERROR_CATEGORIES as string[]).includes(choice.choice)) return undefined;
  return { category: choice.choice as ErrorCategory, confidence: choice.confidence, probabilities: choice.probabilities, model: choice.model, costUsd: choice.costUsd };
}

/** The two options Jev weighs when deciding whether a failed task is worth escalating. */
const ESCALATION_OPTIONS = ['escalate', 'stay'];

export interface JevEscalationDecision {
  escalate: boolean;
  confidence: number;
  probabilities?: Record<string, number>;
  model?: string;
  costUsd?: number;
}

/**
 * Ask Jev whether a failed task is worth handing to the escalation model. The task body is the main
 * input: the question is whether more capability would close the gap, or the task is stuck on
 * missing context or a human decision that a stronger model cannot supply either.
 */
export async function classifyEscalation(
  config: JevConfig,
  input: { taskTitle: string; taskBody?: string; failure: string },
  deps: JevDeps = {},
): Promise<JevEscalationDecision | undefined> {
  const json = await callSystemOne(
    config,
    {
      task: { title: input.taskTitle, body: input.taskBody ? tail(input.taskBody, 8000) : null },
      failure: tail(input.failure, 2000),
    },
    {
      decision: {
        type: 'choice',
        instructions: 'A coding agent failed to finish this task. Should the harness retry it on a more capable model, or is a stronger model unlikely to help?',
        criteria: {
          escalate: 'A more capable model would plausibly complete this task from the same context and information.',
          stay: 'A stronger model would not help: the task needs missing context or a human decision, or it is a dead end.',
        },
      },
    },
    deps,
  );
  return parseEscalationDecision(json);
}

/** Read the `escalation` decision out of a System One response. Exported for tests. */
export function parseEscalationDecision(json: unknown): JevEscalationDecision | undefined {
  const choice = readChoice(json, 'decision');
  if (!choice || !ESCALATION_OPTIONS.includes(choice.choice)) return undefined;
  return { escalate: choice.choice === 'escalate', confidence: choice.confidence, probabilities: choice.probabilities, model: choice.model, costUsd: choice.costUsd };
}

/** Read the `disposition` choice out of a System One response. Exported for tests. */
export function parseDecision(json: unknown): JevDecision | undefined {
  const choice = readChoice(json, 'disposition');
  if (!choice || !(STATUSES as string[]).includes(choice.choice)) return undefined;
  return { status: choice.choice as ReportedStatus, confidence: choice.confidence, probabilities: choice.probabilities, model: choice.model, costUsd: choice.costUsd };
}

/** Read the `category` choice out of a System One response. Exported for tests. */
export function parseErrorDecision(json: unknown): JevErrorDecision | undefined {
  const choice = readChoice(json, 'category');
  if (!choice || !(JEV_ERROR_CATEGORIES as string[]).includes(choice.choice)) return undefined;
  return { category: choice.choice as ErrorCategory, confidence: choice.confidence, probabilities: choice.probabilities, model: choice.model, costUsd: choice.costUsd };
}
