import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { decideBreakdown, type BreakdownEvidence, type BreakdownStage, type BreakdownVerdict } from './breakdown.js';
import { classifyFailure, evidenceText, makeClassified, type Classified, type FailureEvidence } from './classify.js';
import { resolveEscalation, resolveFallback, resolveJudge, resolveSession, resolveVerify, type CliOverrides, type Config, type SessionSpec } from './config.js';
import { writeProgressIndex } from './context.js';
import { formatChecks, runDoctor, type ExtraProvider } from './doctor.js';
import { commitAll, currentBranch, describeCommit } from './git.js';
import { contractsFor, dependencyClosure, isLandedSubset, parseAcceptance, summarizeAcceptance, topoOrder, validateContracts, type AcceptanceItem, type TaskContract } from './graph.js';
import { fireHook } from './hooks.js';
import { classifyCompletion, classifyError, classifyEscalation, classifySessionResult, jevProblem } from './jev.js';
import { collectChanges, runJudge, type JudgeEvidence, type JudgeJevCheck, type JudgeVerdict } from './judge.js';
import { createLogger, openRunSinks, type Logger, type RunSinks } from './logger.js';
import { writeTaskLog } from './logs.js';
import { mcpPromptNote, planMcp, resolveMcpProfile } from './mcp.js';
import { placeStop, stopPresent, type Paths } from './paths.js';
import { buildContinuePrompt, buildNudgePrompt, buildResumePrompt, buildTaskPrompt, buildWrapUpPrompt, ensureProgressFile, taskFileBody, type PromptCtx } from './prompt.js';
import { applyPlan, loadProject, retargetFlags, sanitizeFlags } from './project.js';
import { computeAttemptDelta, isStalled, metricPlateau, parseMetric } from './progress.js';
import { createRemainderTask } from './remainder.js';
import { getProvider, variantSupported } from './providers/index.js';
import { addUsage } from './providers/common.js';
import type { Provider, ResultEvent, SpawnSpec, TokenUsage } from './providers/types.js';
import { generateIndex, writeIndex } from './repomap.js';
import type { ReplanResult } from './replan.js';
import { parseResultBlock, type ResultBlock } from './result.js';
import { canonicalId, patchRoadmapFile, type Roadmap } from './roadmap.js';
import { startSession, type Session, type SessionOutcome } from './session.js';
import type { SplitResult } from './split.js';
import { pidAlive, updatePipelineStatus } from './status.js';
import { DONE_STATES, SKIP_STATES, acquireLock, haltResumeHint, liveLock, newTaskState, readLock, releaseLock, saveState, startLockHeartbeat, type Halted, type LastError, type LogRef, type State, type TaskState, type TaskStatus } from './state.js';
import { parseFrontMatter, type Task } from './tasks.js';
import { UsageError, ensureDir, fmtCost, fmtDuration, nowIso, sleep, squash, stamp } from './util.js';
import { runVerify, type VerifyResult } from './verify.js';
import { visionPromptNote } from './vision.js';
import { notifyTaskSlack, slackProject, type SlackEvent } from './slack.js';
import { startPipelineWatch, type WatchState } from './watch.js';

/**
 * Fraction of `maxCostUsdPerRun` at which the `budgetClose` Slack notice fires (once per run). Only
 * meaningful when the run budget is configured (`maxCostUsdPerRun > 0`); `budgetExceeded` fires at the
 * cap itself and is what halts the run.
 */
export const BUDGET_CLOSE_FRACTION = 0.8;

export interface RunFlags {
  from?: string;
  to?: string;
  only?: string[];
  retry: boolean;
  continueOnFailure: boolean;
  dryRun: boolean;
  clearHalt: boolean;
}

/**
 * A `symphony split` requested live from the run view: the run stops at the next boundary (or the
 * session is stopped when the task is the one running), the split session rewrites the task, and the
 * run resumes on the subtasks. Set by the TUI; never by the CLI, which runs `split` on its own.
 */
export interface SplitRequest {
  id: string;
  into?: number;
  note?: string;
}

/**
 * A breakdown performed by the runner itself (an automatic split). Wired by the CLI to the `split`
 * machinery with the run's lock shared; absent in unit tests, where no automatic split is possible.
 */
export type PerformSplit = (taskId: string) => Promise<SplitResult>;

/**
 * A plan-wide rewrite performed by the runner itself (an automatic replan). Wired by the CLI to the
 * `replan` machinery with the run's lock shared; absent in unit tests.
 */
export type PerformReplan = (taskId: string, ev: BreakdownEvidence, decisionReason: string) => Promise<ReplanResult>;

export interface RunContext {
  paths: Paths;
  config: Config;
  cli: CliOverrides;
  flags: RunFlags;
  log: Logger;
  roadmap: Roadmap;
  tasks: Task[];
  state: State;
  interrupted: boolean;
  signalName?: string;
  active?: Session;
  abort: AbortController;
  /** Overridable for tests: the fetch used for Jev decision calls (defaults to the global fetch). */
  fetchImpl?: typeof fetch;
  /** Branch HEAD pointed at when the run started; commits refuse to land elsewhere. */
  startBranch?: string;
  /** Session cost reported during this invocation, for the provider-agnostic run budget. */
  runCostUsd?: number;
  /** Session token usage reported during this invocation, summed across sessions and decisions. */
  runUsage?: TokenUsage;
  /**
   * The task id to pause *before* instead of at the next boundary. Set live from the TUI: the run
   * keeps going through the tasks ahead of it and the sentinel is placed when the pipeline reaches
   * it, so the stop lands exactly on the chosen task. Cleared once it fires.
   */
  pauseAt?: string;
  /** A split requested live from the TUI; the run stops, `split` runs, then the wrapper resumes it. */
  splitRequest?: SplitRequest;
  /**
   * A "pause as soon as possible" requested live from the run view: the session in flight is stopped,
   * the agent is asked to close the task out (update the progress notes/Hand-off, leave a clean
   * build), the harness commits the slice and pauses, so the task resumes at its next slice on the
   * next run. Set only while a session is active; consumed by `runTask`.
   */
  wrapUpRequest?: boolean;
  /** Run an automatic breakdown for a task; the CLI wires this to `split` with the run's lock shared. */
  performSplit?: PerformSplit;
  /** Run an automatic plan rewrite for a task; the CLI wires this to `replan` with the run's lock shared. */
  performReplan?: PerformReplan;
  /** Parsed task contracts and dependency edges, keyed by task id; computed once per run. */
  contracts?: Map<string, TaskContract>;
  /** Automatic breakdowns attempted per task id in this run; bounds a task that keeps failing. */
  autoSplits?: Map<string, number>;
  /** Judge sessions run per terminal `done` attempt (keyed by task id + attempt); bounds re-judging. */
  judgeCounts?: Map<string, number>;
  /** Slack thread roots per task id (task id → root message `ts`), so later events reply in-thread. */
  slackThreads?: Map<string, string>;
  /** Called when the run itself rewrote the plan (an automatic breakdown), so a live view can refresh. */
  onPlanChanged?: (parentId: string, childIds: string[]) => void;
  /** Called when an automatic replan rewrote the plan, so a live view can refresh and report. */
  onReplanned?: (taskId: string, pending: string[]) => void;
  /** Live pipeline-watch state shown in the TUI's top panel; undefined when the watcher is off. */
  watch?: WatchState;
  /** Trigger an immediate pipeline-watch check (bound by the watcher). */
  watchRefresh?: () => void;
}

interface Final { status: TaskStatus; summary: string; lastError?: LastError }
interface TaskOutcome { status: TaskStatus; halt?: Halted; stopped?: boolean; interrupted?: boolean; split?: boolean; replan?: boolean }

const LIVE_MAX = 400;
const LOG_MAX = 4000;

