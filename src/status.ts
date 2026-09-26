import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { addUsage } from './providers/common.js';
import type { TokenUsage } from './providers/types.js';
import { patchRoadmapStatus } from './roadmap.js';
import type { Paths } from './paths.js';
import { DONE_STATES, type State, type TaskState, type TaskStatus } from './state.js';
import type { Task } from './tasks.js';
import { fmtCost, fmtDateTime, fmtDuration, nowIso, squash, squashTail, type TimeZone } from './util.js';

const ORDER: TaskStatus[] = ['done', 'accepted', 'blocked', 'failed', 'pending', 'running'];

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Time a still-running task has spent so far: its finished sessions plus the one in flight. */
export function runningSeconds(s: TaskState | undefined): number {
  const base = s?.durationS ?? 0;
  if (!s?.started) return base;
  const started = Date.parse(s.started);
  if (!Number.isFinite(started)) return base;
  return base + Math.max(0, Math.round((Date.now() - started) / 1000));
}

/** The start stamp, computed end stamp and duration of one recorded session run (in flight included). */
function runTiming(l: { started?: string; durationS?: number }, running: boolean, tz: TimeZone): { start: string; end: string; duration: string } {
  const started = l.started ? Date.parse(l.started) : NaN;
  const seconds = l.durationS ?? (running && Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : undefined);
  const end = Number.isFinite(started) && seconds !== undefined ? new Date(started + seconds * 1000).toISOString() : undefined;
  return { start: fmtDateTime(l.started, tz), end: fmtDateTime(end, tz), duration: fmtDuration(seconds) };
}

export interface StatusSummary {
  done: number;
  total: number;
  costUsd: number;
  /** Token usage summed across tasks, when any provider reported it. */
  usage?: TokenUsage;
  durationS: number;
  blocked: string[];
  /** The task currently in flight and how long it has been running. */
  running?: { id: string; elapsedS: number };
}

/**
 * The per-task progress table as plain cells, so `status` prints it and the TUI renders it. A task
 * split across sessions or retried (attempts >= 2) contributes one child row per session beneath its
 * parent, each with its own start/end, duration, provider/model and summary.
 */
export interface StatusTable {
  head: string[];
  rows: string[][];
  /** Task id behind each row (a child row names its parent task). */
  rowTask: string[];
  /** Row index of each task's parent line, for selection and scrolling. */
  taskRow: Record<string, number>;
  summary: StatusSummary;
}

export interface StatusTableOptions {
  /** Skip every per-cell cap so the full text is available to a horizontally scrolling renderer. */
  expand?: boolean;
  /** Zone for the start/end stamps; defaults to the machine's local zone. */
  timeZone?: TimeZone;
}

