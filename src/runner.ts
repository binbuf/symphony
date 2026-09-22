import { existsSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { classifyFailure, type Classified, type FailureEvidence } from './classify.js';
import { resolveSession, resolveVerify, type CliOverrides, type Config, type SessionSpec } from './config.js';
import { writeProgressDigest } from './context.js';
import { formatChecks, runDoctor, type ExtraProvider } from './doctor.js';
import { commitAll, currentBranch, describeCommit } from './git.js';
import { fireHook } from './hooks.js';
import { createLogger, openRunSinks, type Logger } from './logger.js';
import { writeTaskLog } from './logs.js';
import { stopPresent, type Paths } from './paths.js';
import { buildContinuePrompt, buildNudgePrompt, buildResumePrompt, buildTaskPrompt, ensureProgressFile, type PromptCtx } from './prompt.js';
import { getProvider } from './providers/index.js';
import type { Provider, SpawnSpec } from './providers/types.js';
import { generateIndex, writeIndex } from './repomap.js';
import { parseResultBlock, type ResultBlock } from './result.js';
import { canonicalId, patchRoadmapFile, type Roadmap } from './roadmap.js';
import { startSession, type Session, type SessionOutcome } from './session.js';
import { updatePipelineStatus } from './status.js';
import { DONE_STATES, SKIP_STATES, acquireLock, newTaskState, releaseLock, saveState, startLockHeartbeat, type Halted, type LastError, type LogRef, type State, type TaskState, type TaskStatus } from './state.js';
import type { Task } from './tasks.js';
import { UsageError, ensureDir, fmtCost, fmtDuration, nowIso, sleep, squash, stamp } from './util.js';
import { runVerify } from './verify.js';

export interface RunFlags {
  from?: string;
  to?: string;
  only?: string[];
  retry: boolean;
  continueOnFailure: boolean;
  dryRun: boolean;
  clearHalt: boolean;
}

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
  /** Branch HEAD pointed at when the run started; commits refuse to land elsewhere. */
  startBranch?: string;
  /** Session cost reported during this invocation, for the provider-agnostic run budget. */
  runCostUsd?: number;
}

interface Final { status: TaskStatus; summary: string; lastError?: LastError }
interface TaskOutcome { status: TaskStatus; halt?: Halted; stopped?: boolean; interrupted?: boolean }

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
    try { writeProgressDigest(paths.progress); } catch (e) { log.warn(`could not update the ${relative(paths.root, paths.progress)} digest: ${(e as Error).message}`); }
  }
  if (config.repoMap) {
    try { writeIndex(paths); } catch (e) { log.warn(`could not write ${relative(paths.root, paths.index)}: ${(e as Error).message}`); }
  }
}

function mkError(c: Classified): LastError {
  return { category: c.category, message: c.message, transient: c.transient, fatal: c.fatal, at: nowIso() };
}

export function outcomeEvidence(out: SessionOutcome): FailureEvidence {
  return {
    apiErrorCategories: out.hints.apiErrorCategories,
    errorTexts: out.hints.errorTexts,
    resultOk: out.result.ok,
    resultSubtype: out.result.errorSubtype,
    resultText: out.result.text,
    sawResult: out.sawResult,
    exitCode: out.exitCode,
    signal: out.signal,
    spawnError: out.spawnError,
    stderrTail: out.stderrTail,
    timedOut: out.timedOut,
    stalled: out.stalled,
    interrupted: out.interrupted,
  };
}

/** Merge a nudge outcome into the attempt: flags/result from the nudge, hints from both. */
function mergeOutcome(first: SessionOutcome, second: SessionOutcome): SessionOutcome {
  return {
    ...second,
    sessionId: second.sessionId ?? first.sessionId,
    allText: `${first.allText}\n${second.allText}`,
    hints: {
      apiErrorCategories: [...first.hints.apiErrorCategories, ...second.hints.apiErrorCategories],
      errorTexts: [...first.hints.errorTexts, ...second.hints.errorTexts],
      costUsd: (first.hints.costUsd ?? 0) + (second.hints.costUsd ?? 0) || undefined,
    },
  };
}

interface SessionRun {
  kind: 'task' | 'resume' | 'nudge' | 'continue';
  logKind: 'task' | 'retry' | 'nudge';
  attempt: number;
  resumeId?: string;
  timeoutMin: number;
}

