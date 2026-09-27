import { readFileSync } from 'node:fs';
import type { Logger } from './logger.js';
import type { Paths } from './paths.js';
import { canonicalId, parseRoadmap, patchRoadmapFile, type Roadmap } from './roadmap.js';
import type { RunContext, RunFlags } from './runner.js';
import { loadState, reconcile, saveState, type State } from './state.js';
import { discoverTasks, type Task } from './tasks.js';
import { fileExists } from './util.js';

export interface Loaded {
  paths: Paths;
  roadmap: Roadmap;
  tasks: Task[];
  state: State;
  warnings: string[];
  /** Set when ROADMAP.md is missing or does not parse; the other fields are then empty. */
  roadmapError?: string;
}

/**
 * Read a project's plan and harness state: ROADMAP.md, its task files and state.json, reconciled so
 * state is authoritative for terminal statuses. Used by the CLI for every command and by the run view
 * when it must reload the plan after a TUI-driven `split`.
 */
export function loadProject(paths: Paths, log: Logger): Loaded {
  const state = loadState(paths);
  if (!fileExists(paths.roadmap)) return { paths, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [], state, warnings: [], roadmapError: `${paths.roadmap} missing (run: symphony init)` };
  let roadmap: Roadmap;
  try {
    roadmap = parseRoadmap(readFileSync(paths.roadmap, 'utf8'));
  } catch (e) {
    return { paths, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [], state, warnings: [], roadmapError: (e as Error).message };
  }
  const { tasks, warnings } = discoverTasks(paths, roadmap);
  const notes = reconcile(state, roadmap);
  if (notes.length) { notes.forEach((n) => log.info(`reconcile: ${n}`)); saveState(paths, state); }
  // State is authoritative for terminal statuses: make the roadmap markers agree.
  for (const t of tasks) {
    const st = state.tasks[t.id];
    if (!st) continue;
    try { if (patchRoadmapFile(paths.roadmap, t.id, st.status) === 'patched') log.info(`roadmap: ${t.id} marker set to ${st.status} from state`); } catch { /* reported by run */ }
  }
  return { paths, roadmap, tasks, state, warnings };
}

/**
 * Point a run's task selection at the subtasks that replaced a split parent, so `--only`/`--from`/
 * `--to` keep meaning the same work after an automatic breakdown rewrote the plan mid-run.
 */
export function retargetFlags(flags: RunFlags, parentId: string, childIds: string[]): void {
  if (flags.only?.length) {
    flags.only = flags.only.flatMap((raw) => (canonicalId(raw) === parentId ? childIds : [raw]));
  }
  if (flags.from && canonicalId(flags.from) === parentId && childIds.length) flags.from = childIds[0];
  if (flags.to && canonicalId(flags.to) === parentId && childIds.length) flags.to = childIds[childIds.length - 1];
}

/**
 * Drop run-selection flags that name tasks no longer in the roadmap after an automatic replan, so
 * the rebuilt queue cannot throw on a stale `--from`/`--to`/`--only` id.
 */
export function sanitizeFlags(flags: RunFlags, tasks: Task[], warn: (m: string) => void): void {
  const ids = new Set(tasks.map((t) => t.id));
  if (flags.only?.length) {
    const kept = flags.only.filter((raw) => ids.has(canonicalId(raw) ?? ''));
    if (kept.length !== flags.only.length) warn(`--only: dropped ${flags.only.length - kept.length} id(s) that are no longer in the roadmap`);
    flags.only = kept.length ? kept : undefined;
  }
  if (flags.from && !ids.has(canonicalId(flags.from) ?? '')) {
    warn(`--from ${flags.from}: no longer in the roadmap; running from the start`);
    flags.from = undefined;
  }
  if (flags.to && !ids.has(canonicalId(flags.to) ?? '')) {
    warn(`--to ${flags.to}: no longer in the roadmap; running to the end`);
    flags.to = undefined;
  }
}

/**
 * Adopt a freshly loaded plan on a live run context. The state's `tasks`/`halted` are updated in
 * place, so closures that already hold the state object (the run loop, the run view) keep seeing the
 * live rows instead of a stale snapshot.
 */
export function applyPlan(ctx: RunContext, loaded: Loaded): void {
  ctx.roadmap = loaded.roadmap;
  ctx.tasks = loaded.tasks;
  ctx.state.tasks = loaded.state.tasks;
  ctx.state.halted = loaded.state.halted;
}
