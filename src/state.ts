import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Paths } from './paths.js';
import { statusFromMarkers, type Roadmap } from './roadmap.js';
import { UsageError, atomicWriteSync, ensureDir, isRecord, nowIso } from './util.js';

export type TaskStatus = 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'accepted';
export const DONE_STATES: TaskStatus[] = ['done', 'accepted'];
export const SKIP_STATES: TaskStatus[] = ['done', 'accepted', 'blocked'];
/** Statuses a task holds after running and that `run` will not revisit without `--retry`/`accept`. */
export const HELD_STATES: TaskStatus[] = ['done', 'accepted', 'blocked'];

export interface LogRef {
  kind: 'task' | 'retry' | 'nudge';
  jsonl: string;
  log: string;
  prompt: string;
  /** Reported result status for this session (done/continue/blocked/failed) or the failure category. */
  status?: string;
  /** One-line high-level summary the session reported. */
  summary?: string;
  started?: string;
  durationS?: number;
  costUsd?: number;
  /** Provider/model that ran this session; differs from the task-level pair when a task escalates. */
  provider?: string;
  model?: string;
  /** Reasoning-effort / variant that ran this session, when the provider has one. */
  variant?: string;
}

export interface LastError { category: string; message: string; transient: boolean; fatal: boolean; at: string }

export interface TaskState {
  title: string;
  status: TaskStatus;
  attempts: number;
  nudged?: boolean;
  /**
   * Continuation sessions already accounted for on this task. Persisted so that pausing at a
   * continuation boundary (STOP sentinel) resumes as the next continuation, not a fresh task.
   * Cleared when the task reaches a terminal state.
   */
  continuation?: number;
  started?: string;
  finished?: string;
  durationS: number;
  costUsd?: number;
  sessionId?: string;
  provider?: string;
  model?: string;
  variant?: string;
  pid?: number;
  summary?: string;
  lastError?: LastError;
  commit?: string;
  /** Full commit hash of the task's final commit, if any (for `reset --revert`). */
  commitSha?: string;
  /** Result of the harness-run verify command after the task reported done. */
  verify?: { command: string; ok: boolean; code?: number; output?: string; at: string };
  logs: LogRef[];
  accepted?: { at: string; from: TaskStatus; note?: string };
  reconciled?: boolean;
  /** A roadmap bullet that now titles a held task differently (possible id reuse); `title` keeps what it ran as. */
  titleMismatch?: string;
}

export interface Halted { at: string; taskId?: string; category: string; reason: string }

export interface State {
  version: 1;
  halted?: Halted;
  tasks: Record<string, TaskState>;
}

export function newTaskState(title: string): TaskState {
  return { title, status: 'pending', attempts: 0, durationS: 0, logs: [] };
}

export function loadState(paths: Paths): State {
  if (!existsSync(paths.state)) return { version: 1, tasks: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.state, 'utf8'));
  } catch (e) {
    throw new UsageError(`${paths.state} is not valid JSON (${(e as Error).message}). Fix or move it aside; the harness will rebuild progress from ROADMAP.md markers.`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.tasks)) throw new UsageError(`${paths.state}: unexpected shape`);
  const tasks: Record<string, TaskState> = {};
  for (const [id, v] of Object.entries(parsed.tasks)) {
    if (!isRecord(v)) continue;
    tasks[id] = { ...newTaskState(String(v.title ?? id)), ...(v as Partial<TaskState>), logs: Array.isArray(v.logs) ? (v.logs as LogRef[]) : [] };
  }
  return { version: 1, halted: isRecord(parsed.halted) ? (parsed.halted as unknown as Halted) : undefined, tasks };
}