async function runOneSession(ctx: RunContext, task: Task, st: TaskState, provider: Provider, spec: SessionSpec, prompt: string, r: SessionRun): Promise<SessionOutcome> {
  const { paths, log, state } = ctx;
  ensureDir(paths.runs);
  const suffix = r.logKind === 'nudge' ? '-nudge' : r.attempt > 1 ? `-r${r.attempt}` : '';
  const sinks = openRunSinks(paths.runs, `${task.id}-${stamp()}${suffix}`);
  writeFileSync(sinks.promptPath, prompt);
  const rel = (p: string) => relative(paths.root, p);
  const entry: LogRef = { kind: r.logKind, jsonl: rel(sinks.jsonlPath), log: rel(sinks.logPath), prompt: rel(sinks.promptPath), started: nowIso() };
  st.logs.push(entry);

  const cmd = provider.buildCommand({
    bin: spec.bin, prompt, promptFile: sinks.promptPath, taskId: task.id, attempt: r.attempt, kind: r.kind,
    resumeId: r.resumeId, model: spec.model, autoApprove: spec.autoApprove, budgetUsd: spec.budgetUsd,
    extraArgs: spec.extraArgs, cwd: paths.root,
  });
  log.info(`${task.id}: ${describeCmd(cmd)}`);
  log.info(`${task.id}: streaming to ${rel(sinks.logPath)} (raw: ${rel(sinks.jsonlPath)})`);

  const session = startSession({
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
  if (outcome.sessionId) st.sessionId = outcome.sessionId;
  // Record what this session reported for the docs run log: the high-level result status + summary.
  const reported = parseResultBlock(outcome.result.text) ?? parseResultBlock(outcome.allText);
  entry.status = reported?.status ?? outcome.result.errorSubtype ?? (outcome.result.ok ? 'ok' : 'no-result');
  entry.summary = reported?.summary || (outcome.result.ok ? snapshotText(outcome) : outcome.result.errorSubtype);
  entry.durationS = Math.round(outcome.durationMs / 1000);
  if (outcome.costUsd !== undefined) entry.costUsd = outcome.costUsd;
  saveState(paths, state);
  return outcome;
}

/** Last non-empty assistant line, a compact fallback when a session produced no result summary. */
function snapshotText(outcome: SessionOutcome): string | undefined {
  const line = outcome.allText.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return line ? line.slice(0, 300) : undefined;
}

function finalizeTask(ctx: RunContext, task: Task, st: TaskState, final: Final, halt?: Halted): void {
  const { paths, config, log, state } = ctx;
  st.status = final.status;
  st.summary = final.summary;
  st.finished = nowIso();
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
      writeTaskLog(paths, task, st, { commitPreview: message });
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
    SYMPHONY_COST: st.costUsd !== undefined ? st.costUsd.toFixed(2) : '',
  }, (m) => log.warn(`${task.id}: ${m}`));
  log.info(`=== ${task.id} -> ${final.status.toUpperCase()} · ${fmtDuration(st.durationS)} · ${fmtCost(st.costUsd)} · ${final.summary} · git: ${st.commit}`);
}

function promptCtx(ctx: RunContext, task: Task, st: TaskState, spec: SessionSpec, lastError: string | undefined, continuation: number, indexBody?: string): PromptCtx {
  return { paths: ctx.paths, task, tasks: ctx.tasks, state: ctx.state, attempt: st.attempts, continuation, providerName: spec.providerName, model: spec.model, maxProgressBytes: ctx.config.maxProgressBytes, designDocs: ctx.config.designDocs, lastError, progressDigest: ctx.config.progressDigest, inlineDesignDocs: ctx.config.inlineDesignDocs, maxIndexBytes: ctx.config.maxIndexBytes, maxTaskBytes: ctx.config.maxTaskBytes, indexBody };
}

