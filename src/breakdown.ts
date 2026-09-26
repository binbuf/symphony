import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBreakdown, type BreakdownConfig, type Config } from './config.js';
import { classifyBreakdown, jevProblem, type BreakdownStage } from './jev.js';
import { openRunSinks, type Logger } from './logger.js';
import { planMcp } from './mcp.js';
import type { Paths } from './paths.js';
import { getProvider, variantSupported } from './providers/index.js';
import { startSession } from './session.js';
import type { Task } from './tasks.js';
import { renderPrompt } from './templates.js';
import { clip, squash, stamp } from './util.js';

/**
 * Automatic task breakdown. Three stages can open a decision — before a task starts, at a `continue`
 * boundary, and when a task would otherwise escalate or fail — and one answer decides: split the
 * task into subtasks (`symphony split` machinery), carry on as before, skip a pointless escalation,
 * or give up. The decision comes from Jev first, then a fallback LLM session, then deterministic
 * rules; every source above the rules can fail without blocking the run.
 */

/** What the harness should do with the task an open decision is about. */
export type BreakdownAction = 'split' | 'proceed' | 'escalate' | 'stop';

export interface BreakdownEvidence {
  stage: BreakdownStage;
  task: Task;
  /** The task file body (already capped by the caller), for the decision sources that read it. */
  taskBody?: string;
  taskBytes?: number;
  status: string;
  attempts: number;
  continuations: number;
  /** Failure category (stage `failure`). */
  category?: string;
  /** The continuation summary, the failure message, or the verify output that opened the decision. */
  reason?: string;
}

export interface BreakdownVerdict {
  action: BreakdownAction;
  /** Which source answered. */
  source: 'jev' | 'llm' | 'rules';
  /** One line for the run log: why this action was chosen. */
  reason: string;
  confidence?: number;
  costUsd?: number;
}

export interface BreakdownDeps {
  log?: Logger;
  paths?: Paths;
  abort?: AbortSignal;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Overridable for tests: answer the decision with a fallback LLM session. */
  askLlm?: (ev: BreakdownEvidence) => Promise<LlmBreakdownAnswer | undefined>;
}

/**
 * The deterministic trigger: is this task at this stage worth a decision at all? The gates keep the
 * cost bounded — a decision is never asked on every task, slice or failure unless configured to.
 */
export function breakdownGate(b: BreakdownConfig, ev: BreakdownEvidence): { open: boolean; why: string } {
  if (!b.enabled) return { open: false, why: 'breakdown is off' };
  if (ev.stage === 'start') {
    if (!b.onStart) return { open: false, why: 'breakdown.onStart is off' };
    const bytes = ev.taskBytes ?? 0;
    if (bytes < b.rules.minTaskBytes) return { open: false, why: `task file is ${bytes} B (< breakdown.rules.minTaskBytes ${b.rules.minTaskBytes})` };
    return { open: true, why: `task file is ${bytes} B (>= breakdown.rules.minTaskBytes ${b.rules.minTaskBytes})` };
  }
  if (ev.stage === 'continue') {
    if (!b.onContinue) return { open: false, why: 'breakdown.onContinue is off' };
    if (ev.continuations < b.rules.afterContinuations) return { open: false, why: `continuation ${ev.continuations} (< breakdown.rules.afterContinuations ${b.rules.afterContinuations})` };
    return { open: true, why: `continuation ${ev.continuations} (>= breakdown.rules.afterContinuations ${b.rules.afterContinuations})` };
  }
  if (!b.onFailure) return { open: false, why: 'breakdown.onFailure is off' };
  if (ev.category && !b.rules.onCategories.includes(ev.category)) return { open: false, why: `category ${ev.category} is not in breakdown.rules.onCategories` };
  if (ev.attempts < b.rules.afterFailedAttempts) return { open: false, why: `${ev.attempts} session${ev.attempts === 1 ? '' : 's'} (< breakdown.rules.afterFailedAttempts ${b.rules.afterFailedAttempts})` };
  return { open: true, why: `${ev.attempts} session${ev.attempts === 1 ? '' : 's'}, category ${ev.category ?? 'task'}` };
}

/** The deterministic answer once a gate is open: split (the preferred path) unless configured otherwise. */
export function rulesVerdict(b: BreakdownConfig, ev: BreakdownEvidence, why: string): BreakdownVerdict {
  const closing = ev.stage === 'start'
    ? 'split before running it'
    : ev.stage === 'continue'
      ? 'split instead of another slice'
      : 'split instead of escalating';
  if (ev.stage === 'failure' && !b.preferOverEscalation) {
    return { action: 'proceed', source: 'rules', reason: `${why}; keeping the ordinary failure path (breakdown.preferOverEscalation is off)` };
  }
  return { action: 'split', source: 'rules', reason: `${why}; ${closing}` };
}