export function buildStatusTable(tasks: Task[], state: State, opts: StatusTableOptions = {}): StatusTable {
  // Expanded mode disables the caps; a cap of Infinity still collapses whitespace but never truncates.
  const cap = (max: number) => (opts.expand ? Number.POSITIVE_INFINITY : max);
  const tz = opts.timeZone ?? 'local';
  const rows: string[][] = [];
  const rowTask: string[] = [];
  const taskRow: Record<string, number> = {};
  for (const t of tasks) {
    const s = state.tasks[t.id];
    const status = s?.status ?? 'pending';
    const running = status === 'running';
    const shown = running && s?.pid && !pidAlive(s.pid) ? 'running?' : status;
    const time = running ? `${fmtDuration(runningSeconds(s))} (running)` : fmtDuration(s?.durationS || undefined);
    // The parent line spans the whole task: the first session's start through the finish, with the
    // accumulated duration and the final summary.
    const start = s?.logs?.[0]?.started ?? s?.started;
    taskRow[t.id] = rows.length;
    rows.push([t.id, squash(t.phase, cap(18)), squash(t.title, cap(42)), shown, String(s?.attempts ?? 0), time, fmtDateTime(start, tz), fmtDateTime(s?.finished, tz), fmtCost(s?.costUsd), s?.provider ?? '', squashTail(s?.model ? `${s.model}${s.variant ? `#${s.variant}` : ''}` : '', cap(28)), squash(s?.summary ?? '', cap(60))]);
    rowTask.push(t.id);
    // A task split across sessions or retried (att >= 2) gets one child line per session, so each
    // round reports its own start/end, duration and summary instead of only the task's running total.
    if ((s?.attempts ?? 0) >= 2 && s?.logs?.length) {
      s.logs.forEach((l, i) => {
        const run = runTiming(l, running, tz);
        const label = `run ${i + 1} · ${l.kind}`;
        // The session's own provider and model, so an escalated run is visible in the table too.
        rows.push(['  ↳', '', squash(label, cap(42)), l.status ?? '', '', run.duration, run.start, run.end, fmtCost(l.costUsd), squash(l.provider ?? '', cap(16)), squashTail(l.model ? `${l.model}${l.variant ? `#${l.variant}` : ''}` : '', cap(28)), squash(l.summary ?? '', cap(60))]);
        rowTask.push(t.id);
      });
    }
  }
  const head = ['id', 'phase', 'title', 'status', 'att', 'duration', 'start', 'end', 'cost', 'provider', 'model', 'summary'];
  const done = tasks.filter((t) => DONE_STATES.includes(state.tasks[t.id]?.status ?? 'pending')).length;
  const costUsd = tasks.reduce((a, t) => a + (state.tasks[t.id]?.costUsd ?? 0), 0);
  const usage = tasks.reduce<TokenUsage | undefined>((a, t) => addUsage(a, state.tasks[t.id]?.usage), undefined);
  const durationS = tasks.reduce((a, t) => {
    const s = state.tasks[t.id];
    return a + (s?.status === 'running' ? runningSeconds(s) : s?.durationS ?? 0);
  }, 0);
  const blocked = tasks.filter((t) => state.tasks[t.id]?.status === 'blocked').map((t) => t.id);
  const active = tasks.find((t) => state.tasks[t.id]?.status === 'running');
  return {
    head,
    rows,
    rowTask,
    taskRow,
    summary: {
      done,
      total: tasks.length,
      costUsd,
      usage,
      durationS,
      blocked,
      running: active ? { id: active.id, elapsedS: runningSeconds(state.tasks[active.id]) } : undefined,
    },
  };
}

/** Column widths for a table, so a renderer can align the header and every row. */
export function statusColumnWidths(table: StatusTable): number[] {
  return table.head.map((h, i) => Math.max(h.length, ...table.rows.map((r) => r[i].length)));
}

/** One table row as a fixed-width string, columns padded except the trailing summary. */
export function formatStatusRow(row: string[], widths: number[]): string {
  return row.map((c, i) => (i === widths.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
}

function idsFor(tasks: Task[], state: State, pick: (s: TaskStatus) => boolean): string {
  const out = tasks.filter((t) => pick(state.tasks[t.id]?.status ?? 'pending')).map((t) => t.id);
  return out.length ? out.join(', ') : 'none';
}

/** The high-level pipeline snapshot the harness keeps in ROADMAP.md, regenerated after every task. */
export function buildPipelineStatus(tasks: Task[], state: State, updatedAt = nowIso()): string {
  const statusOf = (t: Task) => state.tasks[t.id]?.status ?? 'pending';
  const done = tasks.filter((t) => (DONE_STATES as string[]).includes(statusOf(t))).length;
  const remaining = tasks.filter((t) => (ORDER.indexOf(statusOf(t)) >= 4)).map((t) => t.id);
  const last = [...tasks].reverse().find((t) => state.tasks[t.id]?.finished);

  const lines = [
    `**Pipeline status** — updated ${updatedAt} · ${done}/${tasks.length} done`,
    '',
    `- Completed: ${idsFor(tasks, state, (s) => (DONE_STATES as string[]).includes(s))}`,
    `- Blocked: ${idsFor(tasks, state, (s) => s === 'blocked')}`,
    `- Failed: ${idsFor(tasks, state, (s) => s === 'failed')}`,
    `- Remaining: ${remaining.join(', ') || 'none'}`,
  ];
  if (last) {
    const st = state.tasks[last.id];
    lines.push(`- Last finished: ${last.id} — ${st?.status ?? 'pending'}${st?.summary ? ` · ${st.summary}` : ''}`);
  }
  if (state.halted) lines.push(`- Halted: ${state.halted.category}${state.halted.taskId ? ` on ${state.halted.taskId}` : ''} — ${state.halted.reason}`);
  return lines.join('\n');
}

/** Regenerate the ROADMAP.md pipeline status block. Never fatal: a failure only warns. */
export function updatePipelineStatus(paths: Paths, tasks: Task[], state: State, log?: Logger): void {
  if (!tasks.length) return;
  try {
    patchRoadmapStatus(paths.roadmap, buildPipelineStatus(tasks, state));
  } catch (e) {
    log?.warn(`could not update the ROADMAP.md status block: ${(e as Error).message}`);
  }
}