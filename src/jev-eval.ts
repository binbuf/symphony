import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import type { Paths } from './paths.js';
import { ensureDir, nowIso } from './util.js';

/**
 * Jev evaluation. Recording every decision and the eventual task outcome turns "Jev feels useful"
 * into a measurable report: success rate per workflow, average confidence, cost and a simple
 * calibration table. It is opt-in (`jev.evaluate`), append-only, and never changes a run decision.
 */

export type JevWorkflow = 'session' | 'escalation' | 'breakdown';

export interface JevDecisionRecord {
  kind: 'decision';
  id: string;
  at: string;
  workflow: JevWorkflow;
  taskId: string;
  decision: string;
  confidence?: number;
  costUsd?: number;
  stage?: string;
  source?: string;
  model?: string;
}

export interface JevOutcomeRecord {
  kind: 'outcome';
  at: string;
  taskId: string;
  status: string;
  success: boolean;
  attempts?: number;
  costUsd?: number;
}

export type JevRecord = JevDecisionRecord | JevOutcomeRecord;

export function jevRecordsPath(paths: Paths): string {
  return join(dirname(paths.state), 'jev-decisions.jsonl');
}

let decisionSeq = 0;

export function recordJevDecision(
  paths: Paths,
  config: Config,
  input: Omit<JevDecisionRecord, 'kind' | 'id' | 'at'>,
): void {
  if (!config.jev.enabled || !config.jev.evaluate) return;
  const record: JevDecisionRecord = {
    kind: 'decision',
    id: `${Date.now().toString(36)}-${process.pid}-${++decisionSeq}`,
    at: nowIso(),
    ...input,
  };
  try {
    const file = jevRecordsPath(paths);
    ensureDir(dirname(file));
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    /* evaluation is advisory */
  }
}

export function recordJevOutcome(
  paths: Paths,
  config: Config,
  input: Omit<JevOutcomeRecord, 'kind' | 'at'>,
): void {
  if (!config.jev.enabled || !config.jev.evaluate) return;
  const record: JevOutcomeRecord = { kind: 'outcome', at: nowIso(), ...input };
  try {
    const file = jevRecordsPath(paths);
    ensureDir(dirname(file));
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    /* evaluation is advisory */
  }
}

export function readJevRecords(paths: Paths): JevRecord[] {
  const file = jevRecordsPath(paths);
  if (!existsSync(file)) return [];
  const out: JevRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JevRecord;
      if (parsed?.kind === 'decision' && typeof parsed.taskId === 'string' && typeof parsed.workflow === 'string') out.push(parsed);
      else if (parsed?.kind === 'outcome' && typeof parsed.taskId === 'string' && typeof parsed.status === 'string') out.push(parsed);
    } catch {
      /* a partial line from a crash is not a usable record */
    }
  }
  return out;
}

export interface JevWorkflowStats {
  workflow: JevWorkflow;
  decisions: number;
  evaluated: number;
  successes: number;
  successRate?: number;
  avgConfidence?: number;
  costUsd: number;
}

export interface JevCalibrationBucket {
  label: string;
  n: number;
  successes: number;
  rate?: number;
}

export interface JevEvaluation {
  decisions: number;
  outcomes: number;
  evaluated: number;
  successes: number;
  successRate?: number;
  costUsd: number;
  unpaired: number;
  byWorkflow: JevWorkflowStats[];
  calibration: JevCalibrationBucket[];
}

const WORKFLOWS: JevWorkflow[] = ['session', 'escalation', 'breakdown'];
const BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: '0.0–0.5', min: 0, max: 0.5 },
  { label: '0.5–0.6', min: 0.5, max: 0.6 },
  { label: '0.6–0.7', min: 0.6, max: 0.7 },
  { label: '0.7–0.8', min: 0.7, max: 0.8 },
  { label: '0.8–0.9', min: 0.8, max: 0.9 },
  { label: '0.9–1.0', min: 0.9, max: 1.0000001 },
];

function ratio(part: number, total: number): number | undefined {
  return total > 0 ? part / total : undefined;
}

/**
 * Pair each task's latest decision per workflow with that task's next outcome record. Sequence
 * matters: a decision is evaluated by the first outcome after it, so a later retry gets its own run.
 */
