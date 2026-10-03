import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { git } from './git.js';
import { rel, type Paths } from './paths.js';
import { parseRoadmap } from './roadmap.js';
import { parseFrontMatter } from './tasks.js';
import { nowIso, squash } from './util.js';

/**
 * Observable-progress fingerprinting. The harness treats the agent's self-report as a claim, not
 * ground truth: after each attempt it hashes the *externally observable* state that a claim of
 * progress would have to change — HEAD, non-harness worktree changes, the task file's acceptance
 * checkboxes, the roadmap gate board, and the verify result. Two consecutive attempts that produce
 * the same fingerprint produced no net progress, so the task is "stalled" rather than "continuing".
 *
 * Harness-owned files (PROGRESS.md, the generated index, ROADMAP.md, logs, state, the stop sentinel,
 * the task file body and everything under .symphony/) are excluded: rewriting a note is motion, not
 * progress. Task-file checkboxes are folded in separately so ticking an acceptance box does count.
 */

export interface AttemptDelta {
  at: string;
  attempt: number;
  fingerprint: string;
  /** The objective product metric this attempt measured, when one is configured. */
  metric?: number;
  /** Short human-readable description of what was observed, for the stalled report. */
  signals: string[];
}

export interface DeltaInput {
  paths: Paths;
  attempt: number;
  /** The task's linked file, whose acceptance checkboxes count as progress. */
  taskFile?: string;
  /** The verify result recorded for this attempt, when one ran. */
  verify?: { ok: boolean; code?: number };
  /** The objective product metric this attempt measured, when one is configured. */
  metric?: number;
  at?: string;
}

/** Parse the last number printed by a metric command (e.g. `12`, `12 routes`, `count=12`). */
export function parseMetric(output: string | undefined): number | undefined {
  if (!output) return undefined;
  const matches = [...output.matchAll(/-?\d+(?:\.\d+)?/g)];
  if (!matches.length) return undefined;
  const n = Number(matches[matches.length - 1][0]);
  return Number.isFinite(n) ? n : undefined;
}

/** Whether `curr` is progress over `prev`, given the configured direction. */
export function metricImproved(prev: number | undefined, curr: number | undefined, direction: 'increase' | 'decrease' | 'nonzero'): boolean {
  if (curr === undefined) return false;
  if (prev === undefined) return true;
  if (direction === 'nonzero') return prev === 0 && curr !== 0;
  if (direction === 'decrease') return curr < prev;
  return curr > prev;
}

/**
 * True when the last `repeats + 1` metric readings show no improvement — the objective signal has
 * plateaued, so another attempt is motion without product progress. Requires enough readings.
 */
export function metricPlateau(
  metrics: readonly (number | undefined)[],
  direction: 'increase' | 'decrease' | 'nonzero',
  repeats: number,
): boolean {
  const nums = metrics.filter((m): m is number => m !== undefined);
  if (repeats <= 0 || nums.length < repeats + 1) return false;
  const tail = nums.slice(-(repeats + 1));
  for (let i = 1; i < tail.length; i++) {
    if (metricImproved(tail[i - 1], tail[i], direction)) return false;
  }
  return true;
}

/** Extract the `[ ]`/`[x]` acceptance state of a task body, in document order, as a compact string. */
export function checkboxSignature(body: string): string {
  const out: string[] = [];
  for (const m of body.matchAll(/^\s*[-*+]\s*\[([ xX])\]/gm)) out.push(m[1].toLowerCase() === 'x' ? '1' : '0');
  return out.join('');
}

/** The roadmap gate board as a stable string: task id, checkbox and tag for every bullet. */
function gateSignature(roadmapPath: string): string {
  if (!existsSync(roadmapPath)) return '';
  try {
    const rm = parseRoadmap(readFileSync(roadmapPath, 'utf8'));
    return rm.bullets.map((b) => `${b.id}:${b.check ?? '-'}:${b.tag ?? '-'}`).join(',');
  } catch {
    return '';
  }
}

