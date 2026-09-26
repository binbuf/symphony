import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Paths } from './paths.js';
import { atomicWriteSync, nowIso } from './util.js';
import type { WatchState } from './watch.js';

/**
 * A small heartbeat a detached harness writes while it runs, so a client (`symphony attach`) can find
 * the live stream, the watch panel and the run's phase without sharing memory with the daemon. It is
 * advisory: a missing or stale file only makes `attach` fall back to `state.json` alone.
 */

export type RuntimePhase = 'starting' | 'running' | 'halted' | 'done' | 'stopped' | 'error';

export interface RuntimeState {
  pid: number;
  startedAt: string;
  updatedAt: string;
  phase: RuntimePhase;
  /** Task id in flight, if any. */
  currentTask?: string;
  /** Rendered stream log of the session in flight, relative to the project root. */
  stream?: string;
  /** Live pipeline-watch panel state; absent when the watcher is off. */
  watch?: WatchState;
  /** Queued pause target. */
  pauseAt?: string;
  /** Bumped whenever a split (automatic or requested) rewrote the plan. */
  planRevision: number;
  /** Exit code once the phase is terminal. */
  exitCode?: number;
  /** Short human-readable note, e.g. a halt reason or a split announcement. */
  note?: string;
}

export function runtimePath(paths: Paths): string {
  return join(paths.symphony, 'runtime.json');
}

export function readRuntime(paths: Paths): RuntimeState | undefined {
  const file = runtimePath(paths);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RuntimeState;
    if (!parsed || typeof parsed.pid !== 'number') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export interface RuntimeWriter {
  /** Merge a patch and flush it immediately (plus on the periodic tick). */
  update(patch: Partial<RuntimeState>): void;
  /** Flush and stop the timer. */
  stop(): void;
}

/** Start the heartbeat file, writing an initial state at once and refreshing it on a timer. */
export function startRuntimeWriter(paths: Paths, initial: Partial<RuntimeState> = {}, everyMs = 1000): RuntimeWriter {
  const state: RuntimeState = {
    pid: process.pid,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    phase: 'starting',
    planRevision: 0,
    ...initial,
  };
  const flush = (): void => {
    state.updatedAt = nowIso();
    try { atomicWriteSync(runtimePath(paths), `${JSON.stringify(state, null, 2)}\n`); } catch { /* advisory */ }
  };
  flush();
  const timer = setInterval(flush, everyMs);
  timer.unref?.();
  return {
    update: (patch) => { Object.assign(state, patch); flush(); },
    stop: () => { clearInterval(timer); flush(); },
  };
}