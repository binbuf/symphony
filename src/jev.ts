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

/** What the harness may do with a task an automatic-breakdown decision is asked about. */
export const BREAKDOWN_ACTIONS = ['split', 'proceed', 'escalate', 'stop'] as const;
export type JevBreakdownAction = (typeof BREAKDOWN_ACTIONS)[number];

/** The stage a breakdown decision is made at: before a task starts, at a `continue` boundary, or on failure. */
export type BreakdownStage = 'start' | 'continue' | 'failure';

export interface JevBreakdownDecision {
  action: JevBreakdownAction;
  confidence: number;
  probabilities?: Record<string, number>;
  model?: string;
  costUsd?: number;
}

export interface JevBreakdownInput {
  stage: BreakdownStage;
  taskTitle: string;
  taskBody?: string;
  /** The task's recorded status at the decision point. */
  status: string;
  /** Sessions this task has used so far. */
  attempts: number;
  /** Continuation sessions used so far (stage `continue`). */
  continuations: number;
  /** The continuation summary or failure message that opened the decision. */
  reason?: string;
}

/**
 * The options Jev may pick per stage. `proceed` means "carry on as the harness otherwise would"
 * (run the task, start the next slice, or take the ordinary failure path including escalation);
 * `escalate` skips the ordinary escalation gate because this call already decided it; `stop` fails
 * the task without escalating. Only the failure stage offers escalate/stop.
 */
const BREAKDOWN_QUESTIONS: Record<BreakdownStage, { instructions: string; criteria: Record<string, string> }> = {
  start: {
    instructions: 'A coding agent is about to start this task in one unattended session. Is the task sized for that, or is it really several pieces of work that should be split into smaller subtasks first?',
    criteria: {
      run: 'The task is one coherent piece of work that a single session can plausibly finish; run it as it is.',
      split: 'The task mixes several independent pieces of work, or is clearly larger than one session; split it into smaller subtasks first.',
    },
  },
  continue: {
    instructions: 'A coding agent has already used one or more sessions on this task, each ending with "continue" (unfinished). Another slice is about to start. Should it keep going, or is the task too large for this approach?',
    criteria: {
      continue: 'The work is progressing and one or a few more slices will plausibly finish it; keep going.',
      split: 'The task keeps producing slices without converging, or is too large to finish this way; split it into smaller subtasks.',
    },
  },
  failure: {
    instructions: 'A coding agent failed to finish this task. Should the harness break the task into smaller subtasks, retry it on a more capable model, or give up?',
    criteria: {
      split: 'The task is too large or mixes several jobs; smaller subtasks are more likely to succeed than a stronger model.',
      escalate: 'The task is the right size and a more capable model would plausibly finish it from the same context.',
      stop: 'Neither would help: the task needs missing context or a human decision, or it is a dead end.',
      proceed: 'Unclear; let the harness take its ordinary failure path.',
    },
  },
};

/**
 * Ask Jev what to do with a task an automatic breakdown is being considered for. The task body is
 * the main input: the question is whether the work is too large (split), sized for a stronger model
 * (escalate), or stuck on something neither can supply (stop).
 */
export async function classifyBreakdown(config: JevConfig, input: JevBreakdownInput, deps: JevDeps = {}): Promise<JevBreakdownDecision | undefined> {
  const question = BREAKDOWN_QUESTIONS[input.stage];
  const json = await callSystemOne(
    config,
    {
      task: { title: input.taskTitle, body: input.taskBody ? tail(input.taskBody, 8000) : null },
      harness: { stage: input.stage, status: input.status, sessions: input.attempts, continuations: input.continuations },
      evidence: input.reason ? tail(input.reason, 2000) : null,
    },
    { decision: { type: 'choice', instructions: question.instructions, criteria: question.criteria } },
    deps,
  );
  return parseBreakdownDecision(json);
}

/** Read the `decision` choice of a breakdown call. Exported for tests. */
export function parseBreakdownDecision(json: unknown): JevBreakdownDecision | undefined {
  const choice = readChoice(json, 'decision');
  if (!choice || !(BREAKDOWN_ACTIONS as readonly string[]).includes(choice.choice)) return undefined;
  return { action: choice.choice as JevBreakdownAction, confidence: choice.confidence, probabilities: choice.probabilities, model: choice.model, costUsd: choice.costUsd };
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
