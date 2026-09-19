import { existsSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { classifyFailure, type Classified, type FailureEvidence } from './classify.js';
import { resolveSession, type CliOverrides, type Config, type SessionSpec } from './config.js';
import { formatChecks, runDoctor } from './doctor.js';
import { commitAll, describeCommit } from './git.js';
import { createLogger, openRunSinks, type Logger } from './logger.js';
import type { Paths } from './paths.js';
import { buildNudgePrompt, buildResumePrompt, buildTaskPrompt, ensureProgressFile, type PromptCtx } from './prompt.js';
import { getProvider } from './providers/index.js';
import type { Provider, SpawnSpec } from './providers/types.js';
import { parseResultBlock, type ResultBlock } from './result.js';
import { canonicalId, patchRoadmapFile, type Roadmap } from './roadmap.js';
import { startSession, type Session, type SessionOutcome } from './session.js';
import { DONE_STATES, SKIP_STATES, acquireLock, newTaskState, releaseLock, saveState, type Halted, type LastError, type State, type TaskState, type TaskStatus } from './state.js';
import type { Task } from './tasks.js';
import { UsageError, ensureDir, fmtCost, fmtDuration, nowIso, sleep, stamp } from './util.js';

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
  kind: 'task' | 'resume' | 'nudge';
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
  st.logs.push({ kind: r.logKind, jsonl: rel(sinks.jsonlPath), log: rel(sinks.logPath), prompt: rel(sinks.promptPath) });

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
  if (outcome.sessionId) st.sessionId = outcome.sessionId;
  saveState(paths, state);
  return outcome;
}

function finalizeTask(ctx: RunContext, task: Task, st: TaskState, final: Final, halt?: Halted): void {
  const { paths, config, log, state } = ctx;
  st.status = final.status;
  st.summary = final.summary;
  st.finished = nowIso();
  if (final.status === 'done') delete st.lastError; else if (final.lastError) st.lastError = final.lastError;
  delete st.pid;

  // Marker first so the task's own commit carries the final [x]/[~] state.
  patchRoadmap(ctx, task.id, final.status);
  const message = renderTemplate(config.commitMessageTemplate, { id: task.id, title: task.title, status: final.status });
  const commit = commitAll(paths.root, message);
  st.commit = describeCommit(commit);
  if (commit.status === 'failed') log.warn(`${task.id}: ${st.commit}`);

  if (halt) state.halted = halt;
  saveState(paths, state);
  log.info(`=== ${task.id} -> ${final.status.toUpperCase()} · ${fmtDuration(st.durationS)} · ${fmtCost(st.costUsd)} · ${final.summary} · git: ${st.commit}`);
}

function promptCtx(ctx: RunContext, task: Task, st: TaskState, spec: SessionSpec, lastError?: string): PromptCtx {
  return { paths: ctx.paths, task, tasks: ctx.tasks, state: ctx.state, attempt: st.attempts, providerName: spec.providerName, model: spec.model, maxProgressBytes: ctx.config.maxProgressBytes, lastError };
}

/** Abortable, STOP-aware backoff. Returns true when a STOP file appeared. */
async function backoff(ctx: RunContext, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !ctx.interrupted) {
    if (existsSync(ctx.paths.stop)) return true;
    await sleep(Math.min(5000, deadline - Date.now()), ctx.abort.signal);
  }
  return existsSync(ctx.paths.stop);
}

