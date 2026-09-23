import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveWatch, type Config, type SessionSpec } from './config.js';
import { readProgressContext } from './context.js';
import { openRunSinks } from './logger.js';
import { rel, type Paths } from './paths.js';
import { getProvider, variantSupported } from './providers/index.js';
import type { Provider } from './providers/types.js';
import type { RunContext } from './runner.js';
import { startSession, type Session, type SessionOutcome } from './session.js';
import { buildStatusTable } from './status.js';
import { DONE_STATES, type State } from './state.js';
import type { Task } from './tasks.js';
import { ensureDir, fmtCost, fmtDuration, nowIso, resolveBinary, resolveExecutable, squash, stamp } from './util.js';

/**
 * Pipeline watch: a separate, read-only LLM session the harness runs on a timer while `run` is in
 * flight. It reads a self-contained snapshot of the pipeline (counts, task outcomes, PROGRESS.md)
 * and answers with a few sentences on recent developments and overall health. The latest answer is
 * shown in the TUI's top panel and every check is appended to a dedicated watch log. It is advisory:
 * an unavailable provider or a failed check only updates the panel, never the run.
 */

export type WatchStatus = 'waiting' | 'running' | 'ready' | 'error';

export interface WatchState {
  status: WatchStatus;
  /** Whether the watcher is configured on. */
  enabled: boolean;
  intervalMin: number;
  provider: string;
  model?: string;
  /** Latest summary, shown in the panel. */
  summary?: string;
  /** When the last successful check finished (ISO). */
  updatedAt?: string;
  /** When the next check is due (epoch ms), for the panel countdown. */
  nextAt?: number;
  /** Why the last check failed, or why the watcher is off. */
  error?: string;
  /** Completed checks this run. */
  checks: number;
}

export interface WatchLogEntry {
  at: string;
  check: number;
  provider: string;
  model?: string;
  /** `ready` when the check produced a summary, else `error`. */
  status: 'ready' | 'error';
  pipeline: string;
  summary?: string;
  error?: string;
  durationS?: number;
  costUsd?: number;
  sessionLog: string;
  sessionJsonl: string;
  sessionPrompt: string;
}

const WATCH_TASK_ID = 'watch';

/** The dedicated append-only log beside the harness log (`.symphony/watch.log`, or the set's dir). */
export function watchLogPath(paths: Paths): string {
  return join(dirname(paths.log), 'watch.log');
}

function statusOf(state: State, t: Task): string {
  return state.tasks[t.id]?.status ?? 'pending';
}

/** A one-line pipeline snapshot for the log and the prompt header. */
export function pipelineSnapshot(ctx: RunContext): string {
  const { tasks, state } = ctx;
  const table = buildStatusTable(tasks, state);
  const s = table.summary;
  const ids = (pick: (st: string) => boolean): string => tasks.filter((t) => pick(statusOf(state, t))).map((t) => t.id).join(',') || 'none';
  const bits = [
    `${s.done}/${s.total} done`,
    `running ${ids((st) => st === 'running')}`,
    `blocked ${ids((st) => st === 'blocked')}`,
    `failed ${ids((st) => st === 'failed')}`,
    `${fmtCost(s.costUsd)} · ${fmtDuration(s.durationS)}`,
  ];
  if (state.halted) bits.push(`HALTED ${state.halted.category}${state.halted.taskId ? ` on ${state.halted.taskId}` : ''}`);
  return bits.join(' · ');
}

/**
 * The watcher prompt: a fully self-contained snapshot so the model can answer without tools (and so
 * the watcher never needs write access). Kept short: counts, the task list, recent outcomes and the
 * recent PROGRESS.md context.
 */
export function buildWatchPrompt(ctx: RunContext): string {
  const { paths, tasks, state } = ctx;
  const recent = tasks
    .filter((t) => state.tasks[t.id]?.finished)
    .sort((a, b) => (Date.parse(state.tasks[b.id]?.finished ?? '') || 0) - (Date.parse(state.tasks[a.id]?.finished ?? '') || 0))
    .slice(0, 8);

  const taskLines = tasks.slice(0, 40).map((t) => {
    const st = state.tasks[t.id];
    return `- ${t.id} [${st?.status ?? 'pending'}] ${squash(t.title, 80)}${st?.summary ? ` — ${squash(st.summary, 200)}` : ''}`;
  });
  const outcomeLines = recent.map((t) => {
    const st = state.tasks[t.id];
    return `- ${t.id} [${st?.status ?? '?'}] ${squash(t.title, 80)}${st?.summary ? ` — ${squash(st.summary, 240)}` : ''}`;
  });

  const progress = readProgressContext(paths.progress, rel(paths.root, paths.progress), { maxBytes: 8000, recentSections: 3 });

  return [
    'You are a read-only observer of an autonomous coding pipeline ("symphony"). The harness runs one',
    'fresh AI session per task in ROADMAP.md and commits after each. A human is watching the run live,',
    'and your answer is rendered verbatim in a small terminal panel.',
    '',
    'Rules:',
    '- Do NOT call tools and do NOT modify any files. Everything you need is below.',
    '- Answer in 2 to 4 short sentences of plain prose: no headings, no bullet lists, no code fences.',
    '- Name the task ids that moved most recently, and any task that looks stuck, blocked or failing.',
    '- State the overall health in a few words ("on track", "at risk", "blocked", "stalled") and why.',
    '- If almost nothing has happened yet, say so in one sentence.',
    '',
    `=== PIPELINE SNAPSHOT ===`,
    pipelineSnapshot(ctx),
    '',
    '=== TASK LIST ===',
    taskLines.join('\n') || '- (no tasks)',
    '',
    '=== RECENT TASK OUTCOMES (newest first) ===',
    outcomeLines.join('\n') || '- (none finished yet)',
    '',
    `=== RECENT PROGRESS NOTES (${rel(paths.root, paths.progress)}) ===`,
    progress,
    '=== END OF SNAPSHOT ===',
  ].join('\n');
}