/** `run`/`continue` are the natural words per stage; both mean "carry on". */
function normalizeAction(word: string): BreakdownAction | undefined {
  const w = word.toLowerCase();
  if (w === 'split') return 'split';
  if (w === 'stop') return 'stop';
  if (w === 'escalate') return 'escalate';
  if (w === 'proceed' || w === 'run' || w === 'continue') return 'proceed';
  return undefined;
}

/** The decisions a source may answer at this stage (the failure stage alone offers escalate/stop). */
export function allowedActions(stage: BreakdownStage): BreakdownAction[] {
  return stage === 'failure' ? ['split', 'escalate', 'stop', 'proceed'] : ['split', 'proceed'];
}

/**
 * The decision chain for one open gate: Jev (fast, typed) → the fallback LLM (one read-only session)
 * → the deterministic rules. Any source that is off, unavailable, too slow or not confident enough
 * falls through, so the rules always answer. Returns undefined when the gate is closed.
 */
export async function decideBreakdown(config: Config, ev: BreakdownEvidence, deps: BreakdownDeps = {}): Promise<BreakdownVerdict | undefined> {
  const b = config.breakdown;
  const gate = breakdownGate(b, ev);
  if (!gate.open) return undefined;

  if (b.decision === 'auto' || b.decision === 'jev') {
    if (config.jev.enabled && config.jev.breakdownDecision) {
      const problem = jevProblem(config.jev, deps.env ?? process.env);
      if (problem) deps.log?.warn(`${ev.task.id}: [jev] breakdown decision unavailable (${problem}); falling back`);
      else {
        const decision = await classifyBreakdown(
          config.jev,
          {
            stage: ev.stage, taskTitle: ev.task.title, taskBody: ev.taskBody, status: ev.status,
            attempts: ev.attempts, continuations: ev.continuations, reason: ev.reason,
          },
          { fetchImpl: deps.fetchImpl, env: deps.env, signal: deps.abort },
        );
        const pct = decision ? Math.round(decision.confidence * 100) : 0;
        if (decision && decision.confidence >= config.jev.minConfidence) {
          return { action: decision.action, source: 'jev', reason: `${gate.why} · Jev chose ${decision.action} (${pct}%)`, confidence: decision.confidence, costUsd: decision.costUsd };
        }
        deps.log?.warn(decision
          ? `${ev.task.id}: [jev] breakdown decision "${decision.action}" was only ${pct}% confident (min ${Math.round(config.jev.minConfidence * 100)}%); falling back`
          : `${ev.task.id}: [jev] breakdown decision returned no usable answer; falling back`);
      }
    }
  }

  if (b.decision === 'auto' || b.decision === 'llm') {
    const ask = deps.askLlm ?? (deps.paths ? (e: BreakdownEvidence) => askBreakdownLlm(config, e, deps) : undefined);
    if (ask) {
      const answer = await ask(ev);
      if (answer) {
        return { action: answer.action, source: 'llm', reason: `${gate.why} · fallback LLM chose ${answer.action}${answer.reason ? `: ${answer.reason}` : ''}`, confidence: answer.confidence, costUsd: answer.costUsd };
      }
      // The session runner already logged why; a test-injected decider may simply decline.
    } else {
      deps.log?.warn(`${ev.task.id}: breakdown decision: no fallback LLM is runnable; using the rules`);
    }
  }

  return rulesVerdict(b, ev, gate.why);
}

export interface LlmBreakdownAnswer {
  action: BreakdownAction;
  reason?: string;
  confidence?: number;
  costUsd?: number;
}