export async function runTask(ctx: RunContext, task: Task): Promise<TaskOutcome> {
  const { paths, config, log, state } = ctx;
  const st = (state.tasks[task.id] ??= newTaskState(task.title));
  st.title = task.title;
  const { spec, warnings } = resolveSession(config, task, ctx.cli, process.env, (p) => getProvider(p).supportsBudget);
  warnings.forEach((w) => log.warn(`${task.id}: ${w}`));
  const provider = getProvider(spec.providerName);
  const maxAttempts = Math.max(1, config.retry.maxAttempts);
  ensureProgressFile(paths);

  let resumeId: string | undefined;
  let lastTransient: Classified | undefined;
  let final: Final | undefined;
  let halt: Halted | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && lastTransient) {
      const wait = config.retry.backoffSec[Math.min(attempt - 2, config.retry.backoffSec.length - 1)] ?? 30;
      log.warn(`${task.id}: ${lastTransient.category}: ${lastTransient.message}. Retry ${attempt}/${maxAttempts} in ${wait}s ${resumeId ? `resuming session ${resumeId}` : 'with a fresh session'}.`);
      const stopped = await backoff(ctx, wait * 1000);
      if (ctx.interrupted) { final = { status: 'failed', summary: 'interrupted during retry backoff', lastError: { category: 'interrupted', message: 'interrupted during retry backoff', transient: true, fatal: false, at: nowIso() } }; break; }
      if (stopped) { log.warn(`${task.id}: STOP present; not retrying. Remove ${paths.stop} and re-run to continue.`); return { status: st.status, stopped: true }; }
    }

    st.status = 'running';
    st.attempts += 1;
    st.started = nowIso();
    st.provider = spec.providerName;
    st.model = spec.model;
    delete st.finished;
    saveState(paths, state);
    patchRoadmap(ctx, task.id, 'running');
    log.info(`=== ${task.id} ${task.title} (attempt ${st.attempts}${attempt > 1 ? `, retry ${attempt}/${maxAttempts}` : ''}) provider=${spec.providerName} model=${spec.model ?? 'default'} timeout=${spec.timeoutMin}min`);

    const pc = promptCtx(ctx, task, st, spec, attempt === 1 ? st.lastError?.message : lastTransient?.message);
    const prompt = resumeId && lastTransient ? buildResumePrompt(pc, lastTransient.message) : buildTaskPrompt(pc);
    let outcome = await runOneSession(ctx, task, st, provider, spec, prompt, { kind: resumeId ? 'resume' : 'task', logKind: attempt > 1 ? 'retry' : 'task', attempt, resumeId, timeoutMin: spec.timeoutMin });
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
    if (classified.transient && attempt < maxAttempts) {
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
    final = { status: 'failed', summary: classified.transient ? `${summary} (gave up after ${attempt} attempts)` : summary, lastError };
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
  haltBanner(ctx, h);
  return 3;
}

