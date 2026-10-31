import { dirname, join } from 'node:path';
import type { Paths } from './paths.js';
import type { State, TaskState } from './state.js';
import type { Task } from './tasks.js';
import { atomicWriteSync, ensureDir, nowIso } from './util.js';

/**
 * The attention queue: everything the pipeline has deliberately stopped on and a human needs to
 * resolve. It is derived from durable state, not from a separate mutable list, so it cannot drift:
 * every run writes a snapshot to `.symphony/attention.json` for supervisors, and `symphony attention`
 * computes the same view on demand.
 */

export type AttentionKind = 'halt' | 'pending_human' | 'inconclusive' | 'judge_unavailable' | 'blocked' | 'failed';

export interface AttentionItem {
  /** Stable identity for a supervisor/diff: `<task>:<kind>` or `halt`. */
  id: string;
  taskId?: string;
  title: string;
  kind: AttentionKind;
  severity: 'blocking' | 'advisory';
  reason: string;
  since?: string;
  actions: string[];
}

export function attentionPath(paths: Paths): string {
  return join(dirname(paths.state), 'attention.json');
}

/** Derive the current attention queue from state. Pure: reads no files and writes nothing. */
export function collectAttention(state: State, tasks: Task[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (state.halted) {
    items.push({
      id: 'halt',
      title: 'Run halted',
      kind: 'halt',
      severity: 'blocking',
      reason: `${state.halted.category}: ${state.halted.reason}`,
      since: state.halted.at,
      actions: ['symphony clear-halt', 'symphony run --clear-halt --retry'],
    });
  }

  for (const task of tasks) {
    const st = state.tasks[task.id];
    if (!st) continue;
    const item = itemFor(task, st);
    if (item) items.push(item);
  }
  return items;
}

function itemFor(task: Task, st: TaskState): AttentionItem | undefined {
  const base = {
    taskId: task.id,
    title: task.title,
    since: st.finished ?? st.started,
  };
  if (st.status === 'blocked') {
    if (st.acceptance?.status === 'pending_human') {
      const pending = st.acceptance.criteria.filter((c) => c.status === 'pending_human').map((c) => c.id);
      const actions = pending.length
        ? pending.map((id) => `symphony approve ${task.id} ${id} --by "<name>"`)
        : [`symphony approve ${task.id}`];
      actions.push(`symphony run --retry --only ${task.id}`);
      return {
        ...base,
        id: `${task.id}:pending_human`,
        kind: 'pending_human',
        severity: 'blocking',
        reason: `acceptance is waiting for human approval${pending.length ? ` (${pending.join(', ')})` : ''}`,
        actions,
      };
    }
    if (st.acceptance?.status === 'inconclusive') {
      return {
        ...base,
        id: `${task.id}:inconclusive`,
        kind: 'inconclusive',
        severity: 'blocking',
        reason: st.summary ?? 'acceptance evidence is missing or unstable',
        actions: [
          'inspect the evidence under .symphony/evidence/',
          `symphony run --retry --only ${task.id}`,
        ],
      };
    }
    if (st.judge?.verdict === 'unavailable') {
      return {
        ...base,
        id: `${task.id}:judge_unavailable`,
        kind: 'judge_unavailable',
        severity: 'blocking',
        reason: `judge is required but unavailable: ${st.judge.reason ?? st.judge.summary}`,
        actions: [
          'fix the judge provider/model or key, or set judge.required false',
          `symphony run --retry --only ${task.id}`,
        ],
      };
    }
    return {
      ...base,
      id: `${task.id}:blocked`,
      kind: 'blocked',
      severity: 'blocking',
      reason: st.summary ?? 'the task reported blocked',
      actions: [
        'review the Hand-off in the task file',
        `symphony accept ${task.id} --note "<why>"`,
        `symphony run --retry --only ${task.id}`,
      ],
    };
  }
  if (st.status === 'failed') {
    return {
      ...base,
      id: `${task.id}:failed`,
      kind: 'failed',
      severity: 'blocking',
      reason: st.summary ?? st.lastError?.message ?? 'the task failed',
      actions: [
        'fix the cause named above',
        `symphony run --retry --only ${task.id}`,
        `symphony reset ${task.id}`,
      ],
    };
  }
  return undefined;
}

/** Write the current queue for supervisors. Best-effort: attention is advisory, never a run blocker. */
export function writeAttention(paths: Paths, items: AttentionItem[]): void {
  try {
    const file = attentionPath(paths);
    ensureDir(dirname(file));
    atomicWriteSync(file, `${JSON.stringify({ at: nowIso(), items }, null, 2)}\n`);
  } catch {
    /* the snapshot is advisory */
  }
}

export function formatAttention(items: AttentionItem[]): string[] {
  if (!items.length) return ['attention: nothing waiting'];
  const lines = [`attention: ${items.length} item${items.length === 1 ? '' : 's'}`];
  for (const item of items) {
    lines.push('');
    lines.push(`${item.taskId ?? 'run'}  ${item.kind}  ${item.title}`);
    lines.push(`  ${item.reason}`);
    for (const action of item.actions) lines.push(`  → ${action}`);
  }
  return lines;
}