export function renderTemplate(t: string, vars: Record<string, string>): string {
  return t.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export function describeCmd(cmd: SpawnSpec): string {
  const q = (a: string) => (a.length > 80 ? `<${Buffer.byteLength(a, 'utf8')} bytes>` : /[\s"']/.test(a) ? JSON.stringify(a) : a);
  return `${cmd.bin} ${cmd.args.map(q).join(' ')}${cmd.stdinPayload ? `  (+ ${Buffer.byteLength(cmd.stdinPayload, 'utf8')} bytes on stdin)` : ''}`;
}

function patchRoadmap(ctx: RunContext, id: string, status: TaskStatus): void {
  try {
    const r = patchRoadmapFile(ctx.paths.roadmap, id, status);
    if (r === 'missing') ctx.log.warn(`${id}: bullet no longer found in ROADMAP.md; state.json remains authoritative`);
  } catch (e) {
    ctx.log.warn(`${id}: could not patch ROADMAP.md: ${(e as Error).message}`);
  }
}

/**
 * Regenerate the derived docs the prompt reads: the PROGRESS.md "Key facts" digest and docs/INDEX.md.
 * Never fatal: a failure only warns, because the prompt degrades to the raw progress file.
 */
function refreshDerivedDocs(ctx: RunContext): void {
  const { paths, config, log } = ctx;
  if (config.progressDigest) {
    try { writeProgressIndex(paths); } catch (e) { log.warn(`could not update the ${relative(paths.root, paths.progress)} index: ${(e as Error).message}`); }
  }
  if (config.repoMap) {
    try { writeIndex(paths); } catch (e) { log.warn(`could not write ${relative(paths.root, paths.index)}: ${(e as Error).message}`); }
  }
}

/** One automatic-breakdown attempt: the verdict, when the gate was open, and what it rewrote. */
interface AutoBreakdown { verdict?: BreakdownVerdict; split: boolean; replan: boolean }

/** The evidence a breakdown decision reads: the task, its recorded state, and the stage's reason. */
function breakdownEvidence(ctx: RunContext, task: Task, stage: BreakdownStage, extra: { category?: string; reason?: string; continuations?: number; status?: string } = {}): BreakdownEvidence {
  const st = ctx.state.tasks[task.id];
  const body = taskFileBody(task, ctx.config.maxTaskBytes);
  return {
    stage,
    task,
    taskBody: body,
    status: extra.status ?? st?.status ?? 'pending',
    attempts: st?.attempts ?? 0,
    continuations: extra.continuations ?? st?.continuation ?? 0,
    category: extra.category,
    reason: extra.reason ?? st?.lastError?.message ?? st?.summary,
  };
}

/** Charge a decision's reported cost to the task and to this run, like a session's cost. */
function addDecisionCost(ctx: RunContext, task: Task, costUsd: number | undefined): void {
  if (costUsd === undefined) return;
  ctx.runCostUsd = (ctx.runCostUsd ?? 0) + costUsd;
  const st = ctx.state.tasks[task.id];
  if (st) st.costUsd = (st.costUsd ?? 0) + costUsd;
}

/**
 * Of a task's changed paths, the ones that are symphony's own bookkeeping (the ROADMAP status block,
 * the progress digest, per-task progress notes, run logs, `.symphony/` and the stop sentinel) rather
 * than work the task was asked to do. Passed to the judge so it does not read harness state as scope.
 */
function harnessChangedFiles(paths: Paths, files: string[]): string[] {
  const rel = (p: string) => relative(paths.root, p).replace(/\\/g, '/');
  const exact = new Set([paths.roadmap, paths.progress, paths.index, paths.stop].map(rel));
  const dirs = [paths.progressDir, paths.logsDir, paths.symphony].map((d) => `${rel(d).replace(/\/+$/, '')}/`);
  return files.filter((f) => exact.has(f) || dirs.some((d) => f.startsWith(d)));
}

/**
 * The independent Jev cross-check before an enforceable rejection. It reuses the judge's evidence
 * (compact; Jev cannot read the worktree) and can only *soften*: the demotion proceeds only when Jev
 * independently agrees the completion should be rejected. A Jev that is unavailable, too slow, or
 * unconvincing returns undefined, and the LLM judge's decision stands. Runs only when `jev.enabled`
 * and `judge.jev` are both on. Records a `judge` step for the check so it is tracked like any run.
 */
async function runJevJudgeCheck(
  ctx: RunContext,
  task: Task,
  st: TaskState,
  ev: JudgeEvidence,
  verdict: JudgeVerdict,
): Promise<JudgeJevCheck | undefined> {
  const { config, log, paths, state } = ctx;
  const problem = jevProblem(config.jev, process.env);
  if (problem) {
    log.warn(`${task.id}: judge.jev is on but the Jev cross-check is unavailable (${problem}); enforcing as the judge decided`);
    return undefined;
  }
  const started = nowIso();
  let note = '';
  const decision = await classifyCompletion(
    config.jev,
    {
      taskTitle: task.title,
      taskBody: ev.taskBody,
      acceptance: ev.acceptance?.length ? ev.acceptance.map((a) => `- [${a.checked ? 'x' : ' '}] ${a.text}${a.blocking ? '' : ' [deferrable]'}`).join('\n') : undefined,
      verify: ev.verifyCommand ? `${ev.verifyCommand} → ${ev.verifyOk ? 'passed' : 'failed or not run'}` : undefined,
      evidence: [
        verdict.summary ? `reviewer summary: ${verdict.summary}` : '',
        verdict.gaps ? `reviewer gaps: ${verdict.gaps}` : '',
        ev.changedFiles?.length ? `changed files: ${ev.changedFiles.slice(0, 40).join(', ')}` : '',
        ev.diff?.trim() ? `diff:\n${ev.diff}` : '',
      ].filter(Boolean).join('\n'),
    },
    { fetchImpl: ctx.fetchImpl, signal: ctx.abort.signal, note: (m) => { note = m; } },
  );
  // Jev confirms only when it independently calls it a fail above its own confidence bar. Anything
  // else — a pass, a weak fail, or no usable answer — declines the demotion.
  const agreed = !!decision && decision.verdict === 'fail' && decision.confidence >= config.jev.minConfidence;
  if (decision?.costUsd !== undefined) addDecisionCost(ctx, task, decision.costUsd);
  const pct = decision ? Math.round(decision.confidence * 100) : 0;
  const summary = decision
    ? `independent Jev cross-check: ${agreed ? 'confirms the rejection' : `declines to enforce (${decision.verdict} ${pct}%)`}`
    : `Jev cross-check returned no usable answer${note ? ` (${note})` : ''}`;
  st.logs.push({
    kind: 'judge', jsonl: '', log: '', prompt: '', started,
    status: decision ? `${decision.verdict} ${pct}%${agreed ? ' confirmed' : ' declined'}` : 'no answer',
    provider: 'jev',
    model: decision?.model ?? config.jev.model,
    summary,
    costUsd: decision?.costUsd,
    durationS: Math.max(0, Math.round((Date.now() - Date.parse(started)) / 1000)),
  });
  saveState(paths, state);
  updatePipelineStatus(paths, ctx.tasks, state, log);
  log.info(`${task.id}: judge.jev cross-check ${decision ? `${decision.verdict.toUpperCase()} ${pct}%` : 'no answer'} — ${agreed ? 'confirms the rejection' : 'the done stands'}`);
  return decision
    ? { verdict: decision.verdict, confidence: decision.confidence, agreed, summary, model: decision.model, costUsd: decision.costUsd }
    : undefined;
}

/**
 * Run the independent completion judge for a task about to be finalized `done`, if the judge is
 * enabled and has not already hit `judge.maxPerTask` for this terminal `done` attempt. Gathers the
 * evidence (task intent, acceptance items, the verify result, the worktree diff and the session's own
 * summary), runs one read-only session, charges its cost, records the verdict and the session on the
 * task state, and refreshes the ROADMAP status so the judge run is tracked as it happens. Returns
 * undefined when the judge is off, over budget, or produced no usable verdict — in every such case the
 * caller accepts the `done` as reported rather than failing a task on the judge's own infrastructure;
 * a run that produced no verdict is still recorded in the task's logs for tracking.
 */
async function runCompletionJudge(ctx: RunContext, task: Task, st: TaskState, sessionSummary: string | undefined): Promise<JudgeVerdict | undefined> {
  const { config, log, paths, state } = ctx;
  // A judge-eligible `done` supersedes any earlier verdict: clear a stale fail/enforced record from a
  // previous attempt so a task that now ends done can never carry a demoted verdict in its log. The
  // prior run stays visible via the judge log rows added below and in ROADMAP.md.
  delete st.judge;
  saveState(paths, state);
  const max = config.judge.maxPerTask;
  const counts = (ctx.judgeCounts ??= new Map());
  // The cap is per terminal `done` attempt: keying by the attempt number gives each completion the
  // task reaches its own budget, so an escalated re-do after a rejected `done` is judged too.
  const key = `${task.id}#${st.attempts}`;
  const used = counts.get(key) ?? 0;
  if (max > 0 && used >= max) {
    log.warn(`${task.id}: judge already ran ${used} time(s) for this done (judge.maxPerTask ${max}); accepting the done as reported`);
    // The stale verdict was just cleared above; refresh ROADMAP so the generated status block does
    // not keep showing it until the next task boundary.
    updatePipelineStatus(paths, ctx.tasks, state, log);
    return undefined;
  }
  counts.set(key, used + 1);

  const contract = contractsOf(ctx).get(task.id);
  // Re-read the task file for acceptance so a session's own checkbox edits are seen: the cached
  // contract is parsed once per run and would otherwise report a stale checked/unchecked state.
  const body = taskFileBody(task, config.maxTaskBytes);
  const parsedAcceptance = parseAcceptance(body);
  const acceptance = parsedAcceptance.length ? parsedAcceptance : contract?.acceptance;
  const changes = config.judge.includeDiff
    ? collectChanges(paths.root, config.judge.maxDiffBytes)
    : { files: [], diff: '', truncated: false };
  const progressPath = join(paths.progressDir, `${task.id}.md`);
  const progressNote = existsSync(progressPath) ? readFileSync(progressPath, 'utf8') : undefined;
  const ev: JudgeEvidence = {
    taskId: task.id,
    taskTitle: task.title,
    taskPhase: task.phase,
    status: 'done',
    attempts: st.attempts,
    taskBody: body,
    acceptance,
    verifyCommand: st.verify?.command,
    verifyOk: st.verify?.ok,
    verifyOutput: st.verify?.output,
    sessionSummary,
    changedFiles: changes.files,
    harnessFiles: harnessChangedFiles(paths, changes.files),
    diff: changes.diff,
    diffTruncated: changes.truncated,
    progressNote,
  };

  let judgeRow: LogRef | undefined;
  const verdict = await runJudge(config, ev, {
    paths,
    log,
    abort: ctx.abort.signal,
    // Record every judge session as a row on the task, so the TUI table and the task log show each
    // run as its own step — from the moment it starts (`running`) through its verdict.
    onStart: (ref) => {
      judgeRow = { kind: 'judge', ...ref };
      st.logs.push(judgeRow);
      saveState(paths, state);
      updatePipelineStatus(paths, ctx.tasks, state, log);
    },
    onLog: (ref) => {
      if (judgeRow) Object.assign(judgeRow, ref);
      // Charge the session whether or not it produced a usable verdict: a judge that timed out,
      // stalled, or answered unusably was still paid for, so the run/task cost and the budget must
      // see it. Charging here (not only on a parsed verdict) keeps the accounting honest.
      addDecisionCost(ctx, task, ref.costUsd);
      saveState(paths, state);
    },
  });
  if (!verdict) {
    updatePipelineStatus(paths, ctx.tasks, state, log);
    return undefined;
  }
  // Decide whether a failing verdict enforces. `judge.jev`, when armed, cross-checks a rejection
  // before it demotes the done: Jev can only make the judge more conservative, never manufacture a
  // rejection. An unavailable/unconvincing Jev leaves the judge's decision in place.
  const confident = verdict.confidence !== undefined && verdict.confidence >= config.judge.minConfidence;
  verdict.enforce = !verdict.ok && confident && config.judge.onFail === 'fail';
  if (verdict.enforce && config.judge.jev && config.jev.enabled) {
    const check = await runJevJudgeCheck(ctx, task, st, ev, verdict);
    if (check) {
      verdict.jev = check;
      verdict.enforce = check.agreed;
      if (!check.agreed) log.warn(`${task.id}: judge.jev cross-check did not confirm the rejection; the done stands`);
    }
  }
  st.judge = {
    verdict: verdict.verdict,
    ok: verdict.ok,
    confidence: verdict.confidence,
    summary: verdict.summary,
    gaps: verdict.gaps,
    at: nowIso(),
    provider: verdict.provider,
    model: verdict.model,
    costUsd: verdict.costUsd,
    jev: verdict.jev ? { verdict: verdict.jev.verdict, confidence: verdict.jev.confidence, agreed: verdict.jev.agreed, model: verdict.jev.model, costUsd: verdict.jev.costUsd } : undefined,
  };
  saveState(paths, state);
  // Reflect the verdict in ROADMAP.md immediately, not only at the next task boundary, so the judge
  // run is tracked as it happens.
  updatePipelineStatus(paths, ctx.tasks, state, log);
  const pct = verdict.confidence !== undefined ? ` ${Math.round(verdict.confidence * 100)}%` : '';
  log.info(`${task.id}: judge ${verdict.ok ? 'passed' : 'failed'}${pct} — ${verdict.summary}${verdict.gaps ? ` (gaps: ${verdict.gaps})` : ''}`);
  await slackNotify(ctx, 'taskJudge', {
    title: `${task.id} judge ${verdict.ok ? 'PASS' : 'FAIL'}${pct} — ${task.title}`,
    lines: [
      `${verdict.verdict.toUpperCase()}${pct} · ${verdict.provider ?? '?'}${verdict.model ? ` · ${verdict.model}` : ''}`,
      verdict.summary,
      verdict.gaps ? `gaps: ${verdict.gaps}` : '',
      verdict.jev ? `Jev cross-check: ${verdict.jev.verdict.toUpperCase()}${verdict.jev.confidence !== undefined ? ` ${Math.round(verdict.jev.confidence * 100)}%` : ''} — ${verdict.jev.agreed ? 'confirmed' : 'declined; the done stands'}` : '',
      verdict.ok ? '' : verdict.enforce ? 'rejected the done; the task re-enters recovery (retry/escalation/breakdown)' : 'advisory only; the done stands',
    ],
  }, task.id);
  return verdict;
}

/**
 * Ask for a breakdown decision at this stage and, when the answer is `split` or `replan`, run that
 * rewrite. The caller reloads the plan when `split`/`replan` is true. Without the matching delegate
 * (unit tests) or once `maxPerTask` has been spent, no decision is asked and the run behaves exactly
 * as before.
 */
async function autoBreakdown(ctx: RunContext, task: Task, ev: BreakdownEvidence): Promise<AutoBreakdown> {
  if (ctx.interrupted || (!ctx.performSplit && !ctx.performReplan)) return { split: false, replan: false };
  const max = Math.max(0, ctx.config.breakdown.maxPerTask);
  const used = ctx.autoSplits?.get(task.id) ?? 0;
  if (ctx.autoSplits && max > 0 && used >= max) return { split: false, replan: false };
  const verdict = await decideBreakdown(ctx.config, ev, { log: ctx.log, paths: ctx.paths, abort: ctx.abort.signal, fetchImpl: ctx.fetchImpl });
  if (!verdict) return { split: false, replan: false };
  addDecisionCost(ctx, task, verdict.costUsd);
  const pct = verdict.confidence !== undefined ? ` ${Math.round(verdict.confidence * 100)}%` : '';

  if (verdict.action === 'replan') {
    if (!ctx.performReplan) {
      ctx.log.warn(`${task.id}: ${ev.stage} breakdown chose replan, but no replan delegate is wired; carrying on with the task as it is`);
      return { verdict, split: false, replan: false };
    }
    ctx.log.warn(`${task.id}: ${ev.stage} replan (${verdict.source}${pct}): ${verdict.reason}`);
    ctx.autoSplits?.set(task.id, used + 1);
    let result: ReplanResult;
    try {
      result = await ctx.performReplan(task.id, ev, verdict.reason);
    } catch (e) {
      ctx.log.warn(`${task.id}: replan did not complete (${(e as Error).message}); carrying on with the task as it is`);
      return { verdict, split: false, replan: false };
    }
    if (result.code !== 0) {
      ctx.log.warn(`${task.id}: replan did not complete (exit ${result.code}${result.error ? `: ${result.error}` : ''}); carrying on with the task as it is`);
      return { verdict, split: false, replan: false };
    }
    ctx.log.info(`${task.id}: plan rewritten; continuing with ${result.pending?.join(' ') || 'the remaining tasks'}`);
    ctx.onReplanned?.(task.id, result.pending ?? []);
    await slackNotify(ctx, 'taskReplan', {
      title: `${task.id} replanned — ${task.title}`,
      lines: [
        result.pending?.length ? `next up: ${result.pending.slice(0, 12).join(' ')}${result.pending.length > 12 ? ` … +${result.pending.length - 12} more` : ''}` : 'no unfinished tasks left in the new plan',
        `${ev.stage} breakdown (${verdict.source}): ${verdict.reason}`,
      ],
    }, task.id);
    return { verdict, split: false, replan: true };
  }

  if (verdict.action !== 'split') {
    ctx.log.info(`${task.id}: ${ev.stage} breakdown check: ${verdict.action} — ${verdict.reason}`);
    return { verdict, split: false, replan: false };
  }
  ctx.log.warn(`${task.id}: ${ev.stage} breakdown (${verdict.source}${pct}): ${verdict.reason}`);
  ctx.autoSplits?.set(task.id, used + 1);
  if (!ctx.performSplit) {
    ctx.log.warn(`${task.id}: breakdown chose split, but no split delegate is wired; carrying on with the task as it is`);
    return { verdict, split: false, replan: false };
  }
  let result: SplitResult;
  try {
    result = await ctx.performSplit(task.id);
  } catch (e) {
    ctx.log.warn(`${task.id}: breakdown did not complete (${(e as Error).message}); carrying on with the task as it is`);
    return { verdict, split: false, replan: false };
  }
  if (result.code !== 0) {
    ctx.log.warn(`${task.id}: breakdown did not complete (exit ${result.code}${result.error ? `: ${result.error}` : ''}); carrying on with the task as it is`);
    return { verdict, split: false, replan: false };
  }
  ctx.log.info(`${task.id}: broken down into ${result.children.join(', ')}; continuing with the subtasks`);
  retargetFlags(ctx.flags, task.id, result.children);
  ctx.onPlanChanged?.(task.id, result.children);
  await slackNotify(ctx, 'taskSplit', {
    title: `${task.id} split — ${task.title}`,
    lines: [
      result.children.length ? `into ${result.children.join(', ')}` : '',
      `${ev.stage} breakdown${verdict.source ? ` (${verdict.source})` : ''}: ${verdict.reason}`,
    ],
  }, task.id);
  return { verdict, split: true, replan: false };
}

/** Re-read the plan and its state after an automatic split/replan rewrote them, in place on the context. */
function reloadAfterRewrite(ctx: RunContext): void {
  const loaded = loadProject(ctx.paths, ctx.log);
  loaded.warnings.forEach((w) => ctx.log.warn(w));
  if (loaded.roadmapError) ctx.log.error(loaded.roadmapError);
  applyPlan(ctx, loaded);
}

function mkError(c: Classified): LastError {
  return { category: c.category, message: c.message, transient: c.transient, fatal: c.fatal, at: nowIso() };
}

/**
 * A configured-but-unusable Jev is a misconfiguration, not a soft fallback: when `jev.enabled` is
 * true, at least one workflow is armed, and its API key is missing, the run halts (exit 3) so the
 * problem cannot go unnoticed. With no workflow armed there is nothing to silently disable, so the
 * run proceeds. `undefined` means Jev is off, idle, or ready to run.
 */
function jevMisconfigHalt(config: Config): Halted | undefined {
  if (!config.jev.enabled) return undefined;
  const armed = config.jev.resultFallback || config.jev.failureTriage || config.jev.escalationDecision || config.jev.breakdownDecision || (config.judge.enabled && config.judge.jev);
  if (!armed) return undefined;
  const problem = jevProblem(config.jev, process.env);
  if (!problem) return undefined;
  return { at: nowIso(), category: 'config', reason: `Jev is enabled but ${problem}. Set ${config.jev.apiKeyEnv}, or turn off jev.enabled.` };
}

export function outcomeEvidence(out: SessionOutcome): FailureEvidence {
  return {
    apiErrorCategories: out.hints.apiErrorCategories,
    errorTexts: out.hints.errorTexts,
    resultOk: out.result.ok,
    resultSubtype: out.result.errorSubtype,
    resultText: out.result.text,
    sawResult: out.sawResult,
    sawError: out.sawError,
    httpStatus: out.hints.httpStatus,
    retryable: out.hints.retryable,
    retryAfterSec: out.hints.retryAfterSec,
    exitCode: out.exitCode,
    signal: out.signal,
    spawnError: out.spawnError,
    stderrTail: out.stderrTail,
    timedOut: out.timedOut,
    stalled: out.stalled,
    interrupted: out.interrupted,
  };
}

/**
 * The harness's own failure classifier, with Jev as a tie-breaker for the `unknown` bucket only.
 * The regex stays primary: Jev is consulted solely when the rules admit they do not know, and its
 * answer is mapped back through the harness's own fatal/transient rules. Any problem keeps `unknown`.
 */
async function classifyOutcome(ctx: RunContext, task: Task, st: TaskState, ev: FailureEvidence): Promise<Classified> {
  const { config, log } = ctx;
  const base = classifyFailure(ev, config.halt.onCategories);
  if (base.category !== 'unknown' || !config.jev.enabled || !config.jev.failureTriage) return base;
  const problem = jevProblem(config.jev, process.env);
  if (problem) {
    log.warn(`${task.id}: [jev] failure is unclassified but Jev is unavailable (${problem})`);
    return base;
  }
  let note = '';
  const decision = await classifyError(config.jev, { evidence: evidenceText(ev), exitCode: ev.exitCode, resultSubtype: ev.resultSubtype }, { fetchImpl: ctx.fetchImpl, signal: ctx.abort.signal, note: (m) => { note = m; } });
  if (!decision) {
    log.warn(`${task.id}: [jev] failure is unclassified; Jev returned no usable category${note ? ` (${note})` : ''}`);
    return base;
  }
  // A call that answered was paid for even if the answer is then discarded for low confidence.
  if (decision.costUsd !== undefined) {
    st.costUsd = (st.costUsd ?? 0) + decision.costUsd;
    ctx.runCostUsd = (ctx.runCostUsd ?? 0) + decision.costUsd;
  }
  const pct = Math.round(decision.confidence * 100);
  if (decision.confidence < config.jev.minConfidence) {
    log.warn(`${task.id}: [jev] failure is unclassified; Jev's ${decision.category} was only ${pct}% confident (min ${Math.round(config.jev.minConfidence * 100)}%)`);
    return base;
  }
  const classified = makeClassified(decision.category, `${base.message} · Jev: ${decision.category} (${pct}%)`, config.halt.onCategories);
  log.warn(`${task.id}: [jev] failure was unclassified; Jev reads it as ${classified.category} (${pct}%) — ${classified.fatal ? 'fatal' : classified.transient ? 'retryable' : 'terminal'}`);
  return classified;
}

/** Merge a nudge outcome into the attempt: flags/result from the nudge, hints from both. */
function mergeOutcome(first: SessionOutcome, second: SessionOutcome): SessionOutcome {
  return {
    ...second,
    sessionId: second.sessionId ?? first.sessionId,
    allText: `${first.allText}\n${second.allText}`,
    usage: addUsage(first.usage, second.usage),
    hints: {
      apiErrorCategories: [...first.hints.apiErrorCategories, ...second.hints.apiErrorCategories],
      errorTexts: [...first.hints.errorTexts, ...second.hints.errorTexts],
      costUsd: (first.hints.costUsd ?? 0) + (second.hints.costUsd ?? 0) || undefined,
      usage: addUsage(first.hints.usage, second.hints.usage),
    },
  };
}

interface SessionRun {
  kind: 'task' | 'resume' | 'nudge' | 'continue' | 'escalate' | 'fallback' | 'wrapup';
  logKind: 'task' | 'retry' | 'nudge' | 'wrapup';
  attempt: number;
  resumeId?: string;
  timeoutMin: number;
}

async function runOneSession(ctx: RunContext, task: Task, st: TaskState, provider: Provider, spec: SessionSpec, prompt: string, r: SessionRun): Promise<SessionOutcome> {
  const { paths, log, state } = ctx;
  let sinks: RunSinks | undefined;
  let session: Session | undefined;
  try {
    ensureDir(paths.runs);
    const suffix = r.logKind === 'nudge' ? '-nudge' : r.logKind === 'wrapup' ? '-wrapup' : r.attempt > 1 ? `-r${r.attempt}` : '';
    sinks = openRunSinks(paths.runs, `${task.id}-${stamp()}${suffix}`);
    writeFileSync(sinks.promptPath, prompt);
    const rel = (p: string) => relative(paths.root, p);
    const entry: LogRef = { kind: r.logKind, jsonl: rel(sinks.jsonlPath), log: rel(sinks.logPath), prompt: rel(sinks.promptPath), started: nowIso(), provider: spec.providerName, model: spec.model, variant: spec.variant };
    st.logs.push(entry);

    const mcp = planMcp(ctx.config, r.kind === 'escalate' ? 'escalation' : 'task', task, ctx.cli, provider.name, join(paths.runs, sinks.base), (m) => log.warn(`${task.id}: mcp: ${m}`));
    mcp?.notes.forEach((n) => log.warn(`${task.id}: mcp: ${n}`));
    const cmd = provider.buildCommand({
      bin: spec.bin, prompt, promptFile: sinks.promptPath, taskId: task.id, attempt: r.attempt, kind: r.kind,
      resumeId: r.resumeId, model: spec.model, variant: spec.variant, autoApprove: spec.autoApprove, budgetUsd: spec.budgetUsd,
      extraArgs: [...spec.extraArgs, ...(mcp?.args ?? [])], cwd: paths.root,
    });
    if (mcp?.env) cmd.env = { ...(cmd.env ?? {}), ...mcp.env };
    log.info(`${task.id}: ${describeCmd(cmd)}`);
    if (mcp) log.info(`${task.id}: ${mcp.label}`);
    log.info(`${task.id}: streaming to ${rel(sinks.logPath)} (raw: ${rel(sinks.jsonlPath)})`);

    session = startSession({
      spec: cmd, provider, cwd: paths.root,
      timeoutMs: r.timeoutMin * 60_000, idleTimeoutMs: spec.idleTimeoutMin * 60_000,
      sinks, liveMaxChars: LIVE_MAX, logMaxChars: LOG_MAX, color: process.stdout.isTTY === true,
    });
    ctx.active = session;
    st.pid = session.pid;
    saveState(paths, state);
    if (ctx.interrupted) session.kill('interrupt');

    const outcome = await session.done;
    ctx.active = undefined;
    delete st.pid;
    await sinks.close();
    st.durationS += Math.round(outcome.durationMs / 1000);
    if (outcome.costUsd !== undefined) st.costUsd = (st.costUsd ?? 0) + outcome.costUsd;
    ctx.runCostUsd = (ctx.runCostUsd ?? 0) + (outcome.costUsd ?? 0);
    if (outcome.usage) {
      st.usage = addUsage(st.usage, outcome.usage);
      ctx.runUsage = addUsage(ctx.runUsage, outcome.usage);
    }
    if (outcome.sessionId) st.sessionId = outcome.sessionId;
    // Record what this session reported for the docs run log: the high-level result status + summary.
    const reported = parseResultBlock(outcome.result.text) ?? parseResultBlock(outcome.allText);
    entry.status = reported?.status ?? outcome.result.errorSubtype ?? (outcome.result.ok ? 'ok' : 'no-result');
    entry.summary = reported?.summary || (outcome.result.ok ? snapshotText(outcome) : outcome.result.errorSubtype);
    entry.durationS = Math.round(outcome.durationMs / 1000);
    if (outcome.costUsd !== undefined) entry.costUsd = outcome.costUsd;
    if (outcome.usage) entry.usage = outcome.usage;
    if (mcp) entry.mcp = mcp.selected;
    saveState(paths, state);
    return outcome;
  } catch (e) {
    // An unexpected fault while setting up or driving a session (a bad prompt write, an adapter
    // throw, a provider parser that lost its footing) must not take down the whole run. Surface it
    // as a failed session so the ordinary classifier and exponential backoff retry it.
    const message = e instanceof Error ? e.message : String(e);
    try { session?.kill('interrupt'); } catch { /* already gone */ }
    await sinks?.close().catch(() => {});
    ctx.active = undefined;
    delete st.pid;
    log.error(`${task.id}: session error: ${message}`);
    const result: ResultEvent = { kind: 'result', ok: false, text: '', errorSubtype: 'session_error', synthesized: true };
    return {
      result, allText: '', exitCode: 1, signal: null, timedOut: false, stalled: false, interrupted: false,
      stderrTail: '', durationMs: 0,
      hints: { apiErrorCategories: [], errorTexts: [message] }, sawResult: false, sawError: true,
    };
  }
}

/** Last non-empty assistant line, a compact fallback when a session produced no result summary. */
function snapshotText(outcome: SessionOutcome): string | undefined {
  const line = outcome.allText.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return line ? line.slice(0, 300) : undefined;
}

/** What a "pause as soon as possible" close-out produced: the session's outcome and its result block. */
interface WrapUpResult {
  outcome: SessionOutcome;
  block: ResultBlock;
}

/**
 * A "pause as soon as possible": the session in flight was just stopped, so resume it (or start a
 * fresh one when the provider cannot resume) with a close-out prompt that stops new work, updates
 * the progress notes and Hand-off, and leaves a clean build. The harness's own verify command is run
 * afterwards as the independent build check. Best-effort throughout: whatever the close-out reports,
 * the run commits the slice and pauses, so no work is lost and the task resumes next run.
 */
async function runWrapUp(
  ctx: RunContext,
  task: Task,
  st: TaskState,
  provider: Provider,
  spec: SessionSpec,
  pc: PromptCtx,
  resumeId: string | undefined,
  first: SessionOutcome,
): Promise<WrapUpResult> {
  const { paths, config, log } = ctx;
  // Pause at the next boundary as well, so however the close-out reports (continue or done) the run
  // stops after committing this task instead of launching the next slice.
  try {
    placeStop(paths);
  } catch (e) {
    log.warn(`${task.id}: could not place ${relative(paths.root, paths.stop)} (${(e as Error).message}); pausing anyway`);
  }
  const canResume = Boolean(resumeId) && provider.supportsResume;
  const verify = resolveVerify(config, task, paths.root);
  log.warn(`${task.id}: pause-now requested; ${canResume ? `resuming ${resumeId} to close out` : 'starting a fresh session to close out'}, then pausing`);
  const prompt = buildWrapUpPrompt(pc, { resumed: canResume, verify });

  let outcome: SessionOutcome;
  try {
    outcome = await runOneSession(ctx, task, st, provider, spec, prompt, {
      kind: 'wrapup', logKind: 'wrapup', attempt: 1,
      resumeId: canResume ? resumeId : undefined,
      timeoutMin: Math.min(spec.timeoutMin, config.nudgeTimeoutMin),
    });
  } catch (e) {
    log.warn(`${task.id}: close-out session could not run (${(e as Error).message}); committing what is on disk and pausing`);
    return { outcome: first, block: { status: 'continue', summary: 'paused by request; the close-out session could not run' } };
  }

  let block = parseResultBlock(outcome.result.text) ?? parseResultBlock(outcome.allText);
  if (!block) {
    const why = outcome.spawnError ?? outcome.result.errorSubtype ?? (outcome.timedOut ? 'timeout' : outcome.stalled ? 'stalled' : outcome.interrupted ? 'interrupted' : 'no result block');
    log.warn(`${task.id}: close-out session ended without a SYMPHONY_RESULT block (${why}); pausing anyway`);
    block = { status: 'continue', summary: `paused by request; the close-out session ended without a result block (${why})` };
  } else {
    block = { ...block, summary: `${block.summary || 'paused by request'} | paused by request` };
  }

  // The independent build check, reusing the harness verify command. A `done` is verified by the
  // ordinary path below; anything else is checked here so the pause never leaves a broken tree
  // unrecorded. A failure is noted, not fatal: the pause still happens and the next run fixes it.
  if (verify && block.status !== 'done') {
    log.info(`${task.id}: wrap-up build check: ${verify.command}`);
    const res = runVerify(paths.root, verify.command, verify.timeoutMin * 60_000);
    st.verify = { command: verify.command, ok: res.ok, code: res.code ?? undefined, output: res.output.slice(-2000) || undefined, at: nowIso() };
    if (res.ok) {
      log.info(`${task.id}: wrap-up build check passed`);
    } else {
      const note = `build check did not pass (exit ${res.code ?? 'timeout'}): ${verify.command} — ${squash(res.output, 200) || 'no output'}`;
      log.warn(`${task.id}: ${note}`);
      block = { ...block, summary: `${block.summary} | ${note}` };
    }
  }
  return { outcome, block };
}

/** Map a terminal task status to its Slack event. */
function slackEventFor(status: TaskStatus): SlackEvent {
  return status === 'done' ? 'taskDone' : status === 'blocked' ? 'taskBlocked' : 'taskFailed';
}

/** `opencode · model · variant high`, for the provider line in a notification. */
function sessionLabel(p: { providerName?: string; provider?: string; model?: string; variant?: string }): string {
  const name = p.providerName ?? p.provider ?? '?';
  return `${name}${p.model ? ` · ${p.model}` : ''}${p.variant ? ` · variant ${p.variant}` : ''}`;
}

/**
 * Post a lifecycle notification when Slack is on and this event is armed. Never throws. A `taskId`
 * makes the event part of that task's thread: the first message for the task is the channel root and
 * every later one replies under it. Run-level events omit it and always post as their own message.
 */
async function slackNotify(ctx: RunContext, event: SlackEvent, n: { title: string; lines?: string[] }, taskId?: string): Promise<void> {
  const project = slackProject(ctx.config.slack, ctx.paths.root);
  const threads = (ctx.slackThreads ??= new Map());
  await notifyTaskSlack(ctx.config.slack, threads, { event, project, taskId, ...n }, { fetchImpl: ctx.fetchImpl, signal: ctx.abort.signal }, (m) => ctx.log.warn(m));
}

async function finalizeTask(ctx: RunContext, task: Task, st: TaskState, final: Final, halt?: Halted): Promise<void> {
  const { paths, config, log, state } = ctx;
  st.status = final.status;
  st.summary = final.summary;
  st.finished = nowIso();
  // A task that reached a terminal state starts fresh on any later retry: clear the persisted
  // continuation counter so `maxContinuations` is not silently carried across a failure.
  delete st.continuation;
  if (final.status === 'done') delete st.lastError; else if (final.lastError) st.lastError = final.lastError;
  delete st.pid;

  const writeArtifacts = (status: TaskStatus): string => {
    // Marker first so the task's own commit carries the final [x]/[~] state.
    patchRoadmap(ctx, task.id, status);
    // Keep the generated digest and repo map in the same commit as the task that changed them.
    refreshDerivedDocs(ctx);
    const message = renderTemplate(config.commitMessageTemplate, { id: task.id, title: task.title, status });
    // Per-task run log and pipeline snapshot are written before the commit so they land in it too.
    try {
      writeTaskLog(paths, task, st, { commitPreview: message, timeZone: config.timeZone });
    } catch (e) {
      log.warn(`${task.id}: could not write ${ctx.paths.logsDir} log: ${(e as Error).message}`);
    }
    updatePipelineStatus(paths, ctx.tasks, state, log);
    return message;
  };
  const commitOnce = (message: string) => commitAll(paths.root, message, (m) => log.warn(`${task.id}: ${m}`), {
    autoIgnoreUntracked: config.git.autoIgnoreUntracked,
    extraIgnore: config.git.extraIgnore,
    expectedBranch: ctx.startBranch,
  });

  const message = writeArtifacts(final.status);
  let commit = commitOnce(message);
  if (commit.status === 'failed') {
    log.warn(`${task.id}: ${commit.detail}; retrying the commit once`);
    commit = commitOnce(message);
  }
  if (commit.status === 'failed') {
    // A task must never be recorded done when its work could not be committed. Demote it so the next
    // run (or a human) sees the problem; the work itself stays in the tree.
    const reason = `commit failed: ${commit.detail}`;
    log.error(`${task.id}: ${reason}; demoting ${final.status} -> failed`);
    final.status = 'failed';
    final.summary = reason;
    final.lastError = { category: 'commit', message: reason, transient: false, fatal: false, at: nowIso() };
    st.status = 'failed';
    st.summary = reason;
    st.lastError = final.lastError;
    delete st.commitSha;
    writeArtifacts('failed');
    st.commit = reason;
  } else {
    st.commit = describeCommit(commit);
    if (commit.status === 'committed') st.commitSha = commit.sha;
  }

  if (halt) state.halted = halt;
  saveState(paths, state);
  fireHook(config, 'afterTask', {
    SYMPHONY_ROOT: paths.root,
    SYMPHONY_TASK: task.id,
    SYMPHONY_TITLE: task.title,
    SYMPHONY_STATUS: final.status,
    SYMPHONY_SUMMARY: final.summary,
    SYMPHONY_COMMIT: st.commitSha ?? '',
    SYMPHONY_PROVIDER: st.provider ?? '',
    SYMPHONY_MODEL: st.model ?? '',
    SYMPHONY_VARIANT: st.variant ?? '',
    SYMPHONY_COST: st.costUsd !== undefined ? st.costUsd.toFixed(2) : '',
  }, (m) => log.warn(`${task.id}: ${m}`));
  await slackNotify(ctx, slackEventFor(final.status), {
    title: `${task.id} ${final.status.toUpperCase()} — ${task.title}`,
    lines: [
      `phase ${task.phase} · ${sessionLabel(st)}`,
      `duration ${fmtDuration(st.durationS)} · cost ${fmtCost(st.costUsd)}`,
      final.summary,
      st.commitSha ? `commit ${st.commitSha.slice(0, 8)}` : '',
    ],
  }, task.id);
  log.info(`=== ${task.id} -> ${final.status.toUpperCase()} · ${fmtDuration(st.durationS)} · ${fmtCost(st.costUsd)} · ${final.summary} · git: ${st.commit}`);
  // A ticket just ended: refresh the advisory watch panel now rather than waiting for the next
  // interval, so the summary leads with this outcome. Fire-and-forget; a no-op when watch is off.
  ctx.watchRefresh?.();
}

/** Active ADR titles, with historical (superseded/rejected/withdrawn) records machine-excluded. */
function activeDesignClaims(paths: Paths): string[] {
  if (!existsSync(paths.adrDir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(paths.adrDir).sort()) {
    if (!/\.md$/i.test(f) || /template/i.test(f)) continue;
    try {
      const text = readFileSync(join(paths.adrDir, f), 'utf8');
      const m = /^##\s+Status\s*\r?\n+\s*(.+)$/im.exec(text);
      const status = (m?.[1] ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (/superseded|deprecated|rejected|withdrawn/.test(status)) continue;
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || f;
      out.push(`${title} [${status || 'unstated'}]`);
    } catch { /* an unreadable ADR must not break the prompt */ }
  }
  return out;
}

/**
 * The generated operating frame every session receives: the live gate board, this task's unmet
 * prerequisites, its landed acceptance subset and the objective trigger. Assembled from state + the
 * DAG (not from PROGRESS/design prose), so stale framing cannot contradict the queue, and historical
 * decisions are machine-excluded rather than left for the session to misread as active blockers.
 */
export function buildOperatingFrame(ctx: RunContext, task: Task): string {
  const { paths, config, state } = ctx;
  const contract = contractsOf(ctx).get(task.id);
  const done = ctx.tasks.filter((t) => DONE_STATES.includes(state.tasks[t.id]?.status ?? 'pending')).length;
  const unmet = (contract?.dependsOn ?? []).filter((d) => !DONE_STATES.includes(state.tasks[d]?.status ?? 'pending'));
  const lines = ['## Operating frame (generated by symphony — do not edit)', ''];
  lines.push(`- Gate board: ${done}/${ctx.tasks.length} done · phase "${task.phase}" · this task ${task.order + 1} of ${ctx.tasks.length}.`);
  lines.push(`- Blocking now: ${unmet.length ? `waiting on prerequisite ${unmet.join(', ')}` : 'no unmet prerequisites'}.`);
  if (contract && contract.acceptance.length) {
    const s = summarizeAcceptance(contract.acceptance);
    const defer = s.unmetDeferrable.map((a) => (a.capability ? `${a.text} (needs ${a.capability})` : a.text)).join('; ');
    lines.push(`- Acceptance: ${s.checked}/${s.total} landed${s.unmetBlocking.length ? ` · still blocking: ${s.unmetBlocking.map((a) => a.text).join('; ')}` : ''}${defer ? ` · deferrable: ${defer}` : ''}.`);
  }
  const verify = resolveVerify(config, task, paths.root);
  const lastVerify = state.tasks[task.id]?.verify;
  lines.push(`- Objective trigger: ${verify ? `\`${verify.command}\` must pass` : 'no verify command configured'}${lastVerify ? ` (last verify ${lastVerify.ok ? 'passed' : 'failed'})` : ''}.`);
  const claims = config.designDocs ? activeDesignClaims(paths) : [];
  if (claims.length) lines.push(`- Active design claims (superseded/rejected excluded): ${claims.join('; ')}.`);
  return lines.join('\n');
}

function promptCtx(ctx: RunContext, task: Task, st: TaskState, spec: SessionSpec, lastError: string | undefined, continuation: number, indexBody?: string): PromptCtx {
  const mcpProfile = resolveMcpProfile(ctx.config, 'task', task, ctx.cli);
  return { paths: ctx.paths, task, tasks: ctx.tasks, state: ctx.state, attempt: st.attempts, continuation, providerName: spec.providerName, model: spec.model, variant: spec.variant, maxProgressBytes: ctx.config.maxProgressBytes, designDocs: ctx.config.designDocs, lastError, progressDigest: ctx.config.progressDigest, inlineDesignDocs: ctx.config.inlineDesignDocs, maxIndexBytes: ctx.config.maxIndexBytes, maxTaskBytes: ctx.config.maxTaskBytes, indexBody, visionNote: ctx.config.vision.enabled ? visionPromptNote() : undefined, mcpNote: mcpProfile ? mcpPromptNote(mcpProfile) : undefined, operatingFrame: buildOperatingFrame(ctx, task) };
}

/** Abortable, STOP- and split-aware backoff. Returns true when the run should stop waiting. */
async function backoff(ctx: RunContext, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !ctx.interrupted && !ctx.splitRequest) {
    if (stopPresent(ctx.paths)) return true;
    await sleep(Math.min(5000, deadline - Date.now()), ctx.abort.signal);
  }
  return stopPresent(ctx.paths) || ctx.splitRequest !== undefined;
}

/**
 * Seconds to wait before a task's Nth transient retry (1-based). Exponential by default
 * (`baseSec × factor^(n-1)`), capped at `maxSec` and jittered; a provider Retry-After raises the floor.
 * Falls back to the fixed `backoffSec` schedule when `exponential` is false or unset, so older configs
 * and tests keep their exact timing.
 */
export function retryDelaySec(retry: Config['retry'], retryIndex: number, retryAfterSec?: number): number {
  const cap = retry.maxSec ?? 15 * 60;
  let wait = retry.exponential
    ? (retry.baseSec ?? 30) * Math.pow(retry.factor ?? 2, Math.max(0, retryIndex - 1))
    : retry.backoffSec[Math.min(retryIndex - 1, retry.backoffSec.length - 1)] ?? 30;
  wait = Math.min(wait, cap);
  const jitter = retry.jitter ?? 0;
  if (jitter > 0) wait *= 1 + (Math.random() * 2 - 1) * jitter;
  if ((retry.honorRetryAfter ?? true) && retryAfterSec !== undefined && retryAfterSec > 0) wait = Math.max(wait, retryAfterSec);
  return Math.max(0, Math.round(Math.min(wait, cap)));
}

/**
 * Classify a failed verify command. A verify is the harness's own acceptance check, but it can fail
 * for infrastructure reasons that have nothing to do with the task — a dropped MCP/plugin session, a
 * reset connection — so the same rules the session classifier uses run over its output. `runTask`
 * retries only the `network` bucket (verify output is the project's own test text, so a stray status
 * code in it must not look transient).
 */
export function classifyVerifyOutput(res: VerifyResult, fatalCategories: string[]): Classified {
  const output = res.output ?? '';
  return classifyFailure({
    apiErrorCategories: [], errorTexts: [output], resultOk: false, sawResult: true,
    exitCode: res.code, signal: null, stderrTail: output,
    timedOut: /verify timed out/i.test(output), stalled: false, interrupted: false,
  }, fatalCategories);
}

/**
 * Sample the objective product metric (`metric.command`), if configured. Returns undefined when the
 * metric is off, the command fails, or it prints no number — the deterministic fingerprint then
 * carries the decision, and the run is never broken by a metric command.
 */
function readMetric(ctx: RunContext): number | undefined {
  const command = ctx.config.metric.command;
  if (!command) return undefined;
  try {
    const res = runVerify(ctx.paths.root, command, ctx.config.metric.timeoutMin * 60_000);
    const n = parseMetric(res.output);
    if (n === undefined) ctx.log.warn(`metric command printed no number: ${command}`);
    return n;
  } catch (e) {
    ctx.log.warn(`metric command failed (${(e as Error).message}); judging the attempt without it`);
    return undefined;
  }
}

/**
 * Append the observable fingerprint of the state just left behind by an attempt to the task's
 * history, capped by `progress.historySize`. Recording happens *after* the slice is committed, so the
 * next attempt's pre-commit fingerprint is directly comparable: an exact match means no net progress.
 */
function recordAttemptDelta(ctx: RunContext, task: Task, st: TaskState): void {
  if (!ctx.config.progress.enabled) return;
  try {
    const delta = computeAttemptDelta({ paths: ctx.paths, attempt: st.attempts, taskFile: task.taskFile, verify: st.verify, metric: readMetric(ctx) });
    const history = st.deltas ?? (st.deltas = []);
    history.push(delta);
    const cap = Math.max(1, ctx.config.progress.historySize);
    if (history.length > cap) st.deltas = history.slice(history.length - cap);
  } catch (e) {
    ctx.log.warn(`${task.id}: could not record the progress fingerprint: ${(e as Error).message}`);
  }
}

/** Commit a `continue` session's work so a crash never loses it. */
function commitIntermediate(ctx: RunContext, task: Task, st: TaskState): void {
  const { paths, config, log } = ctx;
  const message = renderTemplate(config.commitMessageTemplate, { id: task.id, title: task.title, status: 'continue' });
  const commitAllOpts = { autoIgnoreUntracked: config.git.autoIgnoreUntracked, extraIgnore: config.git.extraIgnore, expectedBranch: ctx.startBranch };
  let commit = commitAll(paths.root, message, (m) => log.warn(`${task.id}: ${m}`), commitAllOpts);
  if (commit.status === 'failed') commit = commitAll(paths.root, message, (m) => log.warn(`${task.id}: ${m}`), commitAllOpts);
  if (commit.status === 'committed') log.info(`${task.id}: intermediate commit ${commit.sha} (${commit.files} file${commit.files === 1 ? '' : 's'})`);
  else if (commit.status === 'failed') log.warn(`${task.id}: intermediate ${describeCommit(commit)}`);
}

export async function runTask(ctx: RunContext, task: Task): Promise<TaskOutcome> {
  const { paths, config, log, state } = ctx;
  const st = (state.tasks[task.id] ??= newTaskState(task.title));
  st.title = task.title;
  const contract = contractsOf(ctx).get(task.id);
  // When every unchecked acceptance item is deferrable, the landed blocking subset is green: the task
  // can be accepted programmatically and the remainder recorded, instead of stopping for a human.
  const deferrableRemainder = (): AcceptanceItem[] | undefined => {
    if (!contract || !isLandedSubset(contract.acceptance)) return undefined;
    return contract.acceptance.filter((a) => !a.checked);
  };
  const describeDefer = (a: AcceptanceItem): string => (a.capability ? `${a.text} (needs ${a.capability})` : a.text);
  const autoAcceptSubset = (deferred: AcceptanceItem[]): Final => {
    st.deferred = deferred;
    st.accepted = { at: nowIso(), from: st.status, note: 'auto-accepted landed subset; remaining items deferrable' };
    // The deferred remainder becomes a real ticket placed after its parent, rather than being lost or
    // left for a human. Bounded by free child ids and ceiling.maxSplitDepth; when neither allows it,
    // the remainder stays recorded on this task's state.
    const dependents = ctx.tasks.filter((t) => t.id !== task.id && (contractsOf(ctx).get(t.id)?.dependsOn ?? []).includes(task.id));
    const remainder = createRemainderTask(paths, task, deferred, ctx.tasks, config, dependents);
    if (remainder) {
      log.info(`${task.id}: all blocking acceptance items landed; accepted the subset and created remainder ${remainder.id} for ${deferred.length} deferred item(s)`);
      ctx.onPlanChanged?.(task.id, [remainder.id]);
      return { status: 'accepted', summary: `accepted landed subset automatically; deferred to ${remainder.id}: ${deferred.map(describeDefer).join('; ')}` };
    }
    log.info(`${task.id}: all blocking acceptance items landed; auto-accepting the subset and deferring ${deferred.length} item(s)`);
    return { status: 'accepted', summary: `accepted landed subset automatically; deferred: ${deferred.map(describeDefer).join('; ')}` };
  };
  const resolved = resolveSession(config, task, ctx.cli, process.env, (p) => getProvider(p).supportsBudget, variantSupported);
  const warnings = resolved.warnings;
  // `spec`/`provider` are mutable: escalation swaps them mid-task for the rest of the attempts.
  let spec = resolved.spec;
  warnings.forEach((w) => log.warn(`${task.id}: ${w}`));
  let provider = getProvider(spec.providerName);
  const escalation = resolveEscalation(config, spec, (p) => getProvider(p).supportsBudget, variantSupported);
  escalation?.warnings.forEach((w) => log.warn(`${task.id}: ${w}`));
  const maxEscalations = escalation ? Math.max(0, config.escalation.maxAttempts) : 0;
  const escalationCategories = new Set(config.escalation.onCategories);
  let escalations = 0;
  let escalating = false;
  // Fallback: a second provider/model the task switches to when the primary keeps dying on transient
  // infrastructure faults. Distinct from escalation, which only reacts to task failures.
  const fallback = resolveFallback(config, spec, (p) => getProvider(p).supportsBudget, variantSupported);
  fallback?.warnings.forEach((w) => log.warn(`${task.id}: ${w}`));
  const fallbackCategories = new Set(config.fallback.onCategories);
  const fallbackAfter = Math.max(0, config.fallback.afterAttempts);
  let onFallback = false;
  const maxAttempts = Math.max(1, config.retry.maxAttempts);
  const maxContinuations = Math.max(0, config.maxContinuations);
  const maxIterations = Math.max(0, config.maxIterationsPerTask);
  ensureProgressFile(paths);
  refreshDerivedDocs(ctx);

  let resumeId: string | undefined;
  let lastTransient: Classified | undefined;
  let retryCount = 0;
  // Seed from state so a task paused (STOP) mid-continuation resumes as the next slice, not a fresh task.
  let continuation = st.continuation ?? 0;
  let iterations = 0;
  let final: Final | undefined;
  let halt: Halted | undefined;

  /**
   * Hand the task to the escalation provider/model for a fresh attempt. Bounded by
   * `escalation.maxAttempts` and gated by `escalation.onCategories`, so it can never loop. When the
   * `escalationDecision` workflow is on, Jev reads the task and the failure first and may decline —
   * a stronger model is not worth a session when the task is stuck on missing context or a human
   * decision. Any Jev problem (off, no key, timeout, low confidence) escalates as configured.
   * `skipDecision` is set when a breakdown decision already chose escalation, so Jev is not asked twice.
   */
  const tryEscalate = async (category: string, reason: string, opts: { skipDecision?: boolean } = {}): Promise<boolean> => {
    if (!escalation || escalations >= maxEscalations) return false;
    if (!escalationCategories.has(category)) return false;
    if (!opts.skipDecision && config.jev.enabled && config.jev.escalationDecision) {
      const problem = jevProblem(config.jev, process.env);
      if (problem) {
        log.warn(`${task.id}: [jev] escalation check unavailable (${problem}); escalating on ${category} as configured`);
      } else {
        let note = '';
        const decision = await classifyEscalation(
          config.jev,
          { taskTitle: task.title, taskBody: taskFileBody(task, config.maxTaskBytes), failure: reason },
          { fetchImpl: ctx.fetchImpl, signal: ctx.abort.signal, note: (m) => { note = m; } },
        );
        const pct = decision ? Math.round(decision.confidence * 100) : 0;
        if (decision?.costUsd !== undefined) { st.costUsd = (st.costUsd ?? 0) + decision.costUsd; ctx.runCostUsd = (ctx.runCostUsd ?? 0) + decision.costUsd; }
        if (decision && decision.confidence >= config.jev.minConfidence) {
          if (!decision.escalate) {
            log.warn(`${task.id}: [jev] ${category} — ${reason}. Jev says a stronger model would not help (${pct}%); not escalating.`);
            return false;
          }
          log.info(`${task.id}: [jev] Jev agrees escalation is worth it (${pct}%)`);
        } else if (decision) {
          log.warn(`${task.id}: [jev] Jev's escalation call was only ${pct}% confident (min ${Math.round(config.jev.minConfidence * 100)}%); escalating as configured`);
        } else {
          log.warn(`${task.id}: [jev] Jev returned no usable escalation decision${note ? ` (${note})` : ''}; escalating as configured`);
        }
      }
    }
    const from = spec;
    escalations += 1;
    escalating = true;
    spec = escalation.spec;
    provider = getProvider(spec.providerName);
    // A fresh session on the new model: no resume, no pending retry, and a full task prompt.
    resumeId = undefined;
    lastTransient = undefined;
    continuation = 0;
    delete st.continuation;
    log.warn(`${task.id}: ${category} — ${reason}. Escalating to ${spec.providerName}${spec.model ? ` · ${spec.model}` : ''}${spec.variant ? ` · variant ${spec.variant}` : ''} (escalation ${escalations}/${maxEscalations}).`);
    await slackNotify(ctx, 'taskEscalated', {
      title: `${task.id} escalated — ${task.title}`,
      lines: [
        `${sessionLabel(from)} → ${sessionLabel(spec)}`,
        `${category}: ${reason}`,
        `escalation ${escalations}/${maxEscalations}`,
      ],
    }, task.id);
    return true;
  };

  /**
   * Recovery for a failure: an automatic breakdown decision first — the preferred path — then the
   * ordinary escalation route. `split`/`replan` means the plan was rewritten and the run must
   * reload; `escalated` means a fresh attempt is starting; `failed` means give up on this task.
   */
  const recover = async (category: string, reason: string): Promise<'split' | 'replan' | 'escalated' | 'failed'> => {
    const attempt = await autoBreakdown(ctx, task, breakdownEvidence(ctx, task, 'failure', { category, reason, continuations: continuation }));
    if (attempt.split) return 'split';
    if (attempt.replan) return 'replan';
    if (attempt.verdict?.action === 'stop') return 'failed';
    // A breakdown verdict of `escalate` already weighed the stronger model, so Jev is not asked again.
    if (await tryEscalate(category, reason, { skipDecision: attempt.verdict?.action === 'escalate' })) return 'escalated';
    return 'failed';
  };

  /**
   * Hand the task to the fallback provider/model, once per task. Eligible only when a fallback is
   * configured and the failure category is in `fallback.onCategories`. Resets the retry budget (the
   * fallback is a fresh route) and drops resume state (the new provider never saw the old session).
   * Returns true when the switch happened.
   */
  const switchToFallback = (c: Classified): boolean => {
    if (!fallback || onFallback || !fallbackCategories.has(c.category)) return false;
    const from = spec;
    onFallback = true;
    spec = fallback.spec;
    provider = getProvider(spec.providerName);
    resumeId = undefined;
    retryCount = 0;
    log.warn(`${task.id}: ${c.category} — ${c.message}. Switching from ${sessionLabel(from)} to fallback ${sessionLabel(spec)}${c.transient ? ` after ${fallbackAfter} transient retr${fallbackAfter === 1 ? 'y' : 'ies'}` : ''}.`);
    return true;
  };

  /**
   * Arm a transient retry for a classified infrastructure failure: give back the session's attempt,
   * record the retry, and let the caller `continue` so the outer loop backs off and resumes. Returns
   * false when the failure is not transient or the retry budget is spent, so the caller takes the
   * ordinary failure path. Shared by the session classifier and a `failed` result block that names a
   * provider/tool hiccup (a dropped MCP/plugin session) rather than a genuine task failure.
   */
  const scheduleTransientRetry = (c: Classified, summary: string, sessionId: string | undefined): boolean => {
    if (!c.transient) return false;
    // The primary has now taken `fallbackAfter` transient retries without recovering. Switch the rest
    // of this task's attempts to the fallback provider, so a flaky upstream never fails work a
    // different route could still do. Gated by category, and switched at most once per task; the
    // fallback gets its own fresh retry budget so the primary's exhaustion does not carry over.
    if (retryCount >= fallbackAfter) switchToFallback(c);
    if (retryCount >= maxAttempts) return false;
    retryCount += 1;
    // A transient infra fault (rate limit, 5xx, dropped socket) is not a task attempt: give the
    // attempt back so provider throttling cannot exhaust `halt.maxAttemptsPerTask` and halt the run.
    st.attempts = Math.max(0, st.attempts - 1);
    st.transientRetries = (st.transientRetries ?? 0) + 1;
    lastTransient = c;
    st.status = 'failed';
    st.lastError = mkError(c);
    st.summary = summary;
    st.finished = nowIso();
    saveState(paths, state);
    patchRoadmap(ctx, task.id, 'failed');
    if (!provider.supportsResume || !sessionId) resumeId = undefined;
    return true;
  };

  await slackNotify(ctx, 'taskStart', {
    title: `${task.id} started — ${task.title}`,
    lines: [
      `phase ${task.phase} · ${sessionLabel(spec)}`,
      continuation > 0 ? `resuming at continuation ${continuation}/${maxContinuations}` : st.attempts > 0 ? `attempt ${st.attempts + 1}` : '',
    ],
  }, task.id);

  attempts: for (let attempt = 1; ; attempt++) {
    if (maxIterations > 0 && iterations >= maxIterations) {
      final = { status: 'failed', summary: `stopped after maxIterationsPerTask (${maxIterations}) sessions without finishing`, lastError: { category: 'task', message: 'maxIterationsPerTask reached', transient: false, fatal: false, at: nowIso() } };
      break;
    }
    // Hard autonomy ceiling: a task that has burned its cost or wall-clock budget is parked as a scope
    // question rather than retried indefinitely. At least one session always runs (iterations > 0).
    if (iterations > 0 && (config.ceiling.maxCostUsdPerTask > 0 || config.ceiling.maxMinutesPerTask > 0)) {
      const cost = st.costUsd ?? 0;
      const firstLog = st.logs?.[0]?.started;
      const startMs = firstLog ? Date.parse(firstLog) : Date.parse(st.started ?? '');
      const minutes = Number.isFinite(startMs) ? (Date.now() - startMs) / 60_000 : 0;
      const overCost = config.ceiling.maxCostUsdPerTask > 0 && cost >= config.ceiling.maxCostUsdPerTask;
      const overTime = config.ceiling.maxMinutesPerTask > 0 && minutes >= config.ceiling.maxMinutesPerTask;
      if (overCost || overTime) {
        const reason = overCost
          ? `cost $${cost.toFixed(2)} >= ceiling.maxCostUsdPerTask ($${config.ceiling.maxCostUsdPerTask})`
          : `wall clock ${minutes.toFixed(1)}min >= ceiling.maxMinutesPerTask (${config.ceiling.maxMinutesPerTask})`;
        log.warn(`${task.id}: per-task ceiling reached (${reason}); parking as a scope question`);
        final = { status: 'blocked', summary: `parked: ${reason}`, lastError: { category: 'budget', message: reason, transient: false, fatal: false, at: nowIso() } };
        break;
      }
    }
    if (lastTransient) {
      const wait = retryDelaySec(config.retry, retryCount, lastTransient.retryAfterSec);
      log.warn(`${task.id}: ${lastTransient.category}: ${lastTransient.message}. Retry ${retryCount}/${maxAttempts} in ${wait}s ${resumeId ? `resuming session ${resumeId}` : 'with a fresh session'}.`);
      const stopped = await backoff(ctx, wait * 1000);
      if (ctx.splitRequest) { log.warn(`${task.id}: split of ${ctx.splitRequest.id} requested; not retrying.`); return { status: st.status, stopped: true }; }
      if (ctx.interrupted) { final = { status: 'failed', summary: 'interrupted during retry backoff', lastError: { category: 'interrupted', message: 'interrupted during retry backoff', transient: true, fatal: false, at: nowIso() } }; break; }
      if (stopped) { log.warn(`${task.id}: STOP present; not retrying. Remove ${paths.stop} and re-run to continue.`); return { status: st.status, stopped: true }; }
    }

    st.status = 'running';
    st.attempts += 1;
    iterations += 1;
    st.started = nowIso();
    st.provider = spec.providerName;
    st.model = spec.model;
    st.variant = spec.variant;
    delete st.finished;
    saveState(paths, state);
    patchRoadmap(ctx, task.id, 'running');
    log.info(`=== ${task.id} ${task.title} (session ${st.attempts}${retryCount > 0 ? `, retry ${retryCount}/${maxAttempts}` : ''}${continuation > 0 ? `, continuation ${continuation}/${maxContinuations}` : ''}) provider=${spec.providerName} model=${spec.model ?? 'default'} variant=${spec.variant ?? 'default'} timeout=${spec.timeoutMin}min`);

    const pc = promptCtx(ctx, task, st, spec, lastTransient ? lastTransient.message : st.lastError?.message, continuation);
    const prompt = lastTransient && resumeId
      ? buildResumePrompt(pc, lastTransient.message)
      : continuation > 0
        ? buildContinuePrompt(pc)
        : buildTaskPrompt(pc);
    const sessionKind: SessionRun['kind'] = escalating ? 'escalate' : onFallback ? 'fallback' : continuation > 0 && !lastTransient ? 'continue' : resumeId ? 'resume' : 'task';
    let outcome = await runOneSession(ctx, task, st, provider, spec, prompt, { kind: sessionKind, logKind: escalating || retryCount > 0 ? 'retry' : 'task', attempt, resumeId, timeoutMin: spec.timeoutMin });
    resumeId = outcome.sessionId ?? resumeId;
    let block: ResultBlock | undefined = parseResultBlock(outcome.result.text) ?? parseResultBlock(outcome.allText);

    // A live "pause as soon as possible" request cut the session above short. Have the agent close
    // the task out (notes + a clean build) before the run commits and pauses; the close-out's block
    // then takes the ordinary path, so `continue` commits the slice and `.stop` pauses before the
    // next one. It always yields a block, so the pause cannot be lost to a silent close-out.
    let wrapped = false;
    if (ctx.wrapUpRequest && !ctx.interrupted) {
      ctx.wrapUpRequest = false;
      wrapped = true;
      const w = await runWrapUp(ctx, task, st, provider, spec, pc, resumeId, outcome);
      outcome = w.outcome;
      resumeId = w.outcome.sessionId ?? resumeId;
      block = w.block;
    }

    const endedCleanly = outcome.result.ok && !outcome.timedOut && !outcome.stalled && !outcome.interrupted && !ctx.interrupted;
    if (!block && endedCleanly && !wrapped && config.jev.enabled && config.jev.resultFallback) {
      // Jev first: one fast, typed decision instead of a whole resumed session. Any problem below
      // (no key, timeout, low confidence, an unaccepted disposition) falls through to the nudge.
      const problem = jevProblem(config.jev, process.env);
      if (problem) {
        log.warn(`${task.id}: [jev] session ended without a SYMPHONY_RESULT block; Jev fallback unavailable (${problem})`);
      } else {
        let note = '';
        const decision = await classifySessionResult(config.jev, { taskTitle: task.title, output: outcome.allText }, { fetchImpl: ctx.fetchImpl, signal: ctx.abort.signal, note: (m) => { note = m; } });
        // Charge any answered call, even when the disposition is not accepted below.
        if (decision?.costUsd !== undefined) { st.costUsd = (st.costUsd ?? 0) + decision.costUsd; ctx.runCostUsd = (ctx.runCostUsd ?? 0) + decision.costUsd; }
        const pct = decision ? Math.round(decision.confidence * 100) : 0;
        if (decision && decision.confidence >= config.jev.minConfidence && config.jev.acceptStatuses.includes(decision.status)) {
          block = { status: decision.status, summary: `Jev classified the session as ${decision.status} (confidence ${pct}%)` };
          log.info(`${task.id}: [jev] no SYMPHONY_RESULT block; Jev classified the session as ${decision.status} (confidence ${pct}%, model ${decision.model ?? config.jev.model})`);
        } else if (decision && !config.jev.acceptStatuses.includes(decision.status)) {
          log.warn(`${task.id}: [jev] no SYMPHONY_RESULT block; Jev said ${decision.status} (${pct}%) but only ${config.jev.acceptStatuses.join('/')} are accepted`);
        } else if (decision) {
          log.warn(`${task.id}: [jev] no SYMPHONY_RESULT block; Jev's ${decision.status} was only ${pct}% confident (min ${Math.round(config.jev.minConfidence * 100)}%)`);
        } else {
          log.warn(`${task.id}: [jev] no SYMPHONY_RESULT block; Jev returned no usable decision${note ? ` (${note})` : ''}`);
        }
      }
    }

    if (!block && endedCleanly && !wrapped && outcome.sessionId && config.nudge && provider.supportsResume) {
      log.warn(`${task.id}: session ended without a SYMPHONY_RESULT block; resuming ${outcome.sessionId} once to close out`);
      const nudge = await runOneSession(ctx, task, st, provider, spec, buildNudgePrompt(pc), { kind: 'nudge', logKind: 'nudge', attempt, resumeId: outcome.sessionId, timeoutMin: Math.min(spec.timeoutMin, config.nudgeTimeoutMin) });
      st.nudged = true;
      resumeId = nudge.sessionId ?? resumeId;
      block = parseResultBlock(nudge.result.text) ?? parseResultBlock(nudge.allText);
      if (!block && !nudge.result.ok) {
        const c = await classifyOutcome(ctx, task, st, outcomeEvidence(nudge));
        if (c.fatal && c.category !== 'config') outcome = mergeOutcome(outcome, nudge);
        else log.warn(`${task.id}: nudge session failed (${c.category}: ${c.message}); judging the task on its original session`);
      } else {
        outcome = mergeOutcome(outcome, nudge);
      }
    }

    if (outcome.interrupted || ctx.interrupted) {
      const msg = `interrupted by ${ctx.signalName ?? 'the run view'}`;
      // A human stopping the run is not a task failure: give back the attempt this session consumed
      // so repeated Ctrl-C during testing cannot exhaust `halt.maxAttemptsPerTask` and halt the run.
      // The row is still recorded unfinished and retried next run.
      st.attempts = Math.max(0, st.attempts - 1);
      final = { status: 'failed', summary: msg, lastError: { category: 'interrupted', message: msg, transient: true, fatal: false, at: nowIso() } };
      break;
    }

    if (block && (outcome.result.ok || wrapped)) {
      if (block.status === 'continue') {
        st.summary = block.summary || 'continuing in a fresh session';
        saveState(paths, state);
        // Anti-thrash: compare the state this attempt left behind with the state the previous
        // attempt left behind. An exact repeat means the session reported progress it did not
        // produce; park the scope question instead of spending another whole session on it.
        const delta = computeAttemptDelta({ paths, attempt: st.attempts, taskFile: task.taskFile, verify: st.verify, metric: readMetric(ctx) });
        const stalledByMetric = metricPlateau((st.deltas ?? []).map((d) => d.metric), config.metric.direction, config.progress.stallAfterRepeats);
        if (config.progress.enabled && (isStalled((st.deltas ?? []).map((d) => d.fingerprint), delta.fingerprint, config.progress.stallAfterRepeats) || stalledByMetric)) {
          const scope = stalledByMetric
            ? `objective metric has not improved across attempts (direction ${config.metric.direction})`
            : `no measurable progress across attempts (${delta.signals.join('; ')})`;
          log.warn(`${task.id}: stalled — ${scope}; not retrying`);
          const deferred = deferrableRemainder();
          if (deferred) { final = autoAcceptSubset(deferred); break; }
          // The objective product metric is the primary signal: when it has plateaued, the decision is
          // deterministic — park/escalate the scope question — and breakdown is not consulted. LLM
          // breakdown stays the ambiguity fallback for the fingerprint-only case (no metric configured).
          if (stalledByMetric) {
            final = {
              status: 'blocked',
              summary: `stalled — ${scope}. Re-scope the task or supply the missing capability; it will not be retried as is.`,
              lastError: { category: 'stalled', message: scope, transient: false, fatal: false, at: nowIso() },
            };
            break;
          }
          const bd = await autoBreakdown(ctx, task, breakdownEvidence(ctx, task, 'failure', { category: 'stalled', reason: scope, continuations: continuation }));
          if (bd.split) return { status: st.status, split: true };
          if (bd.replan) return { status: st.status, replan: true };
          final = {
            status: 'blocked',
            summary: `stalled — ${scope}: ${block.summary || 'more work remains'}. Its acceptance is likely dependency-gated or unreachable as scoped; re-scope it or run \`symphony accept ${task.id} --note ...\` on the landed subset.`,
            lastError: { category: 'stalled', message: scope, transient: false, fatal: false, at: nowIso() },
          };
          break;
        }
        if (continuation < maxContinuations) {
          const slicesUsed = continuation;
          continuation += 1;
          st.continuation = continuation;
          refreshDerivedDocs(ctx);
          if (config.commitPerSession) commitIntermediate(ctx, task, st);
          recordAttemptDelta(ctx, task, st);
          saveState(paths, state);
          await slackNotify(ctx, 'taskContinue', {
            title: `${task.id} continuing — ${task.title}`,
            lines: [`slice ${continuation}/${maxContinuations} · ${sessionLabel(spec)}`, block.summary || 'more work remains'],
          }, task.id);
          // A split requested mid-slice stops here too: the slice above is committed, so the parent's
          // task can be rewritten into subtasks and the run resumed on them.
          if (ctx.splitRequest) {
            st.summary = `${block.summary || 'more work remains'} | paused for a split of ${ctx.splitRequest.id}`;
            saveState(paths, state);
            log.warn(`${ctx.splitRequest.id}: split requested; pausing before continuation ${continuation}/${maxContinuations}.`);
            return { status: st.status, stopped: true };
          }
          // `.stop` is honoured at the subtask boundary too: once this slice is committed, pause
          // before starting the next continuation. The counter above is persisted so the next run
          // resumes at the right slice instead of restarting the task from scratch.
          if (stopPresent(paths)) {
            st.summary = `${block.summary || 'more work remains'} | paused at continuation ${continuation}/${maxContinuations}: ${relative(paths.root, paths.stop)} present`;
            saveState(paths, state);
            log.warn(`${task.id}: ${relative(paths.root, paths.stop)} present: pausing before continuation ${continuation}/${maxContinuations}. Remove it and re-run to continue.`);
            return { status: st.status, stopped: true };
          }
          // The preferred alternative to yet another slice: ask whether the task should be broken
          // down (or the whole upcoming plan rewritten) now. The slice above is committed, so a
          // split's or replan's commit stays docs-only.
          const bd = await autoBreakdown(ctx, task, breakdownEvidence(ctx, task, 'continue', { reason: block.summary, continuations: slicesUsed }));
          if (bd.split) return { status: st.status, split: true };
          if (bd.replan) return { status: st.status, replan: true };
          log.info(`${task.id}: session reported continue (${continuation}/${maxContinuations}); starting a fresh session for the next slice`);
          resumeId = undefined;
          lastTransient = undefined;
          continue;
        }
        const contSummary = `${block.summary || 'more work remains'} | gave up after ${maxContinuations} continuation sessions (maxContinuations)`;
        const rec = await recover('task', `continuation limit (${maxContinuations}) reached`);
        if (rec === 'split') return { status: st.status, split: true };
        if (rec === 'replan') return { status: st.status, replan: true };
        if (rec === 'escalated') continue;
        final = { status: 'failed', summary: contSummary, lastError: { category: 'task', message: 'continuation limit reached', transient: false, fatal: false, at: nowIso() } };
        break;
      }
      if (block.status === 'done') {
        const verify = resolveVerify(config, task, paths.root);
        if (verify) {
          log.info(`${task.id}: running verify: ${verify.command}`);
          let res = runVerify(paths.root, verify.command, verify.timeoutMin * 60_000);
          const recordVerify = () => {
            st.verify = { command: verify.command, ok: res.ok, code: res.code ?? undefined, output: res.output.slice(-2000) || undefined, at: nowIso() };
          };
          recordVerify();
          // A verify can die on a transient transport fault — a dropped MCP/plugin/tool session, a
          // reset connection — which says nothing about the task. Retry those with the same
          // exponential backoff as a session, without consuming the task's attempt budget, before
          // treating a `done` as failed. Only `network` faults retry here: verify output is the
          // project's own test text, so a stray "500" or "rate limit" in it must not look transient.
          while (!res.ok) {
            const c = classifyVerifyOutput(res, config.halt.onCategories);
            if (c.category !== 'network' || retryCount >= maxAttempts) break;
            retryCount += 1;
            st.transientRetries = (st.transientRetries ?? 0) + 1;
            const wait = retryDelaySec(config.retry, retryCount, c.retryAfterSec);
            log.warn(`${task.id}: verify ${c.category}: ${c.message}. Retry ${retryCount}/${maxAttempts} in ${wait}s.`);
            saveState(paths, state);
            const stopped = await backoff(ctx, wait * 1000);
            if (ctx.splitRequest) { log.warn(`${task.id}: split of ${ctx.splitRequest.id} requested; not retrying verify.`); return { status: st.status, stopped: true }; }
            if (ctx.interrupted) {
              st.attempts = Math.max(0, st.attempts - 1);
              final = { status: 'failed', summary: `interrupted by ${ctx.signalName ?? 'the run view'} during a verify retry`, lastError: { category: 'interrupted', message: 'interrupted during a verify retry', transient: true, fatal: false, at: nowIso() } };
              break attempts;
            }
            if (stopped) { log.warn(`${task.id}: STOP present; not retrying verify. Remove ${paths.stop} and re-run to continue.`); return { status: st.status, stopped: true }; }
            log.info(`${task.id}: re-running verify: ${verify.command}`);
            res = runVerify(paths.root, verify.command, verify.timeoutMin * 60_000);
            recordVerify();
          }
          if (!res.ok) {
            const msg = `verify failed (exit ${res.code ?? 'timeout'}): ${verify.command} — ${squash(res.output, 240) || 'no output'}`;
            log.error(`${task.id}: ${msg}`);
            const rec = await recover('verify', msg);
            if (rec === 'split') return { status: st.status, split: true };
            if (rec === 'escalated') continue;
            final = { status: 'failed', summary: msg, lastError: { category: 'verify', message: msg, transient: false, fatal: false, at: nowIso() } };
            break;
          }
          log.info(`${task.id}: verify passed`);
        }
        // Independent completion judge: after the mechanical verify (if any) passes, a separate
        // read-only session checks the task's own intent against what actually landed. Only a
        // confident failing verdict enforces; a weak verdict, or one that reports no confidence at
        // all, is advisory — the done stands and the verdict is recorded for the log.
        if (config.judge.enabled) {
          const verdict = await runCompletionJudge(ctx, task, st, block.summary);
          if (verdict && verdict.verdict === 'fail') {
            const pct = verdict.confidence !== undefined ? ` (${Math.round(verdict.confidence * 100)}%)` : '';
            const msg = `judge rejected the completion${pct}: ${verdict.summary}${verdict.gaps ? ` — gaps: ${verdict.gaps}` : ''}`;
            // `enforce` is decided by runCompletionJudge, after any `judge.jev` cross-check.
            if (verdict.enforce) {
              st.judge!.enforced = true;
              // Mark the judge verdict row that triggered this rerun, so the TUI and ROADMAP.md both
              // show the rejection that sent the task back through recovery. The Jev cross-check row
              // (provider `jev`) is skipped — it already records whether it confirmed or declined.
              const lastJudgeLog = [...st.logs].reverse().find((l) => l.kind === 'judge' && l.provider !== 'jev');
              if (lastJudgeLog && !/enforced/.test(lastJudgeLog.status ?? '')) {
                lastJudgeLog.status = `${lastJudgeLog.status ?? verdict.verdict} enforced`;
              }
              saveState(paths, state);
              updatePipelineStatus(paths, ctx.tasks, state, log);
              log.error(`${task.id}: ${msg}`);
              const rec = await recover('judge', msg);
              if (rec === 'split') return { status: st.status, split: true };
              if (rec === 'replan') return { status: st.status, replan: true };
              if (rec === 'escalated') continue;
              final = { status: 'failed', summary: msg, lastError: { category: 'judge', message: msg, transient: false, fatal: false, at: nowIso() } };
              break;
            }
            const uncertain = verdict.jev && !verdict.jev.agreed
              ? `Jev cross-check ${verdict.jev.verdict === 'pass' ? 'passed' : 'declined to enforce'}`
              : verdict.confidence === undefined ? 'no confidence reported' : `below judge.minConfidence ${config.judge.minConfidence}`;
            log.warn(`${task.id}: ${msg} (${uncertain}); accepting the done`);
          }
        }
      }
      if (block.status === 'failed') {
        // A session can report `failed` because the provider or a tool hiccuped — a dropped
        // MCP/plugin session, a reset connection — rather than because the task is wrong. Run the
        // deterministic classifier over what it said: a genuine task failure stays terminal, but a
        // recognised infrastructure fault backs off and retries (resuming the session) instead of
        // burning the task or escalating it to a stronger model.
        const c = classifyFailure(
          { ...outcomeEvidence(outcome), resultOk: false, resultText: block.summary ?? '', errorTexts: outcome.hints.errorTexts },
          config.halt.onCategories,
        );
        const summary = block.summary ? `${block.summary} | ${c.category}: ${c.message}` : `${c.category}: ${c.message}`;
        if (scheduleTransientRetry(c, summary, outcome.sessionId)) continue;
        const rec = await recover('task', block.summary || 'model reported failed');
        if (rec === 'split') return { status: st.status, split: true };
        if (rec === 'replan') return { status: st.status, replan: true };
        if (rec === 'escalated') continue;
      }
      if (block.status === 'blocked') {
        // A blocked report often means the task bundled automatable work with an item that needs a
        // human. Before the run stops for that human, accept the landed green subset when every
        // remaining acceptance item is deferrable; otherwise the `onBlocked` stage may split the task
        // or rewrite the upcoming plan so the automatable parts land now and the human gets a smaller,
        // clear block. A `proceed` verdict (or a rewrite that cannot complete) falls through to the
        // ordinary blocked path.
        const deferred = deferrableRemainder();
        if (deferred) { final = autoAcceptSubset(deferred); break; }
        const bd = await autoBreakdown(ctx, task, breakdownEvidence(ctx, task, 'blocked', { reason: block.summary, status: 'blocked' }));
        if (bd.split) return { status: st.status, split: true };
        if (bd.replan) return { status: st.status, replan: true };
      }
      final = { status: block.status, summary: block.summary || block.status };
      if (block.status !== 'done') final.lastError = { category: 'task', message: block.summary || `model reported ${block.status}`, transient: false, fatal: false, at: nowIso() };
      break;
    }

    const classified = await classifyOutcome(ctx, task, st, outcomeEvidence(outcome));
    const summary = block ? `${block.summary} | ${classified.category}: ${classified.message}` : `${classified.category}: ${classified.message}`;
    const lastError = mkError(classified);
    if (classified.fatal) {
      // A fatal category the user listed for fallback (e.g. a model that went unavailable) still gets
      // one fresh session on the fallback route instead of halting the run.
      if (switchToFallback(classified)) continue;
      final = { status: 'failed', summary, lastError };
      halt = { at: nowIso(), taskId: task.id, category: classified.category, reason: classified.message };
      break;
    }
    if (scheduleTransientRetry(classified, summary, outcome.sessionId)) continue;
    const rec = await recover(classified.category, summary);
    if (rec === 'split') return { status: st.status, split: true };
    if (rec === 'replan') return { status: st.status, replan: true };
    if (rec === 'escalated') continue;
    final = { status: 'failed', summary: classified.transient ? `${summary} (gave up after ${retryCount} retries)` : summary, lastError };
    break;
  }

  await finalizeTask(ctx, task, st, final ?? { status: 'failed', summary: 'no attempt ran' }, halt);
  // A session stopped by the run view (TUI quit/split) marks the outcome interrupted without
  // necessarily setting ctx.interrupted; report that too, so the run loop never counts a manual stop
  // as a failure against halt.maxConsecutiveFailures.
  return { status: final?.status ?? 'failed', halt, interrupted: ctx.interrupted || final?.lastError?.category === 'interrupted' };
}

function selectTasks(ctx: RunContext): Task[] {
  const { tasks, flags } = ctx;
  const idx = (raw: string, flag: string): number => {
    const id = canonicalId(raw);
    const i = id ? tasks.findIndex((t) => t.id === id) : -1;
    if (i === -1) throw new UsageError(`${flag} ${raw}: no such task in ROADMAP.md`);
    return i;
  };
  let selected = tasks;
  if (flags.from) selected = selected.filter((t) => t.order >= idx(flags.from!, '--from'));
  if (flags.to) selected = selected.filter((t) => t.order <= idx(flags.to!, '--to'));
  if (flags.only?.length) {
    const ids = new Set(flags.only.map((o) => tasks[idx(o, '--only')].id));
    selected = selected.filter((t) => ids.has(t.id));
  }
  return selected;
}

export function haltBanner(ctx: RunContext, h: Halted): void {
  ctx.log.banner('HALTED — symphony will not run more tasks', [
    `${h.taskId ? `${h.taskId} · ` : ''}${h.category}: ${h.reason}`,
    `at ${h.at}`,
    haltResumeHint(h),
  ]);
}

async function setHalt(ctx: RunContext, h: Halted): Promise<number> {
  ctx.state.halted = h;
  saveState(ctx.paths, ctx.state);
  updatePipelineStatus(ctx.paths, ctx.tasks, ctx.state, ctx.log);
  haltBanner(ctx, h);
  fireHook(ctx.config, 'onHalt', {
    SYMPHONY_ROOT: ctx.paths.root,
    SYMPHONY_TASK: h.taskId ?? '',
    SYMPHONY_HALT_CATEGORY: h.category,
    SYMPHONY_HALT_REASON: h.reason,
  }, (m) => ctx.log.warn(m));
  await slackNotify(ctx, 'halt', {
    title: `Halted${h.taskId ? ` on ${h.taskId}` : ''} — ${h.category}`,
    lines: [h.reason, haltResumeHint(h)],
  });
  return 3;
}

export function preflight(ctx: RunContext, spec: SessionSpec | undefined, provider: Provider | undefined, opts: { ignoreHalt?: boolean; skipAuth?: boolean; skipRoadmap?: boolean; extraProviders?: ExtraProvider[] } = {}): boolean {
  const checks = runDoctor({ paths: ctx.paths, config: ctx.config, state: ctx.state, spec, provider, extraProviders: opts.extraProviders, taskCount: ctx.tasks.length, ignoreHalt: opts.ignoreHalt, skipAuth: opts.skipAuth, skipRoadmap: opts.skipRoadmap });
  for (const line of formatChecks(checks)) ctx.log.plain(line);
  return !checks.some((c) => c.level === 'fail');
}

/**
 * Crash-only recovery, run before the queue is even selected. A kill (SIGTERM, SIGKILL, OOM, host
 * restart) can leave a task row "running" and a lock behind. This turns every such row into a
 * resumable one without a human editing state.json: the unfinished session's attempt is given back
 * (exactly like a manual stop, so repeated crashes cannot exhaust `halt.maxAttemptsPerTask`) and the
 * stale `⟵ running` ROADMAP marker is repaired. A *live* pid is left alone; so is a live lock (that
 * would be a concurrent run, which `acquireLock` will reject). No-op under `--dry-run`.
 */
function recoverStaleRuns(ctx: RunContext): void {
  const { paths, state, flags, log } = ctx;
  if (flags.dryRun) return;
  const live = liveLock(paths);
  if (live) return; // a concurrent run owns these rows; acquireLock will report it later
  const lock = readLock(paths);
  if (lock && lock.pid !== process.pid && !pidAlive(lock.pid)) {
    try {
      unlinkSync(paths.lock);
      log.warn(`removed a stale lock left by pid ${lock.pid} (no longer running)`);
    } catch { /* already gone */ }
  }
  for (const task of ctx.tasks) {
    const st = state.tasks[task.id];
    if (!st || st.status !== 'running') continue;
    if (st.pid !== undefined && st.pid !== process.pid && pidAlive(st.pid)) {
      log.warn(`${task.id}: state says "running" and pid ${st.pid} is still alive; leaving it alone`);
      continue;
    }
    if ((st.attempts ?? 0) > 0) st.attempts -= 1;
    st.status = 'failed';
    st.summary = 'recovered after an unclean stop (crashed, killed or host restart); the unfinished session does not count as an attempt and the task will be retried';
    st.lastError = { category: 'interrupted', message: 'harness stopped mid-session', transient: true, fatal: false, at: nowIso() };
    delete st.pid;
    delete st.started;
    saveState(paths, state);
    patchRoadmap(ctx, task.id, 'failed');
    log.warn(`${task.id}: was left "running" by an unclean stop; recovered automatically and will be retried`);
  }
}

/** Read every task's raw body and build its contract + the dependency graph. */
function loadContracts(ctx: RunContext): Map<string, TaskContract> {
  const bodies = new Map<string, string | undefined>();
  const metas = new Map<string, Record<string, string>>();
  for (const t of ctx.tasks) {
    if (t.taskFile && existsSync(t.taskFile)) {
      try {
        const parsed = parseFrontMatter(readFileSync(t.taskFile, 'utf8'));
        // The file on disk wins over the cached meta, so an edge added since discovery is honoured.
        metas.set(t.id, { ...t.meta, ...parsed.meta });
        bodies.set(t.id, parsed.body);
      } catch {
        metas.set(t.id, t.meta);
        bodies.set(t.id, undefined);
      }
    } else {
      metas.set(t.id, t.meta);
      bodies.set(t.id, undefined);
    }
  }
  const merged = ctx.tasks.map((t) => ({ ...t, meta: metas.get(t.id) ?? t.meta }));
  return contractsFor(merged, bodies);
}

/** The run's contracts, parsed once and cached on the context. */
function contractsOf(ctx: RunContext): Map<string, TaskContract> {
  return ctx.contracts ?? (ctx.contracts = loadContracts(ctx));
}

export async function runCommand(ctx: RunContext): Promise<number> {
  const { paths, config, flags, log, state } = ctx;

  recoverStaleRuns(ctx);
  // Validate the dependency graph once, before selection: a cycle or an unknown edge is a planning
  // problem the operator should see, but it must not crash the run.
  const contracts = contractsOf(ctx);
  for (const issue of validateContracts(ctx.tasks, contracts)) log.warn(`${issue.taskId}: ${issue.message} (dependency)`);

  if (state.halted) {
    if (flags.clearHalt) {
      log.warn(`clearing halt from ${state.halted.at} (${state.halted.category}: ${state.halted.reason})`);
      delete state.halted;
      saveState(paths, state);
    } else if (flags.dryRun) {
      log.warn(`still halted (${state.halted.category}: ${state.halted.reason}); --dry-run shows what would run after \`symphony clear-halt\``);
    } else {
      haltBanner(ctx, state.halted);
      return 3;
    }
  }

  if (stopPresent(paths) && !flags.dryRun) {
    log.warn(`${relative(paths.root, paths.stop)} present: paused. Remove it and re-run to continue.`);
    return 0;
  }

  let selected = selectTasks(ctx);
  // Dependency closure: a selected task pulls in its still-pending prerequisites, so `--only T05`
  // cannot run consumer work before the `dependsOn` tickets it names. Then a topological order puts
  // every prerequisite before its consumers (otherwise the incoming order is preserved).
  const wanted = new Set(selected.map((t) => t.id));
  const closure = dependencyClosure([...wanted], contracts);
  const prereqs = ctx.tasks.filter((t) => {
    const s = state.tasks[t.id]?.status ?? 'pending';
    return closure.has(t.id) && !wanted.has(t.id) && !DONE_STATES.includes(s) && !SKIP_STATES.includes(s);
  });
  if (prereqs.length) {
    log.warn(`dependency closure: running prerequisite${prereqs.length === 1 ? '' : 's'} ${prereqs.map((t) => t.id).join(', ')} before their consumers`);
    selected = [...selected, ...prereqs];
  }
  selected = topoOrder(selected, contracts);
  let todo = selected.filter((t) => flags.retry || !SKIP_STATES.includes(state.tasks[t.id]?.status ?? 'pending'));
  const carried = selected.filter((t) => !flags.retry && state.tasks[t.id]?.status === 'blocked');
  const leftRunning = todo.filter((t) => state.tasks[t.id]?.status === 'running');

  const first = todo[0];
  const { spec, warnings } = resolveSession(config, first, ctx.cli, process.env, (p) => getProvider(p).supportsBudget, variantSupported);
  warnings.forEach((w) => log.warn(w));
  const provider = getProvider(spec.providerName);
  // Tasks may override the provider in front matter: preflight every provider this run will use.
  const extraProviders: ExtraProvider[] = [];
  const seenProviders = new Set([spec.providerName]);
  for (const t of todo) {
    const rs = resolveSession(config, t, ctx.cli, process.env, (p) => getProvider(p).supportsBudget, variantSupported);
    if (seenProviders.has(rs.spec.providerName)) continue;
    seenProviders.add(rs.spec.providerName);
    rs.warnings.forEach((w) => log.warn(`${t.id}: ${w}`));
    extraProviders.push({ spec: rs.spec, provider: getProvider(rs.spec.providerName), label: t.id });
  }
  // The escalation target only launches when a task fails, but its provider still has to pass
  // preflight now: discovering a missing binary mid-run is exactly what preflight exists to avoid.
  const escPreflight = resolveEscalation(config, spec, (p) => getProvider(p).supportsBudget, variantSupported);
  escPreflight?.warnings.forEach((w) => log.warn(w));
  if (escPreflight && !seenProviders.has(escPreflight.spec.providerName)) {
    extraProviders.push({ spec: escPreflight.spec, provider: getProvider(escPreflight.spec.providerName), label: 'escalation' });
  }
  // Likewise the fallback target, which only launches after repeated transient faults.
  const fbPreflight = resolveFallback(config, spec, (p) => getProvider(p).supportsBudget, variantSupported);
  fbPreflight?.warnings.forEach((w) => log.warn(w));
  if (fbPreflight && !seenProviders.has(fbPreflight.spec.providerName)) {
    extraProviders.push({ spec: fbPreflight.spec, provider: getProvider(fbPreflight.spec.providerName), label: 'fallback' });
  }
  // And the judge, which launches after every `done` when enabled.
  if (config.judge.enabled) {
    const judgePreflight = resolveJudge(config, variantSupported);
    judgePreflight.warnings.forEach((w) => log.warn(`judge: ${w}`));
    if (!seenProviders.has(judgePreflight.spec.providerName)) {
      seenProviders.add(judgePreflight.spec.providerName);
      extraProviders.push({ spec: judgePreflight.spec, provider: getProvider(judgePreflight.spec.providerName), label: 'judge' });
    }
  }
  if (!preflight(ctx, spec, provider, { skipAuth: flags.dryRun, ignoreHalt: flags.dryRun, extraProviders })) {
    log.error('preflight failed; fix the ✗ items above (or run: symphony doctor)');
    return 4;
  }

  log.info(`${selected.length} task${selected.length === 1 ? '' : 's'} selected, ${todo.length} to run: ${todo.map((t) => t.id).join(' ') || '-'}`);
  if (carried.length) log.warn(`carrying forward blocked (human items in their Hand-off, not re-run): ${carried.map((t) => t.id).join(' ')} — \`symphony accept T..\` to sign off, \`symphony run --retry --only T..\` to redo`);
  for (const t of leftRunning) {
    const st = state.tasks[t.id]!;
    const cont = st.continuation;
    if (cont) {
      log.warn(`${t.id} was paused at continuation ${cont} (${relative(paths.root, paths.stop)} was present); it will resume with the next slice`);
      continue;
    }
    // A session stopped mid-flight (TUI quit, terminal closed, SIGKILL, a crash) produced no result:
    // it says nothing about the task, so it must not feed the rule-based failure gates
    // (`halt.maxAttemptsPerTask`, `breakdown.rules.afterFailedAttempts`). Give its attempt back and
    // note it, so an attended stop can never halt a later unattended run.
    if (!flags.dryRun && st.attempts > 0) {
      st.attempts -= 1;
      st.summary = 'interrupted mid-session (previous run stopped); the unfinished session is not counted as an attempt';
      saveState(paths, state);
      log.warn(`${t.id} was left "running" (previous harness stopped or crashed); it will be retried and its unfinished session does not count as an attempt`);
    } else {
      log.warn(`${t.id} was left "running" (previous harness crashed or was killed); it will be retried`);
    }
    delete st.pid;
  }

  if (flags.dryRun) {
    if (!todo.length) { log.info('nothing to run'); return 0; }
    const capNote = config.maxTasksPerRun > 0 && todo.length > config.maxTasksPerRun ? ` (capped to ${config.maxTasksPerRun} by maxTasksPerRun)` : '';
    log.plain(`\n${todo.length} task${todo.length === 1 ? '' : 's'} would run${capNote}: ${todo.map((t) => t.id).join(' ')}`);
    // Build a fresh repo map in memory so the preview matches what a real run would send.
    const previewIndex = config.repoMap ? generateIndex(paths) : undefined;
    for (const t of todo) {
      const rs = resolveSession(config, t, ctx.cli, process.env, (p) => getProvider(p).supportsBudget, variantSupported);
      const tProvider = getProvider(rs.spec.providerName);
      const st = state.tasks[t.id] ?? newTaskState(t.title);
      const prompt = buildTaskPrompt(promptCtx(ctx, t, { ...st, attempts: st.attempts + 1 }, rs.spec, st.lastError?.message, 0, previewIndex));
      const mcp = planMcp(config, 'task', t, ctx.cli, rs.spec.providerName, join(paths.runs, `${t.id}-dry-run`), (m) => log.warn(`${t.id}: mcp: ${m}`));
      mcp?.notes.forEach((n) => log.warn(`${t.id}: mcp: ${n}`));
      const cmd = tProvider.buildCommand({ bin: rs.spec.bin, prompt, promptFile: `${paths.runs}/${t.id}-<stamp>.prompt.md`, taskId: t.id, attempt: st.attempts + 1, kind: 'task', model: rs.spec.model, variant: rs.spec.variant, autoApprove: rs.spec.autoApprove, budgetUsd: rs.spec.budgetUsd, extraArgs: [...rs.spec.extraArgs, ...(mcp?.args ?? [])], cwd: paths.root });
      if (mcp?.env) cmd.env = { ...(cmd.env ?? {}), ...mcp.env };
      log.plain(`\n=== ${t.id} — ${t.title}`);
      log.plain(`provider: ${rs.spec.providerName} [${rs.spec.sources.provider}] · model: ${rs.spec.model ?? 'provider default'} [${rs.spec.sources.model}]${rs.spec.variant ? ` · variant: ${rs.spec.variant} [${rs.spec.sources.variant}]` : ''} · timeout ${rs.spec.timeoutMin} min · idle ${rs.spec.idleTimeoutMin} min · auto-approve ${rs.spec.autoApprove}`);
      if (mcp) log.plain(mcp.label);
      const esc = resolveEscalation(config, rs.spec, (p) => getProvider(p).supportsBudget, variantSupported);
      if (esc) log.plain(`escalation: ${esc.spec.providerName} · ${esc.spec.model}${esc.spec.variant ? ` · variant ${esc.spec.variant}` : ''} if the task fails (${config.escalation.onCategories.join(', ')}; max ${config.escalation.maxAttempts} session${config.escalation.maxAttempts === 1 ? '' : 's'})`);
      const bd = config.breakdown;
      if (bd.enabled) {
        const stages = [bd.onStart && 'start', bd.onContinue && 'continue', bd.onFailure && 'failure', bd.onBlocked && 'blocked'].filter(Boolean).join(', ') || '(no stage on)';
        const fallback = bd.decision === 'rules' ? '' : ` → ${bd.provider ?? config.watch.provider}${(bd.model || config.watch.model) ? ` · ${bd.model || config.watch.model}` : ''}`;
        log.plain(`breakdown: ${stages} · decision ${bd.decision}${fallback} → rules at continuation ${bd.rules.afterContinuations} / attempt ${bd.rules.afterFailedAttempts} (${bd.rules.onCategories.join(', ')})`);
      }
      if (config.judge.enabled) {
        const jp = resolveJudge(config, variantSupported);
        log.plain(`judge: ${jp.spec.providerName}${jp.spec.model ? ` · ${jp.spec.model}` : ''} checks every done (onFail ${config.judge.onFail}, min confidence ${config.judge.minConfidence}, max ${config.judge.maxPerTask || '∞'} per done)`);
      }
      log.plain(`command: ${describeCmd(cmd)}`);
      log.plain(`--- prompt for ${t.id} (${Buffer.byteLength(prompt, 'utf8')} bytes) ---\n${prompt}--- end prompt ---`);
    }
    return 0;
  }

  if (todo.length === 0) {
    const done = ctx.tasks.filter((t) => DONE_STATES.includes(state.tasks[t.id]?.status ?? 'pending')).length;
    log.info(`nothing to run: ${done}/${ctx.tasks.length} done${carried.length ? `, ${carried.length} blocked awaiting a human` : ''}`);
    return 0;
  }

  // Jev enabled with no usable key is a fatal misconfiguration: halt instead of running with the
  // decision workflows silently disabled. Checked after the dry-run/no-op exits so a preview or an
  // empty run does not leave a sticky halt behind.
  const jevHalt = jevMisconfigHalt(config);
  if (jevHalt) return setHalt(ctx, jevHalt);

  if (config.maxTasksPerRun > 0 && todo.length > config.maxTasksPerRun) {
    log.info(`maxTasksPerRun=${config.maxTasksPerRun}: running the first ${config.maxTasksPerRun} of ${todo.length} selected task(s); the rest stay for a later run`);
    todo = todo.slice(0, config.maxTasksPerRun);
  }

  const runCost = (): number => ctx.runCostUsd ?? 0;
  // Automatic breakdowns attempted per task id this run: a task that keeps failing should not be
  // split again and again. (A successful split consumes the parent, so this mostly bounds failures.)
  ctx.autoSplits ??= new Map();
  // The run budget is opt-in (`maxCostUsdPerRun > 0`). `budgetClose` fires once when reported spend
  // first reaches BUDGET_CLOSE_FRACTION of the cap; `budgetExceeded` fires at the cap and the run
  // halts. Both are additionally gated by `slackEventEnabled` inside notifySlack.
  let budgetCloseSent = false;
  const budgetHalt = async (): Promise<number | undefined> => {
    if (config.maxCostUsdPerRun <= 0) return undefined;
    const cost = runCost();
    if (cost >= config.maxCostUsdPerRun) {
      await slackNotify(ctx, 'budgetExceeded', {
        title: `Run budget exceeded — $${cost.toFixed(2)} of $${config.maxCostUsdPerRun.toFixed(2)}`,
        lines: [`sessions reported $${cost.toFixed(2)} during this run; halting`],
      });
      return setHalt(ctx, {
        at: nowIso(), category: 'budget',
        reason: `sessions reported $${cost.toFixed(2)} during this run (maxCostUsdPerRun = $${config.maxCostUsdPerRun.toFixed(2)}); raise the cap or \`symphony clear-halt\` to continue`,
      });
    }
    if (!budgetCloseSent && cost >= config.maxCostUsdPerRun * BUDGET_CLOSE_FRACTION) {
      budgetCloseSent = true;
      await slackNotify(ctx, 'budgetClose', {
        title: `Run budget close — $${cost.toFixed(2)} of $${config.maxCostUsdPerRun.toFixed(2)}`,
        lines: [`${Math.round(BUDGET_CLOSE_FRACTION * 100)}% of maxCostUsdPerRun reached; the run halts at the cap`],
      });
    }
    return undefined;
  };

  const runLoop = async (): Promise<number> => {
    let consecutiveFailures = 0;
    const attempted = new Set<string>();
    // Tasks postponed because a prerequisite is still queued later; a cycle guard bounds the re-queue.
    const postponed = new Map<string, number>();
    // The queue is re-selected from the live task list whenever a breakdown rewrites the plan.
    let queue: Task[] = todo.slice();
    const rebuild = (): void => {
      const selected = selectTasks(ctx).filter((t) => !attempted.has(t.id) && (flags.retry || !SKIP_STATES.includes(state.tasks[t.id]?.status ?? 'pending')));
      // Prerequisites before consumers, even after a breakdown rewrote the plan.
      const ordered = topoOrder(selected, contracts);
      // `maxTasksPerRun` counts tasks this invocation has *started*, so a breakdown cannot buy more.
      const room = config.maxTasksPerRun > 0 ? Math.max(0, config.maxTasksPerRun - attempted.size) : ordered.length;
      queue = ordered.slice(0, room);
    };
    const afterRewrite = (): void => {
      reloadAfterRewrite(ctx);
      // A replan may have removed tasks named by --from/--to/--only; drop the stale ids rather than
      // letting selectTasks throw mid-run.
      sanitizeFlags(ctx.flags, ctx.tasks, (m) => log.warn(`replan: ${m}`));
      if (ctx.pauseAt && !ctx.tasks.some((t) => t.id === ctx.pauseAt)) delete ctx.pauseAt;
      consecutiveFailures = 0;
      rebuild();
    };
    while (queue.length) {
      const task = queue.shift()!;
      if (ctx.interrupted) return ctx.signalName === 'SIGTERM' ? 143 : 130;
      // A split requested from the run view: stop here so the wrapper can rewrite the task into
      // subtasks and resume. Checked before the STOP sentinel because it is an explicit user action.
      if (ctx.splitRequest) {
        log.warn(`${ctx.splitRequest.id}: split requested; pausing before ${task.id} to rewrite it into subtasks.`);
        return 0;
      }
      if (stopPresent(paths)) {
        log.warn(`${relative(paths.root, paths.stop)} present: pausing before ${task.id}. Remove it and re-run to continue.`);
        return 0;
      }
      // A pause-now request that arrived with no session in flight (between tasks): there is nothing
      // to close out, so pause here. The handler places the sentinel when no session is active, but
      // consume the flag anyway so it cannot wrap up an unrelated task later.
      if (ctx.wrapUpRequest) {
        ctx.wrapUpRequest = false;
        log.warn(`${task.id}: pause-now requested with no session in flight; pausing before ${task.id}.`);
        return 0;
      }
      // A queued pause target: the run has reached the task the user chose to stop before, so the
      // sentinel is placed now (rather than at the next boundary) and the pipeline pauses here.
      if (ctx.pauseAt === task.id) {
        delete ctx.pauseAt;
        try {
          placeStop(paths);
          log.warn(`${task.id}: pause target reached; placed ${relative(paths.root, paths.stop)}. Remove it and re-run to continue.`);
        } catch (e) {
          log.warn(`${task.id}: pause target reached but could not place ${relative(paths.root, paths.stop)} (${(e as Error).message}); stopping anyway.`);
        }
        return 0;
      }
      const spend = await budgetHalt();
      if (spend !== undefined) return spend;
      const st = state.tasks[task.id];
      if (st && st.status === 'failed' && st.attempts >= config.halt.maxAttemptsPerTask && !flags.retry) {
        return setHalt(ctx, { at: nowIso(), taskId: task.id, category: 'attempts', reason: `${task.id} has failed ${st.attempts} times (halt.maxAttemptsPerTask = ${config.halt.maxAttemptsPerTask}); last: ${st.lastError?.message ?? st.summary ?? '?'}. Fix the cause, then \`symphony run --clear-halt --retry --only ${task.id}\`` });
      }

      // Before the task starts: the preferred moment to notice it is too big, or that the plan
      // around it is wrong. A successful split or replan rewrites the plan, so the queue is
      // re-selected and this task never runs as it was. A fault while assembling the evidence (for
      // example the task file vanished under a rewrite) must not kill the whole run: fall through and
      // let the ordinary task path handle it.
      let bd: AutoBreakdown;
      try {
        bd = await autoBreakdown(ctx, task, breakdownEvidence(ctx, task, 'start'));
      } catch (e) {
        ctx.log.warn(`${task.id}: start breakdown check failed (${(e as Error).message}); running the task as it is`);
        bd = { split: false, replan: false };
      }
      if (bd.split || bd.replan) {
        afterRewrite();
        continue;
      }

      attempted.add(task.id);
      // Dependency suspension: never run consumer work before its prerequisites. If one is still
      // queued later, postpone this task; if it has failed or is blocked, park this task as
      // blocked-by-dependency without spending a session on it.
      const unmet = (contracts.get(task.id)?.dependsOn ?? []).filter((dep) => !DONE_STATES.includes(state.tasks[dep]?.status ?? 'pending'));
      let out: TaskOutcome;
      if (unmet.length) {
        const laterQueued = queue.some((q) => unmet.includes(q.id));
        const count = (postponed.get(task.id) ?? 0) + 1;
        postponed.set(task.id, count);
        if (laterQueued && count <= ctx.tasks.length) {
          log.warn(`${task.id}: waiting on prerequisite${unmet.length === 1 ? '' : 's'} ${unmet.join(', ')}; postponing it`);
          queue.push(task);
          continue;
        }
        const st = (state.tasks[task.id] ??= newTaskState(task.title));
        st.status = 'blocked';
        st.blockedBy = unmet;
        st.summary = `blocked by unmet prerequisite${unmet.length === 1 ? '' : 's'}: ${unmet.join(', ')}`;
        st.finished = nowIso();
        saveState(paths, state);
        patchRoadmap(ctx, task.id, 'blocked');
        log.warn(`${task.id}: blocked by ${unmet.join(', ')}; not running it`);
        out = { status: 'blocked' };
      } else {
        try {
          out = await runTask(ctx, task);
        } catch (e) {
          // A fault outside a session (state I/O, a doc write, a git helper) must not kill the whole
          // run: record the task failed and let the ordinary failure policy decide whether to stop.
          const message = `internal error: ${e instanceof Error ? e.message : String(e)}`;
          ctx.log.error(`${task.id}: ${message}`);
          const st = (state.tasks[task.id] ??= newTaskState(task.title));
          st.status = 'failed';
          st.summary = message;
          st.finished = nowIso();
          st.lastError = { category: 'crash', message, transient: false, fatal: false, at: nowIso() };
          delete st.pid;
          saveState(paths, state);
          patchRoadmap(ctx, task.id, 'failed');
          out = { status: 'failed' };
        }
      }
      if (out.split || out.replan) { afterRewrite(); continue; }
      if (out.stopped) return 0;
      if (out.halt) return setHalt(ctx, out.halt);
      if (out.interrupted) return ctx.signalName === 'SIGTERM' ? 143 : 130;
      const overBudget = await budgetHalt();
      if (overBudget !== undefined) return overBudget;

      if (out.status === 'done') { consecutiveFailures = 0; continue; }
      if (out.status === 'blocked') {
        fireHook(config, 'onBlocked', {
          SYMPHONY_ROOT: paths.root,
          SYMPHONY_TASK: task.id,
          SYMPHONY_TITLE: task.title,
          SYMPHONY_SUMMARY: state.tasks[task.id]?.summary ?? '',
        }, (m) => log.warn(m));
        if (!flags.continueOnFailure && config.onBlocked === 'stop') {
          log.error(`stopping at ${task.id} (blocked): the session finished what it could; the human items are in its Hand-off. Re-run to continue past it, \`symphony accept ${task.id} --note ...\` to sign off, or \`symphony run --retry --only ${task.id}\` to redo.`);
          return 2;
        }
        log.warn(`${task.id}: blocked (human input needed) but onBlocked=${config.onBlocked === 'continue' ? 'continue' : 'continue-on-failure'}; moving on.`);
        continue;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= config.halt.maxConsecutiveFailures) {
        return setHalt(ctx, { at: nowIso(), taskId: task.id, category: 'consecutive_failures', reason: `${consecutiveFailures} tasks failed in a row (halt.maxConsecutiveFailures = ${config.halt.maxConsecutiveFailures})` });
      }
      if (!flags.continueOnFailure) {
        log.error(`stopping at ${task.id} (failed): ${state.tasks[task.id]?.summary ?? ''}. Fix, then re-run to retry it.`);
        return 2;
      }
    }
    const done = ctx.tasks.filter((t) => DONE_STATES.includes(state.tasks[t.id]?.status ?? 'pending')).length;
    const blocked = ctx.tasks.filter((t) => state.tasks[t.id]?.status === 'blocked').map((t) => t.id);
    updatePipelineStatus(paths, ctx.tasks, state, log);
    log.info(`run finished: ${done}/${ctx.tasks.length} done${blocked.length ? `; awaiting a human: ${blocked.join(' ')}` : ''}${runCost() > 0 ? ` · $${runCost().toFixed(2)} reported this run` : ''}`);
    return 0;
  };

  const preSpend = await budgetHalt();
  if (preSpend !== undefined) return preSpend;

  acquireLock(paths);
  ctx.startBranch = currentBranch(paths.root);
  const stopHeartbeat = startLockHeartbeat(paths);
  // The pipeline has kicked off: arm the periodic, read-only progress/health watcher now. It is
  // advisory — a missing provider or a failed check updates the TUI panel and watch log only.
  const watcher = startPipelineWatch(ctx);
  await slackNotify(ctx, 'runStart', {
    title: `Run started — ${todo.length} task${todo.length === 1 ? '' : 's'} queued`,
    lines: [
      `queue ${todo.slice(0, 12).map((t) => t.id).join(' ')}${todo.length > 12 ? ` … +${todo.length - 12} more` : ''}`,
      ctx.startBranch ? `branch ${ctx.startBranch}` : '',
    ],
  });
  let code: number;
  try {
    code = await runLoop();
  } finally {
    watcher?.stop();
    stopHeartbeat();
    releaseLock(paths);
  }
  const runStatus = code === 0 ? 'ok' : code === 2 ? 'stopped' : code === 3 ? 'halted' : 'error';
  fireHook(config, 'onRunEnd', {
    SYMPHONY_ROOT: paths.root,
    SYMPHONY_EXIT: String(code),
    SYMPHONY_STATUS: runStatus,
    SYMPHONY_COST: runCost() > 0 ? runCost().toFixed(2) : '',
  }, (m) => log.warn(m));
  const doneCount = ctx.tasks.filter((t) => DONE_STATES.includes(state.tasks[t.id]?.status ?? 'pending')).length;
  const blockedIds = ctx.tasks.filter((t) => state.tasks[t.id]?.status === 'blocked').map((t) => t.id);
  const failedCount = ctx.tasks.filter((t) => state.tasks[t.id]?.status === 'failed').length;
  await slackNotify(ctx, 'runEnd', {
    title: `Run finished — ${runStatus}`,
    lines: [
      `${doneCount}/${ctx.tasks.length} done${blockedIds.length ? ` · ${blockedIds.length} blocked (${blockedIds.join(', ')})` : ''}${failedCount ? ` · ${failedCount} failed` : ''}`,
      `exit code ${code}${runCost() > 0 ? ` · cost $${runCost().toFixed(2)} this run` : ''}`,
      ctx.startBranch ? `branch ${ctx.startBranch}` : '',
    ],
  });
  return code;
}

/** Manual close-out: resume a task's recorded session and ask it to report. */
export async function nudgeCommand(ctx: RunContext, rawId: string, note?: string): Promise<number> {
  const { paths, config, log, state } = ctx;
  const id = canonicalId(rawId);
  const task = id ? ctx.tasks.find((t) => t.id === id) : undefined;
  if (!task) throw new UsageError(`nudge ${rawId}: no such task in ROADMAP.md`);
  const st = state.tasks[task.id];
  if (!st?.sessionId) throw new UsageError(`nudge ${task.id}: no recorded session id to resume`);
  if (DONE_STATES.includes(st.status)) { log.info(`${task.id} is already ${st.status}; nothing to nudge`); return 0; }
  if (state.halted) { haltBanner(ctx, state.halted); return 3; }

  const { spec } = resolveSession(config, task, ctx.cli, process.env, (p) => getProvider(p).supportsBudget, variantSupported);
  const provider = getProvider(spec.providerName);
  if (!provider.supportsResume) throw new UsageError(`provider ${provider.name} cannot resume sessions`);
  if (!preflight(ctx, spec, provider)) return 4;
  const jevHalt = jevMisconfigHalt(config);
  if (jevHalt) return setHalt(ctx, jevHalt);

  acquireLock(paths);
  ctx.startBranch = currentBranch(paths.root);
  const stopHeartbeat = startLockHeartbeat(paths);
  try {
    st.status = 'running';
    saveState(paths, state);
    patchRoadmap(ctx, task.id, 'running');
    log.info(`=== ${task.id} nudge: resuming ${st.sessionId}`);
    const outcome = await runOneSession(ctx, task, st, provider, spec, buildNudgePrompt(promptCtx(ctx, task, st, spec, st.lastError?.message, 0), note), { kind: 'nudge', logKind: 'nudge', attempt: st.attempts, resumeId: st.sessionId, timeoutMin: Math.min(spec.timeoutMin, config.nudgeTimeoutMin) });
    st.nudged = true;
    const block = parseResultBlock(outcome.result.text) ?? parseResultBlock(outcome.allText);
    let final: Final;
    let halt: Halted | undefined;
    if (outcome.interrupted || ctx.interrupted) final = { status: 'failed', summary: 'interrupted', lastError: { category: 'interrupted', message: 'interrupted', transient: true, fatal: false, at: nowIso() } };
    else if (block && outcome.result.ok && block.status === 'continue') final = { status: 'failed', summary: `${block.summary || 'more work remains'} | reported continue; run \`symphony run\` to continue in a fresh session`, lastError: { category: 'task', message: 'reported continue', transient: false, fatal: false, at: nowIso() } };
    else if (block && outcome.result.ok) final = { status: block.status as TaskStatus, summary: block.summary || block.status };
    else {
      const c = await classifyOutcome(ctx, task, st, outcomeEvidence(outcome));
      final = { status: 'failed', summary: block ? `${block.summary} | ${c.category}: ${c.message}` : `${c.category}: ${c.message} (still no SYMPHONY_RESULT after nudge)`, lastError: mkError(c) };
      if (c.fatal) halt = { at: nowIso(), taskId: task.id, category: c.category, reason: c.message };
    }
    await finalizeTask(ctx, task, st, final, halt);
    if (halt) return setHalt(ctx, halt);
    return final.status === 'done' ? 0 : 2;
  } finally {
    stopHeartbeat();
    releaseLock(paths);
  }
}

export { createLogger };