/** Append one check's result to the dedicated watch log. Never throws at the caller. */
export function appendWatchLog(paths: Paths, entry: WatchLogEntry): void {
  const file = watchLogPath(paths);
  try {
    ensureDir(dirname(file));
    const lines: string[] = [];
    if (!existsSync(file)) {
      lines.push('# Pipeline watch log', '', '_Periodic read-only summaries written by the symphony pipeline watcher. One section per check._', '');
    }
    lines.push(`## ${entry.at} · check #${entry.check}`);
    lines.push('');
    lines.push(`- provider: ${entry.provider}${entry.model ? ` · ${entry.model}` : ''}`);
    lines.push(`- pipeline: ${entry.pipeline}`);
    lines.push(`- result: ${entry.status}${entry.durationS !== undefined ? ` · ${fmtDuration(entry.durationS)}` : ''}${entry.costUsd !== undefined ? ` · ${fmtCost(entry.costUsd)}` : ''}`);
    if (entry.error) lines.push(`- error: ${entry.error}`);
    lines.push(`- session: ${entry.sessionLog} · raw: ${entry.sessionJsonl} · prompt: ${entry.sessionPrompt}`);
    lines.push('');
    lines.push(entry.summary?.trim() || '_(no summary produced)_');
    lines.push('');
    appendFileSync(file, `${lines.join('\n')}\n`);
  } catch {
    /* the watch log is advisory; a write failure must never affect the run */
  }
}

interface CheckResult {
  status: 'ready' | 'error';
  summary?: string;
  error?: string;
  costUsd?: number;
  durationS?: number;
  sessionLog: string;
  sessionJsonl: string;
  sessionPrompt: string;
}

/** Run one read-only watcher session and capture its answer. */
async function oneCheck(ctx: RunContext, spec: SessionSpec, provider: Provider): Promise<CheckResult> {
  ensureDir(ctx.paths.runs);
  const sinks = openRunSinks(ctx.paths.runs, `${WATCH_TASK_ID}-${stamp()}`);
  const prompt = buildWatchPrompt(ctx);
  writeFileSync(sinks.promptPath, prompt);
  const paths = {
    sessionLog: rel(ctx.paths.root, sinks.logPath),
    sessionJsonl: rel(ctx.paths.root, sinks.jsonlPath),
    sessionPrompt: rel(ctx.paths.root, sinks.promptPath),
  };
  const cmd = provider.buildCommand({
    bin: spec.bin, prompt, promptFile: sinks.promptPath, taskId: WATCH_TASK_ID, attempt: 1, kind: 'task',
    model: spec.model, variant: spec.variant, autoApprove: spec.autoApprove, extraArgs: spec.extraArgs, cwd: ctx.paths.root,
  });
  const session = startSession({
    spec: cmd, provider, cwd: ctx.paths.root,
    timeoutMs: spec.timeoutMin * 60_000,
    idleTimeoutMs: spec.idleTimeoutMin ? spec.idleTimeoutMin * 60_000 : 0,
    sinks, liveMaxChars: 200, logMaxChars: 4000, color: false,
    // The watcher's own stream stays out of the live output panel: its result goes to the panel and log.
    live: false,
  });
  let outcome: SessionOutcome;
  try {
    outcome = await session.done;
  } finally {
    await sinks.close();
  }
  const durationS = Math.round(outcome.durationMs / 1000);
  const summary = squash(outcome.result.text || outcome.allText, 800);
  const failed = !outcome.result.ok || outcome.interrupted || outcome.timedOut || outcome.stalled || !!outcome.spawnError;
  if (failed && !summary) {
    const error = outcome.spawnError ?? outcome.result.errorSubtype ?? (outcome.timedOut ? 'timeout' : outcome.stalled ? 'stalled' : 'no answer');
    return { status: 'error', error, durationS, costUsd: outcome.costUsd, ...paths };
  }
  if (!summary) return { status: 'error', error: 'session produced no answer', durationS, costUsd: outcome.costUsd, ...paths };
  return { status: 'ready', summary, durationS, costUsd: outcome.costUsd, ...paths };
}