export function saveState(paths: Paths, state: State): void {
  ensureDir(paths.symphony);
  atomicWriteSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Fill gaps in state from ROADMAP.md markers (fresh clone / deleted state.json) and honour a human
 * ticking a box. Returns human-readable notes. Where state has a terminal status and the roadmap
 * disagrees, state wins; the caller re-patches the bullet.
 */
export function reconcile(state: State, roadmap: Roadmap): string[] {
  const notes: string[] = [];
  for (const b of roadmap.bullets) {
    const implied = statusFromMarkers(b);
    const row = state.tasks[b.id];
    if (!row) {
      if (implied === 'pending') continue;
      const st: TaskState = { ...newTaskState(b.title), reconciled: true, summary: `reconciled from ROADMAP.md marker` };
      if (implied === 'running') {
        st.status = 'failed';
        st.summary = 'found "⟵ running" in ROADMAP.md with no state (previous harness crashed?)';
      } else {
        st.status = implied;
      }
      state.tasks[b.id] = st;
      notes.push(`${b.id}: no state row; set ${st.status} from ROADMAP.md`);
      continue;
    }
    // A held task keeps the title it actually ran under: that is the evidence a reused id means new
    // work. Only a task that will run again may be re-titled in place.
    if (row.title && row.title !== b.title && HELD_STATES.includes(row.status)) {
      if (row.titleMismatch !== b.title) {
        row.titleMismatch = b.title;
        notes.push(`${b.id}: ROADMAP.md titles this "${b.title}" but it ran as "${row.title}" (${row.status}); keeping the recorded title. If this is different work, reset it or run \`symphony replan\`.`);
      }
    } else {
      row.title = b.title;
      delete row.titleMismatch;
    }
    if (b.check === 'x' && (row.status === 'pending' || row.status === 'failed' || row.status === 'running')) {
      row.status = implied === 'accepted' ? 'accepted' : 'done';
      row.reconciled = true;
      row.summary = row.summary ? `${row.summary} | ticked in ROADMAP.md` : 'ticked in ROADMAP.md';
      notes.push(`${b.id}: ROADMAP.md is [x] but state was ${row.status}; honouring the tick`);
    }
  }
  return notes;
}

export interface Lock { pid: number; startedAt: string; heartbeat?: string }

/** A lock whose heartbeat has not moved for this long is treated as stale even if the pid is alive. */
export const LOCK_STALE_MS = 5 * 60_000;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function readLock(paths: Paths): Lock | undefined {
  if (!existsSync(paths.lock)) return undefined;
  try {
    const l = JSON.parse(readFileSync(paths.lock, 'utf8')) as Lock;
    return typeof l.pid === 'number' ? l : undefined;
  } catch { return undefined; }
}

export function liveLock(paths: Paths): Lock | undefined {
  const l = readLock(paths);
  if (!l || l.pid === process.pid || !pidAlive(l.pid)) return undefined;
  // Guard against pid reuse: a live pid whose lock has not been refreshed for a long time is stale.
  const seen = Date.parse(l.heartbeat ?? l.startedAt);
  if (Number.isFinite(seen) && Date.now() - seen > LOCK_STALE_MS) return undefined;
  return l;
}

export function acquireLock(paths: Paths): void {
  const live = liveLock(paths);
  if (live) throw new UsageError(`another symphony run is active (pid ${live.pid}, started ${live.startedAt}). Wait for it or remove ${paths.lock} if it is stale.`);
  ensureDir(paths.symphony);
  writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: nowIso(), heartbeat: nowIso() } satisfies Lock));
}

/** Refresh the lock's heartbeat if we own it. */
export function heartbeatLock(paths: Paths): void {
  const l = readLock(paths);
  if (!l || l.pid !== process.pid) return;
  try { writeFileSync(paths.lock, JSON.stringify({ ...l, heartbeat: nowIso() } satisfies Lock)); } catch { /* ignore */ }
}

/** Keep the lock's heartbeat fresh while a run is active. Returns a stop function. */
export function startLockHeartbeat(paths: Paths, everyMs = 15_000): () => void {
  const t = setInterval(() => heartbeatLock(paths), everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

export function releaseLock(paths: Paths): void {
  const l = readLock(paths);
  if (l && l.pid === process.pid) { try { unlinkSync(paths.lock); } catch { /* ignore */ } }
}
