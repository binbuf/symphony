import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import type { Paths } from './paths.js';
import { progressTrend } from './progress.js';
import { DONE_STATES, type State } from './state.js';
import type { Task } from './tasks.js';
import { atomicWriteSync, ensureDir, nowIso } from './util.js';

/**
 * Deterministic supervisor. It reads durable state and flags the exceptions that need a human or a
 * closer look. The model-backed watcher is only an optional escalation for an exception this module
 * has already identified; it never decides run behaviour, and ordinary progress is left alone.
 */

export type SupervisorAction = 'none' | 'watch' | 'attention' | 'halt';
export type SupervisorSignalKind = 'halt' | 'attention' | 'slow' | 'repeated' | 'stalled';

export interface SupervisorSignal {
  kind: SupervisorSignalKind;
  taskId?: string;
  reason: string;
}

export interface SupervisorDecision {
  at: string;
  action: SupervisorAction;
  reason: string;
  signals: SupervisorSignal[];
  /** The task the decision is about, when it concerns one task. */
  taskId?: string;
}

export interface SuperviseInput {
  state: State;
  tasks: Task[];
  config: Config;
  /** Epoch ms; injectable for tests. */
  now?: number;
}

function elapsedMin(started: string | undefined, now: number): number | undefined {
  if (!started) return undefined;
  const t = Date.parse(started);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 60_000) : undefined;
}

/** Collect every deterministic exception signal, most severe first. Pure and testable. */
export function collectSupervisorSignals(input: SuperviseInput): SupervisorSignal[] {
  const { state, tasks, config } = input;
  const now = input.now ?? Date.now();
  const signals: SupervisorSignal[] = [];
  if (state.halted) {
    signals.push({ kind: 'halt', reason: `${state.halted.category}: ${state.halted.reason}` });
  }

  for (const task of tasks) {
    const st = state.tasks[task.id];
    if (!st || DONE_STATES.includes(st.status)) continue;

    if (st.status === 'blocked' || st.status === 'failed' || st.phase === 'needs_attention') {
      signals.push({ kind: 'attention', taskId: task.id, reason: st.summary ?? `task is ${st.status}` });
      continue;
    }
    if (st.acceptance?.status === 'pending_human' || st.acceptance?.status === 'inconclusive') {
      signals.push({ kind: 'attention', taskId: task.id, reason: `acceptance ${st.acceptance.status}` });
      continue;
    }
    if (st.judge?.verdict === 'unavailable') {
      signals.push({ kind: 'attention', taskId: task.id, reason: `judge unavailable: ${st.judge.reason ?? st.judge.summary}` });
      continue;
    }

    if (st.status !== 'running') continue;
    const minutes = elapsedMin(st.started, now);
    if (minutes !== undefined && minutes >= config.supervisor.slowAfterMin) {
      signals.push({ kind: 'slow', taskId: task.id, reason: `running for ${Math.round(minutes)} min (slowAfterMin ${config.supervisor.slowAfterMin})` });
    }
    if (st.attempts >= 2) {
      signals.push({ kind: 'repeated', taskId: task.id, reason: `attempt ${st.attempts} on this task` });
    }
    if (st.attempts >= 2 && (st.deltas?.length ?? 0) >= 2) {
      const trend = progressTrend(st.deltas!, config.metric.direction);
      if (trend === 'flat' || trend === 'regressing') {
        signals.push({ kind: 'stalled', taskId: task.id, reason: `observable progress is ${trend} across ${st.deltas!.length} attempts` });
      }
    }
  }
  return signals;
}

const KIND_ORDER: SupervisorSignalKind[] = ['halt', 'attention', 'stalled', 'repeated', 'slow'];

/** Turn the signals into the one action the caller should take. Deterministic and total. */
export function decideSupervision(input: SuperviseInput): SupervisorDecision {
  const signals = collectSupervisorSignals(input);
  const strongest = [...signals].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))[0];
  if (!strongest) return { at: nowIso(), action: 'none', reason: 'no exception', signals, };
  const action: SupervisorAction = strongest.kind === 'halt'
    ? 'halt'
    : strongest.kind === 'attention'
      ? 'attention'
      : 'watch';
  return {
    at: nowIso(),
    action,
    reason: strongest.reason,
    signals,
    ...(strongest.taskId ? { taskId: strongest.taskId } : {}),
  };
}

export function supervisorPath(paths: Paths): string {
  return join(dirname(paths.state), 'supervisor.json');
}

/** Persist the latest decision for external supervisors. Best-effort and advisory. */
export function writeSupervisorSnapshot(paths: Paths, decision: SupervisorDecision): void {
  try {
    const file = supervisorPath(paths);
    ensureDir(dirname(file));
    atomicWriteSync(file, `${JSON.stringify(decision, null, 2)}\n`);
  } catch {
    /* advisory */
  }
}

export function formatSupervisor(decision: SupervisorDecision): string[] {
  const lines = [`supervisor: ${decision.action} — ${decision.reason}`];
  for (const signal of decision.signals) {
    lines.push(`  ${signal.kind}${signal.taskId ? ` ${signal.taskId}` : ''}: ${signal.reason}`);
  }
  return lines;
}
