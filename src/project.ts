import { readFileSync } from 'node:fs';
import type { Logger } from './logger.js';
import type { Paths } from './paths.js';
import { parseRoadmap, patchRoadmapFile, type Roadmap } from './roadmap.js';
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