/** Paths whose changes never count as product progress (harness-owned or generated). */
function ignoredPrefixes(paths: Paths, taskFileRel: string | undefined): string[] {
  const out = [
    rel(paths.root, paths.progress),
    rel(paths.root, paths.progressDir),
    rel(paths.root, paths.index),
    rel(paths.root, paths.roadmap),
    rel(paths.root, paths.stop),
    rel(paths.root, paths.logsDir),
    rel(paths.root, paths.state),
    '.symphony',
  ];
  if (taskFileRel) out.push(taskFileRel);
  return out.filter(Boolean);
}

function isIgnored(p: string, ignored: string[]): boolean {
  return ignored.some((g) => p === g || p.startsWith(`${g}/`));
}

/** Non-harness worktree changes (`git status --porcelain`), normalised and sorted. */
function changedPaths(paths: Paths, ignored: string[]): string[] {
  const r = git(paths.root, ['status', '--porcelain']);
  if (r.code !== 0 || !r.stdout) return [];
  const out: string[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
    const dest = raw.includes(' -> ') ? raw.split(' -> ').pop()!.trim() : raw;
    if (!dest || isIgnored(dest, ignored)) continue;
    out.push(`${line.slice(0, 2).trim() || '??'} ${dest}`);
  }
  return out.sort();
}

/** Compute the fingerprint of the observable state right now. */
export function computeAttemptDelta(input: DeltaInput): AttemptDelta {
  const { paths, attempt } = input;
  const taskFileRel = input.taskFile ? rel(paths.root, input.taskFile) : undefined;
  const head = git(paths.root, ['rev-parse', '--short', 'HEAD']).stdout || '';
  const changes = changedPaths(paths, ignoredPrefixes(paths, taskFileRel));
  let checks = '';
  if (input.taskFile && existsSync(input.taskFile)) {
    checks = checkboxSignature(parseFrontMatter(readFileSync(input.taskFile, 'utf8')).body);
  }
  const gates = gateSignature(paths.roadmap);
  const verify = input.verify ? `${input.verify.ok ? 'ok' : 'fail'}:${input.verify.code ?? ''}` : '';
  const metric = input.metric;
  const fingerprint = createHash('sha1')
    .update(JSON.stringify({ head, changes, checks, gates, verify, metric: metric ?? null }))
    .digest('hex');

  const checked = (checks.match(/1/g) ?? []).length;
  const doneGates = (gates.match(/:x:/g) ?? []).length;
  const signals = [
    head ? `head ${head}` : 'no commits',
    changes.length ? `${changes.length} worktree change${changes.length === 1 ? '' : 's'}: ${changes.slice(0, 4).map((c) => squash(c.slice(3), 40)).join(', ')}${changes.length > 4 ? ', …' : ''}` : 'no worktree changes',
    checks ? `checkboxes ${checked}/${checks.length}` : 'no acceptance checkboxes',
    input.verify ? `verify ${input.verify.ok ? 'passed' : `failed (exit ${input.verify.code ?? '?'})`}` : '',
    metric !== undefined ? `metric ${metric}` : '',
    doneGates ? `gate board ${doneGates} done` : '',
  ].filter(Boolean);
  return { at: input.at ?? nowIso(), attempt, fingerprint, metric, signals };
}

/**
 * True when the most recent `stallAfterRepeats` fingerprints all equal `current`, i.e. this attempt
 * reproduced the same observable state as the attempts before it. `stallAfterRepeats` is the number
 * of *repeats*: 1 (the default) means the immediately preceding fingerprint is identical.
 */
export function isStalled(history: readonly string[], current: string, stallAfterRepeats: number): boolean {
  if (stallAfterRepeats <= 0 || history.length === 0) return false;
  const n = Math.min(stallAfterRepeats, history.length);
  for (let i = 0; i < n; i++) {
    if (history[history.length - 1 - i] !== current) return false;
  }
  return true;
}