export function preflight(ctx: RunContext, spec: SessionSpec | undefined, provider: Provider | undefined, opts: { ignoreHalt?: boolean; skipAuth?: boolean; skipRoadmap?: boolean } = {}): boolean {
  const checks = runDoctor({ paths: ctx.paths, config: ctx.config, state: ctx.state, spec, provider, taskCount: ctx.tasks.length, ignoreHalt: opts.ignoreHalt, skipAuth: opts.skipAuth, skipRoadmap: opts.skipRoadmap });
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
    } else {
      haltBanner(ctx, state.halted);
      return 3;
    }
  }

  if (existsSync(paths.stop) && !flags.dryRun) {
    log.warn(`${paths.stop} present: paused. Remove it and re-run to continue.`);
    return 0;
  }

  const selected = selectTasks(ctx);
  const todo = selected.filter((t) => flags.retry || !SKIP_STATES.includes(state.tasks[t.id]?.status ?? 'pending'));
  const carried = selected.filter((t) => !flags.retry && state.tasks[t.id]?.status === 'blocked');
  const leftRunning = todo.filter((t) => state.tasks[t.id]?.status === 'running');

  const first = todo[0];
  const { spec, warnings } = resolveSession(config, first, ctx.cli, process.env, (p) => getProvider(p).supportsBudget);
  warnings.forEach((w) => log.warn(w));
  const provider = getProvider(spec.providerName);
  if (!preflight(ctx, spec, provider, { skipAuth: flags.dryRun })) {
    log.error('preflight failed; fix the ✗ items above (or run: symphony doctor)');
    return 4;
  }

  log.info(`${selected.length} task${selected.length === 1 ? '' : 's'} selected, ${todo.length} to run: ${todo.map((t) => t.id).join(' ') || '-'}`);
  if (carried.length) log.warn(`carrying forward blocked (human items in their Hand-off, not re-run): ${carried.map((t) => t.id).join(' ')} — \`symphony accept T..\` to sign off, \`symphony run --retry --only T..\` to redo`);
  for (const t of leftRunning) log.warn(`${t.id} was left "running" (previous harness crashed or was killed); it will be retried`);

  if (flags.dryRun) {
    if (!first) { log.info('nothing to run'); return 0; }
    const st = state.tasks[first.id] ?? newTaskState(first.title);
    const prompt = buildTaskPrompt(promptCtx(ctx, first, { ...st, attempts: st.attempts + 1 }, spec, st.lastError?.message));
    const cmd = provider.buildCommand({ bin: spec.bin, prompt, promptFile: `${paths.runs}/${first.id}-<stamp>.prompt.md`, taskId: first.id, attempt: st.attempts + 1, kind: 'task', model: spec.model, autoApprove: spec.autoApprove, budgetUsd: spec.budgetUsd, extraArgs: spec.extraArgs, cwd: paths.root });
    log.plain(`\nprovider: ${spec.providerName} [${spec.sources.provider}] · model: ${spec.model ?? 'provider default'} [${spec.sources.model}] · timeout ${spec.timeoutMin} min · idle ${spec.idleTimeoutMin} min · auto-approve ${spec.autoApprove}`);
    log.plain(`command: ${describeCmd(cmd)}\n`);
    log.plain(`--- prompt for ${first.id} (${Buffer.byteLength(prompt, 'utf8')} bytes) ---\n${prompt}--- end prompt ---`);
    return 0;
  }

  if (todo.length === 0) {
    const done = ctx.tasks.filter((t) => DONE_STATES.includes(state.tasks[t.id]?.status ?? 'pending')).length;
    log.info(`nothing to run: ${done}/${ctx.tasks.length} done${carried.length ? `, ${carried.length} blocked awaiting a human` : ''}`);
    return 0;
  }

  acquireLock(paths);
  try {
    let consecutiveFailures = 0;
    for (const task of todo) {
      if (ctx.interrupted) return ctx.signalName === 'SIGTERM' ? 143 : 130;
      if (existsSync(paths.stop)) {
        log.warn(`${paths.stop} present: pausing before ${task.id}. Remove it and re-run to continue.`);
        return 0;
      }
      const st = state.tasks[task.id];
      if (st && st.status === 'failed' && st.attempts >= config.halt.maxAttemptsPerTask && !flags.retry) {
        return setHalt(ctx, { at: nowIso(), taskId: task.id, category: 'attempts', reason: `${task.id} has failed ${st.attempts} times (halt.maxAttemptsPerTask = ${config.halt.maxAttemptsPerTask}); last: ${st.lastError?.message ?? st.summary ?? '?'}. Fix the cause, then \`symphony run --clear-halt --retry --only ${task.id}\`` });
      }

      const out = await runTask(ctx, task);
      if (out.stopped) return 0;
      if (out.halt) { haltBanner(ctx, out.halt); return 3; }
      if (out.interrupted) return ctx.signalName === 'SIGTERM' ? 143 : 130;

      if (out.status === 'done') { consecutiveFailures = 0; continue; }
      if (out.status === 'blocked') {
        if (!flags.continueOnFailure) {
          log.error(`stopping at ${task.id} (blocked): the session finished what it could; the human items are in its Hand-off. Re-run to continue past it, \`symphony accept ${task.id} --note ...\` to sign off, or \`symphony run --retry --only ${task.id}\` to redo.`);
          return 2;
        }
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
    log.info(`run finished: ${done}/${ctx.tasks.length} done${blocked.length ? `; awaiting a human: ${blocked.join(' ')}` : ''}`);
    return 0;
  } finally {
    releaseLock(paths);
  }
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
  try {
    st.status = 'running';
    saveState(paths, state);
    patchRoadmap(ctx, task.id, 'running');
    log.info(`=== ${task.id} nudge: resuming ${st.sessionId}`);
    const outcome = await runOneSession(ctx, task, st, provider, spec, buildNudgePrompt(promptCtx(ctx, task, st, spec), note), { kind: 'nudge', logKind: 'nudge', attempt: st.attempts, resumeId: st.sessionId, timeoutMin: Math.min(spec.timeoutMin, config.nudgeTimeoutMin) });
    st.nudged = true;
    const block = parseResultBlock(outcome.result.text) ?? parseResultBlock(outcome.allText);
    let final: Final;
    let halt: Halted | undefined;
    if (outcome.interrupted || ctx.interrupted) final = { status: 'failed', summary: 'interrupted', lastError: { category: 'interrupted', message: 'interrupted', transient: true, fatal: false, at: nowIso() } };
    else if (block && outcome.result.ok) final = { status: block.status, summary: block.summary || block.status };
    else {
      const c = classifyFailure(outcomeEvidence(outcome), config.halt.onCategories);
      final = { status: 'failed', summary: block ? `${block.summary} | ${c.category}: ${c.message}` : `${c.category}: ${c.message} (still no SYMPHONY_RESULT after nudge)`, lastError: mkError(c) };
      if (c.fatal) halt = { at: nowIso(), taskId: task.id, category: c.category, reason: c.message };
    }
    finalizeTask(ctx, task, st, final, halt);
    if (halt) { haltBanner(ctx, halt); return 3; }
    return final.status === 'done' ? 0 : 2;
  } finally {
    releaseLock(paths);
  }
}

export { createLogger };