/**
 * Owns the watcher timer and the in-flight session. `start()` arms the first check one interval out;
 * each check chains the next so a slow check never overlaps itself. `stop()` clears the timer and
 * interrupts a running check.
 */
export class PipelineWatcher {
  private timer?: NodeJS.Timeout;
  private session?: Session;
  private inFlight = false;
  private stopped = false;
  private checks = 0;

  constructor(private readonly ctx: RunContext, private readonly spec: SessionSpec, private readonly provider: Provider) {}

  private get intervalMs(): number {
    return Math.max(1, this.ctx.config.watch.intervalMin) * 60_000;
  }

  start(): void {
    this.ctx.abort.signal.addEventListener('abort', () => this.stop(), { once: true });
    this.arm(this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.session?.kill('interrupt');
  }

  /** Run a check now (the TUI's manual refresh) and re-arm the timer afterwards. */
  async checkNow(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.fire();
  }

  private arm(delayMs: number): void {
    if (this.stopped) return;
    const w = this.ctx.watch;
    if (w) w.nextAt = Date.now() + delayMs;
    this.timer = setTimeout(() => void this.fire(), delayMs);
    this.timer.unref?.();
  }

  private async fire(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.timer = undefined;
    this.inFlight = true;
    this.checks += 1;
    const w = this.ctx.watch;
    if (w) { w.status = 'running'; w.nextAt = undefined; }
    let result: CheckResult;
    try {
      result = await oneCheck(this.ctx, this.spec, this.provider);
    } catch (e) {
      result = { status: 'error', error: (e as Error).message, sessionLog: '-', sessionJsonl: '-', sessionPrompt: '-' };
    } finally {
      this.inFlight = false;
    }
    const state = this.ctx.watch;
    const entry: WatchLogEntry = {
      at: nowIso(), check: this.checks, provider: this.spec.providerName, model: this.spec.model,
      status: result.status, pipeline: pipelineSnapshot(this.ctx), summary: result.summary, error: result.error,
      durationS: result.durationS, costUsd: result.costUsd,
      sessionLog: result.sessionLog, sessionJsonl: result.sessionJsonl, sessionPrompt: result.sessionPrompt,
    };
    appendWatchLog(this.ctx.paths, entry);
    if (state && !this.stopped) {
      state.checks = this.checks;
      if (result.status === 'ready') {
        state.status = 'ready';
        state.summary = result.summary;
        state.updatedAt = entry.at;
        delete state.error;
      } else {
        state.status = 'error';
        state.error = result.error ?? 'check failed';
        // Keep the last good summary visible alongside the error.
      }
    }
    this.ctx.log.info(`watch #${this.checks}: ${result.status}${result.summary ? ` · ${squash(result.summary, 160)}` : result.error ? ` · ${result.error}` : ''}`);
    if (!this.stopped) this.arm(this.intervalMs);
  }
}

/**
 * Start the watcher for this run, or return undefined when it is off or cannot run. Fail-soft: a
 * missing watcher binary disables it with a warning (and an error panel) instead of halting the run.
 */
export function startPipelineWatch(ctx: RunContext): PipelineWatcher | undefined {
  const w: Config['watch'] = ctx.config.watch;
  if (!w?.enabled) return undefined;
  const provider = getProvider(w.provider);
  const { spec, warnings } = resolveWatch(ctx.config, variantSupported);
  warnings.forEach((m) => ctx.log.warn(`watch: ${m}`));
  const binary = resolveBinary(spec.bin, { env: process.env, cwd: ctx.paths.root });
  if (!existsSync(binary) && !resolveExecutable(spec.bin, process.env)) {
    const error = `watch provider binary not found (${spec.bin}); pipeline watch disabled`;
    ctx.watch = { status: 'error', enabled: true, intervalMin: w.intervalMin, provider: spec.providerName, model: spec.model, error, checks: 0 };
    ctx.log.warn(`watch: ${error}`);
    return undefined;
  }
  const watcher = new PipelineWatcher(ctx, spec, provider);
  ctx.watch = { status: 'waiting', enabled: true, intervalMin: w.intervalMin, provider: spec.providerName, model: spec.model, nextAt: Date.now() + w.intervalMin * 60_000, checks: 0 };
  ctx.watchRefresh = () => void watcher.checkNow();
  watcher.start();
  ctx.log.info(`watch: pipeline watch on · ${spec.providerName}${spec.model ? ` · ${spec.model}` : ''} every ${w.intervalMin} min → ${rel(ctx.paths.root, watchLogPath(ctx.paths))}`);
  return watcher;
}