/** Abortable, STOP-aware backoff. Returns true when a STOP file appeared. */
async function backoff(ctx: RunContext, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !ctx.interrupted) {
    if (stopPresent(ctx.paths)) return true;
    await sleep(Math.min(5000, deadline - Date.now()), ctx.abort.signal);
  }
  return stopPresent(ctx.paths);
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
  const { spec, warnings } = resolveSession(config, task, ctx.cli, process.env, (p) => getProvider(p).supportsBudget);
  warnings.forEach((w) => log.warn(`${task.id}: ${w}`));
  const provider = getProvider(spec.providerName);
  const maxAttempts = Math.max(1, config.retry.maxAttempts);
  const maxContinuations = Math.max(0, config.maxContinuations);
  const maxIterations = Math.max(0, config.maxIterationsPerTask);
  ensureProgressFile(paths);
  refreshDerivedDocs(ctx);

  let resumeId: string | undefined;
  let lastTransient: Classified | undefined;
  let retryCount = 0;
  let continuation = 0;
  let iterations = 0;
  let final: Final | undefined;
  let halt: Halted | undefined;

  for (let attempt = 1; ; attempt++) {
    if (maxIterations > 0 && iterations >= maxIterations) {
      final = { status: 'failed', summary: `stopped after maxIterationsPerTask (${maxIterations}) sessions without finishing`, lastError: { category: 'task', message: 'maxIterationsPerTask reached', transient: false, fatal: false, at: nowIso() } };
      break;
    }
    if (lastTransient) {
      const wait = config.retry.backoffSec[Math.min(retryCount - 1, config.retry.backoffSec.length - 1)] ?? 30;
      log.warn(`${task.id}: ${lastTransient.category}: ${lastTransient.message}. Retry ${retryCount}/${maxAttempts} in ${wait}s ${resumeId ? `resuming session ${resumeId}` : 'with a fresh session'}.`);
      const stopped = await backoff(ctx, wait * 1000);
      if (ctx.interrupted) { final = { status: 'failed', summary: 'interrupted during retry backoff', lastError: { category: 'interrupted', message: 'interrupted during retry backoff', transient: true, fatal: false, at: nowIso() } }; break; }
      if (stopped) { log.warn(`${task.id}: STOP present; not retrying. Remove ${paths.stop} and re-run to continue.`); return { status: st.status, stopped: true }; }
    }

    st.status = 'running';
    st.attempts += 1;
    iterations += 1;
    st.started = nowIso();
    st.provider = spec.providerName;
    st.model = spec.model;
    delete st.finished;
    saveState(paths, state);
    patchRoadmap(ctx, task.id, 'running');
    log.info(`=== ${task.id} ${task.title} (session ${st.attempts}${retryCount > 0 ? `, retry ${retryCount}/${maxAttempts}` : ''}${continuation > 0 ? `, continuation ${continuation}/${maxContinuations}` : ''}) provider=${spec.providerName} model=${spec.model ?? 'default'} timeout=${spec.timeoutMin}min`);

    const pc = promptCtx(ctx, task, st, spec, lastTransient ? lastTransient.message : st.lastError?.message, continuation);
    const prompt = lastTransient && resumeId
      ? buildResumePrompt(pc, lastTransient.message)
      : continuation > 0
        ? buildContinuePrompt(pc)
        : buildTaskPrompt(pc);
    let outcome = await runOneSession(ctx, task, st, provider, spec, prompt, { kind: continuation > 0 && !lastTransient ? 'continue' : resumeId ? 'resume' : 'task', logKind: retryCount > 0 ? 'retry' : 'task', attempt, resumeId, timeoutMin: spec.timeoutMin });
    resumeId = outcome.sessionId ?? resumeId;
    let block: ResultBlock | undefined = parseResultBlock(outcome.result.text) ?? parseResultBlock(outcome.allText);

    if (!block && outcome.result.ok && outcome.sessionId && !outcome.timedOut && !outcome.stalled && !outcome.interrupted && !ctx.interrupted && config.nudge && provider.supportsResume) {
      log.warn(`${task.id}: session ended without a SYMPHONY_RESULT block; resuming ${outcome.sessionId} once to close out`);
      const nudge = await runOneSession(ctx, task, st, provider, spec, buildNudgePrompt(pc), { kind: 'nudge', logKind: 'nudge', attempt, resumeId: outcome.sessionId, timeoutMin: Math.min(spec.timeoutMin, config.nudgeTimeoutMin) });
      st.nudged = true;
      resumeId = nudge.sessionId ?? resumeId;
      block = parseResultBlock(nudge.result.text) ?? parseResultBlock(nudge.allText);
      if (!block && !nudge.result.ok) {
        const c = classifyFailure(outcomeEvidence(nudge), config.halt.onCategories);
        if (c.fatal && c.category !== 'config') outcome = mergeOutcome(outcome, nudge);
        else log.warn(`${task.id}: nudge session failed (${c.category}: ${c.message}); judging the task on its original session`);
      } else {
        outcome = mergeOutcome(outcome, nudge);
      }
    }

    if (outcome.interrupted || ctx.interrupted) {
      const msg = `interrupted by ${ctx.signalName ?? 'signal'}`;
      final = { status: 'failed', summary: msg, lastError: { category: 'interrupted', message: msg, transient: true, fatal: false, at: nowIso() } };
      break;
    }

    if (block && outcome.result.ok) {
      if (block.status === 'continue') {
        st.summary = block.summary || 'continuing in a fresh session';
        saveState(paths, state);
        if (continuation < maxContinuations) {
          continuation += 1;
          refreshDerivedDocs(ctx);
          if (config.commitPerSession) commitIntermediate(ctx, task, st);
          log.info(`${task.id}: session reported continue (${continuation}/${maxContinuations}); starting a fresh session for the next slice`);
          resumeId = undefined;
          lastTransient = undefined;
          continue;
        }
        final = { status: 'failed', summary: `${block.summary || 'more work remains'} | gave up after ${maxContinuations} continuation sessions (maxContinuations)`, lastError: { category: 'task', message: 'continuation limit reached', transient: false, fatal: false, at: nowIso() } };
        break;
      }
      if (block.status === 'done') {
        const verify = resolveVerify(config, task, paths.root);
        if (verify) {
          log.info(`${task.id}: running verify: ${verify.command}`);
          const res = runVerify(paths.root, verify.command, verify.timeoutMin * 60_000);
          st.verify = { command: verify.command, ok: res.ok, code: res.code ?? undefined, output: res.output.slice(-2000) || undefined, at: nowIso() };
          if (!res.ok) {
            const msg = `verify failed (exit ${res.code ?? 'timeout'}): ${verify.command} — ${squash(res.output, 240) || 'no output'}`;
            log.error(`${task.id}: ${msg}`);
            final = { status: 'failed', summary: msg, lastError: { category: 'verify', message: msg, transient: false, fatal: false, at: nowIso() } };
            break;
          }
          log.info(`${task.id}: verify passed`);
        }
      }
      final = { status: block.status, summary: block.summary || block.status };
      if (block.status !== 'done') final.lastError = { category: 'task', message: block.summary || `model reported ${block.status}`, transient: false, fatal: false, at: nowIso() };
      break;
    }

    const classified = classifyFailure(outcomeEvidence(outcome), config.halt.onCategories);
    const summary = block ? `${block.summary} | ${classified.category}: ${classified.message}` : `${classified.category}: ${classified.message}`;
    const lastError = mkError(classified);
    if (classified.fatal) {
      final = { status: 'failed', summary, lastError };
      halt = { at: nowIso(), taskId: task.id, category: classified.category, reason: classified.message };
      break;
    }
    if (classified.transient && retryCount < maxAttempts) {
      retryCount += 1;
      lastTransient = classified;
      st.status = 'failed';
      st.lastError = lastError;
      st.summary = summary;
      st.finished = nowIso();
      saveState(paths, state);
      patchRoadmap(ctx, task.id, 'failed');
      if (!provider.supportsResume || !outcome.sessionId) resumeId = undefined;
      continue;
    }
    final = { status: 'failed', summary: classified.transient ? `${summary} (gave up after ${retryCount} retries)` : summary, lastError };
    break;
  }

  finalizeTask(ctx, task, st, final ?? { status: 'failed', summary: 'no attempt ran' }, halt);
  return { status: final?.status ?? 'failed', halt, interrupted: ctx.interrupted };
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
    'Fix the cause, then run: symphony clear-halt   (or: symphony run --clear-halt)',
  ]);
}