const BLOCK_RE = /SYMPHONY_BREAKDOWN[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*END_SYMPHONY_BREAKDOWN/i;

/**
 * Read the decision out of a fallback-LLM session's final text: the `SYMPHONY_BREAKDOWN` block when
 * present, otherwise a bare `decision:` line, so a model that ignores the framing still counts.
 */
export function parseBreakdownAnswer(text: string, stage: BreakdownStage): LlmBreakdownAnswer | undefined {
  const block = BLOCK_RE.exec(text);
  const body = block ? block[1] : text;
  const decision = /^[ \t]*decision[ \t]*:[ \t]*([A-Za-z]+)/im.exec(body);
  if (!decision) return undefined;
  const action = normalizeAction(decision[1]);
  if (!action || !allowedActions(stage).includes(action)) return undefined;
  const reason = /^[ \t]*reason[ \t]*:[ \t]*(.+)$/im.exec(body);
  return { action, reason: reason ? squash(reason[1], 200) : undefined };
}

const STAGE_LINES: Record<BreakdownStage, string> = {
  start: 'A coding agent is about to start this task in one unattended session. Is it sized for that, or is it really several pieces of work that should become smaller subtasks first?',
  continue: 'The task has used one or more sessions, each ending with "continue" (unfinished), and another slice is about to start. Should it keep going, or is the task too large for this approach?',
  failure: 'The task failed. Should the harness break it into smaller subtasks, retry it on a more capable model, or give up?',
};

const STAGE_DECISIONS: Record<BreakdownStage, string> = {
  start: '- run: the task is one coherent session of work; run it as it is.\n- split: it mixes several independent pieces of work, or is larger than one session; split it first.',
  continue: '- continue: the work is converging; let the next slice run.\n- split: it is not converging, or is too large; break it into smaller subtasks.',
  failure: '- split: smaller subtasks are more likely to succeed than a stronger model.\n- escalate: a more capable model would plausibly finish it from the same context.\n- stop: neither helps (missing context or a human decision).\n- proceed: unclear; take the ordinary failure path.',
};

/** The fallback-LLM prompt: a self-contained snapshot so the read-only session answers without tools. */
export function buildBreakdownPrompt(ev: BreakdownEvidence, gateReason: string): string {
  const evidence: string[] = [];
  if (ev.stage === 'continue') {
    evidence.push(`- last slice reported: ${squash(ev.reason ?? 'continue', 300)}`);
    evidence.push(`- continuation limit: ${ev.continuations} slice(s) used`);
  } else if (ev.stage === 'failure') {
    evidence.push(`- failure category: ${ev.category ?? 'task'}`);
    evidence.push(`- failure: ${squash(ev.reason ?? '(no message)', 400)}`);
  } else if (ev.taskBytes !== undefined) {
    evidence.push(`- task file size: ${ev.taskBytes} bytes`);
  }
  return renderPrompt('breakdown.md', {
    stage: ev.stage,
    stageLine: STAGE_LINES[ev.stage],
    decisions: STAGE_DECISIONS[ev.stage],
    taskId: ev.task.id,
    taskTitle: ev.task.title,
    taskPhase: ev.task.phase,
    status: ev.status,
    attempts: ev.attempts,
    continuations: ev.continuations,
    evidence: evidence.join('\n') || '- (nothing recorded yet)',
    gateReason,
    taskBody: ev.taskBody?.trim() ? clip(ev.taskBody, 12_000) : '(no task file — the roadmap bullet is the whole task)',
  });
}

/** Run one read-only fallback-LLM session and read its decision. Never throws; undefined on any problem. */
async function askBreakdownLlm(config: Config, ev: BreakdownEvidence, deps: BreakdownDeps): Promise<LlmBreakdownAnswer | undefined> {
  const { paths, log } = deps;
  if (!paths) return undefined;
  try {
    const { spec, warnings } = resolveBreakdown(config, variantSupported);
    warnings.forEach((w) => log?.warn(`breakdown: ${w}`));
    log?.info(`${ev.task.id}: breakdown decision (${ev.stage}) with ${spec.providerName}${spec.model ? ` · ${spec.model}` : ''} · timeout ${config.breakdown.timeoutMin} min`);
    const provider = getProvider(spec.providerName);
    const sinks = openRunSinks(paths.runs, `breakdown-${ev.stage}-${ev.task.id}-${stamp()}`);
    const prompt = buildBreakdownPrompt(ev, breakdownGate(config.breakdown, ev).why);
    writeFileSync(sinks.promptPath, prompt);
    const mcp = planMcp(config, 'breakdown', undefined, {}, provider.name, join(paths.runs, sinks.base), (m) => log?.warn(`${ev.task.id}: mcp: ${m}`));
    mcp?.notes.forEach((n) => log?.warn(`${ev.task.id}: mcp: ${n}`));
    const cmd = provider.buildCommand({
      bin: spec.bin, prompt, promptFile: sinks.promptPath, taskId: `breakdown-${ev.stage}`, attempt: 1, kind: 'task',
      model: spec.model, variant: spec.variant, autoApprove: false, extraArgs: [...spec.extraArgs, ...(mcp?.args ?? [])], cwd: paths.root,
    });
    if (mcp?.env) cmd.env = { ...(cmd.env ?? {}), ...mcp.env };
    log?.info(`${ev.task.id}: ${cmd.bin} ${cmd.args.join(' ')}`.slice(0, 400));
    const session = startSession({
      spec: cmd, provider, cwd: paths.root,
      timeoutMs: spec.timeoutMin * 60_000,
      idleTimeoutMs: spec.idleTimeoutMin ? spec.idleTimeoutMin * 60_000 : 0,
      sinks, liveMaxChars: 200, logMaxChars: 4000, color: false, live: false,
    });
    let outcome;
    try {
      outcome = await session.done;
    } finally {
      await sinks.close();
    }
    const answer = parseBreakdownAnswer(outcome.result.text || outcome.allText, ev.stage);
    if (!answer) {
      const why = outcome.spawnError ?? outcome.result.errorSubtype ?? (outcome.timedOut ? 'timeout' : outcome.stalled ? 'stalled' : 'no decision block');
      log?.warn(`${ev.task.id}: breakdown decision: the fallback LLM returned no usable answer (${why})`);
      return undefined;
    }
    return { ...answer, costUsd: outcome.costUsd };
  } catch (e) {
    log?.warn(`${ev.task.id}: breakdown decision: the fallback LLM failed (${(e as Error).message}); using the rules`);
    return undefined;
  }
}

export type { BreakdownStage };
