import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Paths } from './paths.js';
import { statusFromMarkers, type Roadmap } from './roadmap.js';
import { UsageError, atomicWriteSync, ensureDir, isRecord, nowIso } from './util.js';

export type TaskStatus = 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'accepted';
export const DONE_STATES: TaskStatus[] = ['done', 'accepted'];
export const SKIP_STATES: TaskStatus[] = ['done', 'accepted', 'blocked'];

export interface LogRef { kind: 'task' | 'retry' | 'nudge'; jsonl: string; log: string; prompt: string }

export interface LastError { category: string; message: string; transient: boolean; fatal: boolean; at: string }

export interface TaskState {
  title: string;
  status: TaskStatus;
  attempts: number;
  nudged?: boolean;
  started?: string;
  finished?: string;
  durationS: number;
  costUsd?: number;
  sessionId?: string;
  provider?: string;
  model?: string;
  pid?: number;
  summary?: string;
  lastError?: LastError;
  commit?: string;
  logs: LogRef[];
  accepted?: { at: string; from: TaskStatus; note?: string };
  reconciled?: boolean;
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
    row.title = b.title;
    if (b.check === 'x' && (row.status === 'pending' || row.status === 'failed' || row.status === 'running')) {
      row.status = implied === 'accepted' ? 'accepted' : 'done';
      row.reconciled = true;
      row.summary = row.summary ? `${row.summary} | ticked in ROADMAP.md` : 'ticked in ROADMAP.md';
      notes.push(`${b.id}: ROADMAP.md is [x] but state was ${row.status}; honouring the tick`);
    }
  }
  return notes;
}

export interface Lock { pid: number; startedAt: string }

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
  return l && l.pid !== process.pid && pidAlive(l.pid) ? l : undefined;
}

export function acquireLock(paths: Paths): void {
  const live = liveLock(paths);
  if (live) throw new UsageError(`another symphony run is active (pid ${live.pid}, started ${live.startedAt}). Wait for it or remove ${paths.lock} if it is stale.`);
  ensureDir(paths.symphony);
  writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: nowIso() } satisfies Lock));
}

export function releaseLock(paths: Paths): void {
  const l = readLock(paths);
  if (l && l.pid === process.pid) { try { unlinkSync(paths.lock); } catch { /* ignore */ } }
}
