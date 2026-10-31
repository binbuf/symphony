import type { Config, SchedulingStrategy } from './config.js';
import type { TaskContract } from './graph.js';
import type { Task } from './tasks.js';

/**
 * Deterministic ready-task scheduling. Dependencies are never violated: this is a topological sort
 * whose tie-breaker is chosen by config, not an LLM planner. Off by default, so a normal run keeps
 * strict roadmap order.
 */

export interface ScheduledEntry {
  task: Task;
  /** Effective priority (higher runs first under the `priority` strategy). */
  priority: number;
  /** How many selected tasks directly or transitively depend on this one. */
  unlocks: number;
  /** Why this position/order was chosen, for `symphony schedule` and the run log. */
  reason: string;
}

export interface SchedulePlan {
  strategy: SchedulingStrategy;
  entries: ScheduledEntry[];
  /** Tasks left out because the graph has a cycle; callers validate and report separately. */
  unresolved: Task[];
}

function priorityOf(task: Task): number {
  const raw = (task.meta.priority ?? task.meta.weight ?? '').trim().toLowerCase();
  if (!raw) return 2;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  if (raw === 'urgent') return 4;
  if (raw === 'high' || raw === 'p0' || raw === 'p1') return 3;
  if (raw === 'low' || raw === 'p3' || raw === 'p4') return 1;
  if (raw === 'blocker' || raw === 'critical') return 4;
  return 2;
}

/** Transitive dependent count within the selected set. */
function unlockCounts(tasks: Task[], contracts: Map<string, TaskContract>): Map<string, number> {
  const known = new Set(tasks.map((t) => t.id));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of contracts.get(task.id)?.dependsOn ?? []) {
      if (!known.has(dep)) continue;
      const list = dependents.get(dep) ?? [];
      list.push(task.id);
      dependents.set(dep, list);
    }
  }
  const out = new Map<string, number>();
  for (const task of tasks) {
    const seen = new Set<string>();
    const stack = [...(dependents.get(task.id) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(dependents.get(id) ?? []));
    }
    out.set(task.id, seen.size);
  }
  return out;
}

function comparator(strategy: SchedulingStrategy): (a: ScheduledEntry, b: ScheduledEntry) => number {
  return (a, b) => {
    if (strategy === 'priority') {
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (a.unlocks !== b.unlocks) return b.unlocks - a.unlocks;
    } else if (strategy === 'critical-path') {
      if (a.unlocks !== b.unlocks) return b.unlocks - a.unlocks;
      if (a.priority !== b.priority) return b.priority - a.priority;
    }
    return a.task.order - b.task.order;
  };
}

function describe(strategy: SchedulingStrategy, entry: Omit<ScheduledEntry, 'reason'>): string {
  const bits: string[] = [];
  if (strategy !== 'roadmap') bits.push(`priority ${entry.priority}`);
  if (strategy === 'critical-path' || entry.unlocks > 0) bits.push(`unblocks ${entry.unlocks}`);
  bits.push(`roadmap #${entry.task.order + 1}`);
  return bits.join(', ');
}

/**
 * Order tasks with dependency edges first and the configured tie-breaker second. Ready tasks are
 * selected one at a time (Kahn), so a low-priority prerequisite still runs before its consumer.
 */
export function scheduleTasks(config: Config, tasks: Task[], contracts: Map<string, TaskContract>): SchedulePlan {
  const strategy = config.scheduling.enabled ? config.scheduling.strategy : 'roadmap';
  const known = new Set(tasks.map((t) => t.id));
  const unlocks = unlockCounts(tasks, contracts);
  const remaining = new Map(tasks.map((t) => [t.id, t]));
  const placed = new Set<string>();
  const entries: ScheduledEntry[] = [];
  const compare = comparator(strategy);

  while (remaining.size) {
    const ready: ScheduledEntry[] = [];
    for (const task of remaining.values()) {
      const deps = (contracts.get(task.id)?.dependsOn ?? []).filter((d) => known.has(d) && !placed.has(d));
      if (deps.length) continue;
      const base = { task, priority: priorityOf(task), unlocks: unlocks.get(task.id) ?? 0 };
      ready.push({ ...base, reason: describe(strategy, base) });
    }
    if (!ready.length) break;
    ready.sort(compare);
    const next = ready[0];
    entries.push(next);
    placed.add(next.task.id);
    remaining.delete(next.task.id);
  }

  // A cycle leaves the rest unresolved; the caller's contract validation reports it.
  const unresolved = [...remaining.values()].sort((a, b) => a.order - b.order);
  return { strategy, entries, unresolved };
}