export function evaluateJev(records: readonly JevRecord[]): JevEvaluation {
  const pending = new Map<string, JevDecisionRecord>();
  const stats = new Map<JevWorkflow, { decisions: number; confidenceSum: number; confidenceN: number; evaluated: number; successes: number; costUsd: number }>();
  for (const workflow of WORKFLOWS) stats.set(workflow, { decisions: 0, confidenceSum: 0, confidenceN: 0, evaluated: 0, successes: 0, costUsd: 0 });
  const buckets = BUCKETS.map((b) => ({ ...b, n: 0, successes: 0 }));
  let totalCost = 0;
  let outcomes = 0;
  let unpaired = 0;

  for (const record of records) {
    if (record.kind === 'decision') {
      const s = stats.get(record.workflow);
      if (!s) continue;
      s.decisions += 1;
      s.costUsd += record.costUsd ?? 0;
      totalCost += record.costUsd ?? 0;
      if (typeof record.confidence === 'number' && Number.isFinite(record.confidence)) {
        s.confidenceSum += record.confidence;
        s.confidenceN += 1;
      }
      pending.set(`${record.taskId}\0${record.workflow}`, record);
      continue;
    }
    outcomes += 1;
    for (const workflow of WORKFLOWS) {
      const key = `${record.taskId}\0${workflow}`;
      const decision = pending.get(key);
      if (!decision) continue;
      pending.delete(key);
      const s = stats.get(workflow)!;
      s.evaluated += 1;
      if (record.success) s.successes += 1;
      const confidence = decision.confidence;
      if (typeof confidence === 'number' && Number.isFinite(confidence)) {
        const bucket = buckets.find((b) => confidence >= b.min && confidence < b.max);
        if (bucket) {
          bucket.n += 1;
          if (record.success) bucket.successes += 1;
        }
      }
    }
  }
  unpaired = pending.size;

  const byWorkflow: JevWorkflowStats[] = WORKFLOWS.map((workflow) => {
    const s = stats.get(workflow)!;
    return {
      workflow,
      decisions: s.decisions,
      evaluated: s.evaluated,
      successes: s.successes,
      ...(ratio(s.successes, s.evaluated) !== undefined ? { successRate: ratio(s.successes, s.evaluated) } : {}),
      ...(s.confidenceN ? { avgConfidence: s.confidenceSum / s.confidenceN } : {}),
      costUsd: s.costUsd,
    };
  });
  const evaluated = byWorkflow.reduce((n, w) => n + w.evaluated, 0);
  const successes = byWorkflow.reduce((n, w) => n + w.successes, 0);
  return {
    decisions: byWorkflow.reduce((n, w) => n + w.decisions, 0),
    outcomes,
    evaluated,
    successes,
    ...(ratio(successes, evaluated) !== undefined ? { successRate: ratio(successes, evaluated) } : {}),
    costUsd: totalCost,
    unpaired,
    byWorkflow,
    calibration: buckets.map((b) => ({
      label: b.label,
      n: b.n,
      successes: b.successes,
      ...(ratio(b.successes, b.n) !== undefined ? { rate: ratio(b.successes, b.n) } : {}),
    })),
  };
}

export function formatJevEvaluation(evaluation: JevEvaluation): string[] {
  const pct = (n: number | undefined): string => n === undefined ? '-' : `${Math.round(n * 100)}%`;
  const lines = [
    `Jev evaluation: ${evaluation.decisions} decision${evaluation.decisions === 1 ? '' : 's'}, ${evaluation.evaluated} with a later outcome${evaluation.outcomes ? ` (${evaluation.outcomes} outcome${evaluation.outcomes === 1 ? '' : 's'})` : ''}`,
    `success after a decision: ${pct(evaluation.successRate)} · cost $${evaluation.costUsd.toFixed(3)}${evaluation.unpaired ? ` · ${evaluation.unpaired} decision${evaluation.unpaired === 1 ? '' : 's'} still waiting for an outcome` : ''}`,
    '',
    'workflow      decisions  evaluated  success  avg confidence  cost',
  ];
  for (const w of evaluation.byWorkflow) {
    lines.push(`${w.workflow.padEnd(12)}  ${String(w.decisions).padStart(9)}  ${String(w.evaluated).padStart(9)}  ${pct(w.successRate).padStart(7)}  ${pct(w.avgConfidence).padStart(14)}  $${w.costUsd.toFixed(3)}`);
  }
  const used = evaluation.calibration.filter((b) => b.n > 0);
  if (used.length) {
    lines.push('', 'confidence calibration (evaluated decisions)');
    for (const b of used) lines.push(`  ${b.label}: ${b.successes}/${b.n} succeeded (${pct(b.rate)})`);
  }
  return lines;
}
