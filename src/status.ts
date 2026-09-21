import type { Logger } from './logger.js';
import { patchRoadmapStatus } from './roadmap.js';
import type { Paths } from './paths.js';
import { DONE_STATES, type State, type TaskStatus } from './state.js';
import type { Task } from './tasks.js';
import { nowIso } from './util.js';

const ORDER: TaskStatus[] = ['done', 'accepted', 'blocked', 'failed', 'pending', 'running'];

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