function setHalt(ctx: RunContext, h: Halted): number {
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
  return 3;
}

export function preflight(ctx: RunContext, spec: SessionSpec | undefined, provider: Provider | undefined, opts: { ignoreHalt?: boolean; skipAuth?: boolean; skipRoadmap?: boolean; extraProviders?: ExtraProvider[] } = {}): boolean {
  const checks = runDoctor({ paths: ctx.paths, config: ctx.config, state: ctx.state, spec, provider, extraProviders: opts.extraProviders, taskCount: ctx.tasks.length, ignoreHalt: opts.ignoreHalt, skipAuth: opts.skipAuth, skipRoadmap: opts.skipRoadmap });
  for (const line of formatChecks(checks)) ctx.log.plain(line);
  return !checks.some((c) => c.level === 'fail');
}

export async function runCommand(ctx: RunContext): Promise<number> {
  const { paths, config, flags, log, state } = ctx;

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

  const selected = selectTasks(ctx);
  let todo = selected.filter((t) => flags.retry || !SKIP_STATES.includes(state.tasks[t.id]?.status ?? 'pending'));
  const carried = selected.filter((t) => !flags.retry && state.tasks[t.id]?.status === 'blocked');
  const leftRunning = todo.filter((t) => state.tasks[t.id]?.status === 'running');

  const first = todo[0];
  const { spec, warnings } = resolveSession(config, first, ctx.cli, process.env, (p) => getProvider(p).supportsBudget);
  warnings.forEach((w) => log.warn(w));
  const provider = getProvider(spec.providerName);
  // Tasks may override the provider in front matter: preflight every provider this run will use.
  const extraProviders: ExtraProvider[] = [];
  {
    const seen = new Set([spec.providerName]);
    for (const t of todo) {
      const rs = resolveSession(config, t, ctx.cli, process.env, (p) => getProvider(p).supportsBudget);
      if (seen.has(rs.spec.providerName)) continue;
      seen.add(rs.spec.providerName);
      rs.warnings.forEach((w) => log.warn(`${t.id}: ${w}`));
      extraProviders.push({ spec: rs.spec, provider: getProvider(rs.spec.providerName), label: t.id });
    }
  }
  if (!preflight(ctx, spec, provider, { skipAuth: flags.dryRun, ignoreHalt: flags.dryRun, extraProviders })) {
    log.error('preflight failed; fix the ✗ items above (or run: symphony doctor)');
    return 4;
  }

  log.info(`${selected.length} task${selected.length === 1 ? '' : 's'} selected, ${todo.length} to run: ${todo.map((t) => t.id).join(' ') || '-'}`);
  if (carried.length) log.warn(`carrying forward blocked (human items in their Hand-off, not re-run): ${carried.map((t) => t.id).join(' ')} — \`symphony accept T..\` to sign off, \`symphony run --retry --only T..\` to redo`);
  for (const t of leftRunning) log.warn(`${t.id} was left "running" (previous harness crashed or was killed); it will be retried`);

  if (flags.dryRun) {
    if (!todo.length) { log.info('nothing to run'); return 0; }
    const capNote = config.maxTasksPerRun > 0 && todo.length > config.maxTasksPerRun ? ` (capped to ${config.maxTasksPerRun} by maxTasksPerRun)` : '';
    log.plain(`\n${todo.length} task${todo.length === 1 ? '' : 's'} would run${capNote}: ${todo.map((t) => t.id).join(' ')}`);
    // Build a fresh repo map in memory so the preview matches what a real run would send.
    const previewIndex = config.repoMap ? generateIndex(paths) : undefined;
    for (const t of todo) {
      const rs = resolveSession(config, t, ctx.cli, process.env, (p) => getProvider(p).supportsBudget);
      const tProvider = getProvider(rs.spec.providerName);
      const st = state.tasks[t.id] ?? newTaskState(t.title);
      const prompt = buildTaskPrompt(promptCtx(ctx, t, { ...st, attempts: st.attempts + 1 }, rs.spec, st.lastError?.message, 0, previewIndex));
      const cmd = tProvider.buildCommand({ bin: rs.spec.bin, prompt, promptFile: `${paths.runs}/${t.id}-<stamp>.prompt.md`, taskId: t.id, attempt: st.attempts + 1, kind: 'task', model: rs.spec.model, autoApprove: rs.spec.autoApprove, budgetUsd: rs.spec.budgetUsd, extraArgs: rs.spec.extraArgs, cwd: paths.root });
      log.plain(`\n=== ${t.id} — ${t.title}`);
      log.plain(`provider: ${rs.spec.providerName} [${rs.spec.sources.provider}] · model: ${rs.spec.model ?? 'provider default'} [${rs.spec.sources.model}] · timeout ${rs.spec.timeoutMin} min · idle ${rs.spec.idleTimeoutMin} min · auto-approve ${rs.spec.autoApprove}`);
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

  if (config.maxTasksPerRun > 0 && todo.length > config.maxTasksPerRun) {
    log.info(`maxTasksPerRun=${config.maxTasksPerRun}: running the first ${config.maxTasksPerRun} of ${todo.length} selected task(s); the rest stay for a later run`);
    todo = todo.slice(0, config.maxTasksPerRun);
  }

  const runCost = (): number => ctx.runCostUsd ?? 0;
  const budgetHalt = (): number | undefined => {
    if (config.maxCostUsdPerRun <= 0 || runCost() < config.maxCostUsdPerRun) return undefined;
    return setHalt(ctx, {
      at: nowIso(), category: 'budget',
      reason: `sessions reported $${runCost().toFixed(2)} during this run (maxCostUsdPerRun = $${config.maxCostUsdPerRun.toFixed(2)}); raise the cap or \`symphony clear-halt\` to continue`,
    });
  };

  const runLoop = async (): Promise<number> => {
    let consecutiveFailures = 0;
    for (const task of todo) {
      if (ctx.interrupted) return ctx.signalName === 'SIGTERM' ? 143 : 130;
      if (stopPresent(paths)) {
        log.warn(`${relative(paths.root, paths.stop)} present: pausing before ${task.id}. Remove it and re-run to continue.`);
        return 0;
      }
      const spend = budgetHalt();
      if (spend !== undefined) return spend;
      const st = state.tasks[task.id];
      if (st && st.status === 'failed' && st.attempts >= config.halt.maxAttemptsPerTask && !flags.retry) {
        return setHalt(ctx, { at: nowIso(), taskId: task.id, category: 'attempts', reason: `${task.id} has failed ${st.attempts} times (halt.maxAttemptsPerTask = ${config.halt.maxAttemptsPerTask}); last: ${st.lastError?.message ?? st.summary ?? '?'}. Fix the cause, then \`symphony run --clear-halt --retry --only ${task.id}\`` });
      }

      const out = await runTask(ctx, task);
      if (out.stopped) return 0;
      if (out.halt) return setHalt(ctx, out.halt);
      if (out.interrupted) return ctx.signalName === 'SIGTERM' ? 143 : 130;
      const overBudget = budgetHalt();
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

  const preSpend = budgetHalt();
  if (preSpend !== undefined) return preSpend;

  acquireLock(paths);
  ctx.startBranch = currentBranch(paths.root);
  const stopHeartbeat = startLockHeartbeat(paths);
  let code: number;
  try {
    code = await runLoop();
  } finally {
    stopHeartbeat();
    releaseLock(paths);
  }
  fireHook(config, 'onRunEnd', {
    SYMPHONY_ROOT: paths.root,
    SYMPHONY_EXIT: String(code),
    SYMPHONY_STATUS: code === 0 ? 'ok' : code === 2 ? 'stopped' : code === 3 ? 'halted' : 'error',
    SYMPHONY_COST: runCost() > 0 ? runCost().toFixed(2) : '',
  }, (m) => log.warn(m));
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

  const { spec } = resolveSession(config, task, ctx.cli, process.env, (p) => getProvider(p).supportsBudget);
  const provider = getProvider(spec.providerName);
  if (!provider.supportsResume) throw new UsageError(`provider ${provider.name} cannot resume sessions`);
  if (!preflight(ctx, spec, provider)) return 4;

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
      const c = classifyFailure(outcomeEvidence(outcome), config.halt.onCategories);
      final = { status: 'failed', summary: block ? `${block.summary} | ${c.category}: ${c.message}` : `${c.category}: ${c.message} (still no SYMPHONY_RESULT after nudge)`, lastError: mkError(c) };
      if (c.fatal) halt = { at: nowIso(), taskId: task.id, category: c.category, reason: c.message };
    }
    finalizeTask(ctx, task, st, final, halt);
    if (halt) return setHalt(ctx, halt);
    return final.status === 'done' ? 0 : 2;
  } finally {
    stopHeartbeat();
    releaseLock(paths);
  }
}

export { createLogger };
