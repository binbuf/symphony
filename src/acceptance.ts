import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { rel, type Paths } from './paths.js';
import type { Task } from './tasks.js';
import { ensureDir, headAndTailBytes, isRecord, nowIso, sleep, squash, stamp } from './util.js';
import type { VerifyResult } from './verify.js';

/**
 * Structured acceptance.
 *
 * A task may contain one fenced `symphony-acceptance` JSON block. Tasks without the block keep the
 * legacy contract unchanged. A v2 contract is explicit: every criterion has a stable id, and every
 * criterion names the gates that prove it. The harness, not the agent's checkboxes, decides whether
 * the task is accepted.
 *
 * Implemented gates: `verify`, `diff`, `metric`, `visual-regression`, `visual-layout`,
 * `visual-semantic`, and `human`. `semantic` is recognised but rejected until the judge-backed gate
 * lands.
 */

export type GateStatus = 'pass' | 'fail' | 'inconclusive' | 'pending_human';
export type AcceptanceStatus = 'accepted' | 'failed' | 'inconclusive' | 'pending_human';
export type SupportedGateKind =
  | 'verify'
  | 'diff'
  | 'metric'
  | 'visual-regression'
  | 'visual-layout'
  | 'visual-semantic'
  | 'human';
export type RecognizedGateKind = SupportedGateKind | 'semantic';

export type MetricOperator = '>=' | '>' | '<=' | '<' | '==' | '!=';
export type MetricAggregate = 'mean' | 'median' | 'min' | 'max' | 'first' | 'last';
export type MetricParser = 'number' | 'json';

export interface AcceptanceGateSpec {
  kind: SupportedGateKind;
  /** verify/metric/visual: the shell command the harness runs itself. */
  command?: string;
  /** verify/metric/visual: wall-clock cap; defaults to config.verifyTimeoutMin. */
  timeoutMin?: number;
  /** diff: optional path prefixes; at least one changed file must match. */
  paths?: string[];

  // metric
  parser?: MetricParser;
  /** metric (json parser): dot path into the JSON document, e.g. "results.0.value". */
  metric?: string;
  /** metric: optional regex whose first capture group (or whole match) is parsed first. */
  regex?: string;
  operator?: MetricOperator;
  target?: number;
  samples?: number;
  aggregate?: MetricAggregate;
  warmup?: number;

  // visual-regression / visual-layout
  capture?: string;
  compare?: string;
  baseline?: string;
  threshold?: number;

  // visual-semantic
  image?: string;
  prompt?: string;

  // human
  approver?: string;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  blocking: boolean;
  gates: AcceptanceGateSpec[];
}

export interface AcceptanceSpec {
  version: 2;
  criteria: AcceptanceCriterion[];
}

export interface WorktreeRevisionLike {
  tree: string;
  commit?: string;
  dirty?: boolean;
}

export interface GateEvidence {
  kind: 'command-output' | 'files' | 'artifact' | 'image' | 'review' | 'approval';
  /** Path relative to the project root, when the evidence is a file. */
  path?: string;
  sha256?: string;
  command?: string;
  /** A short excerpt; the full artifact is referenced by `path`. */
  outputTail?: string;
  /** metric/visual: the measured value or sample set. */
  value?: number;
  samples?: number[];
  /** human: who approved and when. */
  approver?: string;
  at?: string;
}

export interface GateResult {
  criterionId: string;
  gate: SupportedGateKind;
  status: GateStatus;
  revision: WorktreeRevisionLike & { taskBaseSha?: string };
  evidence: GateEvidence[];
  evaluator: { kind: 'harness'; version: string; configRevision: string };
  createdAt: string;
  command?: string;
  exitCode?: number;
  /** Whether a focused repair session ran before this result was recorded. */
  repaired?: boolean;
  /** metric: the aggregated measured value. */
  value?: number;
  /** metric: every measured sample value. */
  samples?: number[];
  details?: string;
}

export interface CriterionDecision {
  id: string;
  text: string;
  blocking: boolean;
  status: GateStatus;
  results: GateResult[];
  reason?: string;
}

export interface AcceptanceDecision {
  status: AcceptanceStatus;
  accepted: boolean;
  criteria: CriterionDecision[];
  reasons: string[];
}

export interface AcceptanceSummary {
  version: 2;
  revision: string;
  taskBaseSha?: string;
  status: AcceptanceStatus;
  criteria: Array<{ id: string; status: GateStatus; reason?: string }>;
  at: string;
}

export const ACCEPTANCE_ENGINE_VERSION = 'acceptance-v1';
export const ACCEPTANCE_FENCE = 'symphony-acceptance';

const FENCE_RE = /^[ \t]*```[ \t]*symphony-acceptance[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/gm;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RECOGNIZED = new Set<RecognizedGateKind>([
  'verify', 'diff', 'semantic', 'metric', 'visual-regression',
  'visual-layout', 'visual-semantic', 'human',
]);
const SUPPORTED = new Set<SupportedGateKind>([
  'verify', 'diff', 'metric', 'visual-regression', 'visual-layout', 'visual-semantic', 'human',
]);
const METRIC_OPERATORS = new Set<MetricOperator>(['>=', '>', '<=', '<', '==', '!=']);
const METRIC_AGGREGATES = new Set<MetricAggregate>(['mean', 'median', 'min', 'max', 'first', 'last']);
const METRIC_PARSERS = new Set<MetricParser>(['number', 'json']);

/** Read the fenced v2 block, if any. Absence is legacy, not an error. */
export function parseAcceptanceSpec(body: string | undefined): { spec?: AcceptanceSpec; legacy: boolean; errors: string[] } {
  if (!body) return { legacy: true, errors: [] };
  const blocks = [...body.matchAll(FENCE_RE)].map((m) => m[1]);
  if (!blocks.length) return { legacy: true, errors: [] };
  if (blocks.length > 1) return { legacy: false, errors: [`multiple ${ACCEPTANCE_FENCE} blocks; exactly one is allowed`] };

  let raw: unknown;
  try {
    raw = JSON.parse(blocks[0]);
  } catch (e) {
    return { legacy: false, errors: [`${ACCEPTANCE_FENCE} block is not valid JSON: ${(e as Error).message}`] };
  }
  if (!isRecord(raw)) return { legacy: false, errors: [`${ACCEPTANCE_FENCE} block must be a JSON object`] };
  if (raw.version !== 2) return { legacy: false, errors: [`${ACCEPTANCE_FENCE}.version must be 2`] };
  if (!Array.isArray(raw.criteria) || raw.criteria.length === 0) {
    return { legacy: false, errors: [`${ACCEPTANCE_FENCE}.criteria must be a non-empty array`] };
  }

  const errors: string[] = [];
  const criteria: AcceptanceCriterion[] = [];
  const ids = new Set<string>();

  for (const [index, item] of raw.criteria.entries()) {
    const where = `${ACCEPTANCE_FENCE}.criteria[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || !ID_RE.test(id)) errors.push(`${where}.id must be a stable id like "tests" or "api-latency"`);
    else if (ids.has(id)) errors.push(`${where}.id "${id}" is duplicated`);
    else ids.add(id);
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) errors.push(`${where}.text must be a non-empty string`);
    if (item.blocking !== undefined && typeof item.blocking !== 'boolean') errors.push(`${where}.blocking must be a boolean`);
    const blocking = item.blocking === undefined ? true : item.blocking as boolean;

    const gates: AcceptanceGateSpec[] = [];
    if (!Array.isArray(item.gates) || item.gates.length === 0) {
      errors.push(`${where}.gates must be a non-empty array`);
    } else {
      const kinds = new Set<string>();
      for (const [gateIndex, gateRaw] of item.gates.entries()) {
        const gateWhere = `${where}.gates[${gateIndex}]`;
        const gate = parseGate(gateRaw, gateWhere, errors);
        if (!gate) continue;
        if (kinds.has(gate.kind)) errors.push(`${gateWhere}: duplicate "${gate.kind}" gate for one criterion`);
        kinds.add(gate.kind);
        gates.push(gate);
      }
    }
    criteria.push({ id: id || `criterion-${index + 1}`, text: text || `Criterion ${index + 1}`, blocking, gates });
  }

  return errors.length ? { legacy: false, errors } : { legacy: false, errors: [], spec: { version: 2, criteria } };
}

function parseGate(raw: unknown, where: string, errors: string[]): AcceptanceGateSpec | undefined {
  if (!isRecord(raw)) {
    errors.push(`${where} must be an object`);
    return undefined;
  }
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
  if (!kind) {
    errors.push(`${where}.kind is required`);
    return undefined;
  }
  if (!RECOGNIZED.has(kind as RecognizedGateKind)) {
    errors.push(`${where}.kind "${kind}" is not a recognised gate`);
    return undefined;
  }
  if (!SUPPORTED.has(kind as SupportedGateKind)) {
    errors.push(`${where}.kind "${kind}" is not supported in this build yet`);
    return undefined;
  }

  const timeoutMin = optionalPositive(raw.timeoutMin, `${where}.timeoutMin`, errors);

  if (kind === 'verify') {
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) errors.push(`${where}.command is required for a verify gate`);
    return { kind: 'verify', ...(command ? { command } : {}), ...(timeoutMin ? { timeoutMin } : {}) };
  }

  if (kind === 'diff') {
    let paths: string[] | undefined;
    if (raw.paths !== undefined) {
      if (!Array.isArray(raw.paths) || raw.paths.some((p) => typeof p !== 'string' || !p.trim())) {
        errors.push(`${where}.paths must be an array of non-empty strings`);
      } else {
        paths = raw.paths.map((p) => p.trim().replace(/\\/g, '/'));
      }
    }
    return { kind: 'diff', ...(paths?.length ? { paths } : {}) };
  }

  if (kind === 'metric') {
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) errors.push(`${where}.command is required for a metric gate`);
    const parser = typeof raw.parser === 'string' ? raw.parser.trim() as MetricParser : 'number';
    if (!METRIC_PARSERS.has(parser)) errors.push(`${where}.parser must be "number" or "json"`);
    const metric = typeof raw.metric === 'string' ? raw.metric.trim() : undefined;
    if (parser === 'json' && !metric) errors.push(`${where}.metric is required when parser is "json"`);
    let regex: string | undefined;
    if (raw.regex !== undefined) {
      if (typeof raw.regex !== 'string' || !raw.regex) errors.push(`${where}.regex must be a non-empty string`);
      else {
        try { new RegExp(raw.regex); regex = raw.regex; } catch (e) { errors.push(`${where}.regex is not a valid regular expression: ${(e as Error).message}`); }
      }
    }
    const operator = typeof raw.operator === 'string' ? raw.operator.trim() as MetricOperator : '>=';
    if (!METRIC_OPERATORS.has(operator)) errors.push(`${where}.operator must be one of ${[...METRIC_OPERATORS].join(' ')}`);
    if (typeof raw.target !== 'number' || !Number.isFinite(raw.target)) errors.push(`${where}.target must be a finite number`);
    const samples = optionalCount(raw.samples, `${where}.samples`, errors);
    const warmup = optionalCount(raw.warmup, `${where}.warmup`, errors);
    const aggregate = typeof raw.aggregate === 'string' ? raw.aggregate.trim() as MetricAggregate : 'median';
    if (!METRIC_AGGREGATES.has(aggregate)) errors.push(`${where}.aggregate must be one of ${[...METRIC_AGGREGATES].join(' ')}`);
    return {
      kind: 'metric',
      ...(command ? { command } : {}),
      parser,
      ...(metric ? { metric } : {}),
      ...(regex ? { regex } : {}),
      operator,
      ...(typeof raw.target === 'number' && Number.isFinite(raw.target) ? { target: raw.target } : {}),
      samples: samples ?? 1,
      aggregate,
      warmup: warmup ?? 0,
      ...(timeoutMin ? { timeoutMin } : {}),
    };
  }

  if (kind === 'visual-regression' || kind === 'visual-layout') {
    const capture = typeof raw.capture === 'string' ? raw.capture.trim() : '';
    const compare = typeof raw.compare === 'string' ? raw.compare.trim() : '';
    const baseline = typeof raw.baseline === 'string' ? raw.baseline.trim().replace(/\\/g, '/') : '';
    if (!capture) errors.push(`${where}.capture is required for a ${kind} gate`);
    if (!compare) errors.push(`${where}.compare is required for a ${kind} gate`);
    if (!baseline) errors.push(`${where}.baseline is required for a ${kind} gate`);
    let threshold: number | undefined;
    if (raw.threshold !== undefined) {
      if (typeof raw.threshold !== 'number' || !Number.isFinite(raw.threshold) || raw.threshold < 0) {
        errors.push(`${where}.threshold must be a non-negative number`);
      } else threshold = raw.threshold;
    }
    return {
      kind,
      ...(capture ? { capture } : {}),
      ...(compare ? { compare } : {}),
      ...(baseline ? { baseline } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
      ...(timeoutMin ? { timeoutMin } : {}),
    };
  }

  if (kind === 'visual-semantic') {
    const capture = typeof raw.capture === 'string' ? raw.capture.trim() : undefined;
    const image = typeof raw.image === 'string' ? raw.image.trim().replace(/\\/g, '/') : undefined;
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
    if (!capture && !image) errors.push(`${where}.capture or .image is required for a visual-semantic gate`);
    if (!prompt) errors.push(`${where}.prompt is required for a visual-semantic gate`);
    return {
      kind: 'visual-semantic',
      ...(capture ? { capture } : {}),
      ...(image ? { image } : {}),
      ...(prompt ? { prompt } : {}),
      ...(timeoutMin ? { timeoutMin } : {}),
    };
  }

  // human
  let approver: string | undefined;
  if (raw.approver !== undefined) {
    if (typeof raw.approver !== 'string' || !raw.approver.trim()) errors.push(`${where}.approver must be a non-empty string`);
    else approver = raw.approver.trim();
  }
  return { kind: 'human', ...(approver ? { approver } : {}) };
}

function optionalPositive(raw: unknown, where: string, errors: string[]): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    errors.push(`${where} must be a positive number`);
    return undefined;
  }
  return raw;
}

function optionalCount(raw: unknown, where: string, errors: string[]): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 100) {
    errors.push(`${where} must be a whole number between 0 and 100`);
    return undefined;
  }
  if (where.endsWith('.samples') && raw === 0) {
    errors.push(`${where} must be at least 1`);
    return undefined;
  }
  return raw;
}

/** Hash of the config that can affect a gate result. Used to invalidate results after config edits. */
export function configRevision(config: Config): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}

/** The evidence directory for one task, isolated with the task set's state. */
export function evidenceDir(paths: Paths, taskId: string): string {
  return join(dirname(paths.state), 'evidence', taskId);
}

export function gateResultsPath(paths: Paths, taskId: string): string {
  return join(evidenceDir(paths, taskId), 'gate-results.jsonl');
}

/** Append one immutable gate result. The store is append-only; readers never rewrite it. */
export function appendGateResult(paths: Paths, taskId: string, result: GateResult): void {
  ensureDir(evidenceDir(paths, taskId));
  appendFileSync(gateResultsPath(paths, taskId), `${JSON.stringify(result)}\n`);
}

/** Read every valid gate result for a task, oldest first. Malformed lines are ignored. */
export function readGateResults(paths: Paths, taskId: string): GateResult[] {
  const file = gateResultsPath(paths, taskId);
  if (!existsSync(file)) return [];
  const out: GateResult[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)
        && typeof parsed.criterionId === 'string'
        && typeof parsed.gate === 'string'
        && SUPPORTED.has(parsed.gate as SupportedGateKind)
        && (parsed.status === 'pass' || parsed.status === 'fail' || parsed.status === 'inconclusive' || parsed.status === 'pending_human')
        && isRecord(parsed.revision)
        && typeof parsed.revision.tree === 'string') {
        out.push(parsed as unknown as GateResult);
      }
    } catch { /* a partial line from a crash is not a usable result */ }
  }
  return out;
}

/**
 * Files the harness owns: they must never make a task's acceptance revision look dirty or different.
 * Kept here (rather than in the runner) so the approval command and the gate engine compute exactly
 * the same revision.
 */
export function acceptanceExcludes(paths: Paths): string[] {
  return [
    rel(paths.root, paths.roadmap),
    rel(paths.root, paths.progress),
    rel(paths.root, paths.progressDir),
    rel(paths.root, paths.tasksDir),
    rel(paths.root, paths.logsDir),
    rel(paths.root, paths.index),
    rel(paths.root, paths.stop),
  ].filter(Boolean);
}

export function visualArtifactDir(paths: Paths, taskId: string): string {
  return join(evidenceDir(paths, taskId), 'visual');
}

export function approvalsPath(paths: Paths, taskId: string): string {
  return join(dirname(paths.state), 'approvals', `${taskId}.jsonl`);
}

/**
 * A human approval is bound to one criterion at one exact worktree revision and to the evidence that
 * supported it. Any later worktree change invalidates it automatically because the revision no longer
 * matches.
 */
export interface ApprovalRecord {
  taskId: string;
  criterionId: string;
  approver: string;
  at: string;
  /** Worktree tree hash the human approved. */
  revision: string;
  /** Hash of the non-human gate evidence at that revision. */
  evidenceHash: string;
  note?: string;
}

export function readApprovals(paths: Paths, taskId: string): ApprovalRecord[] {
  const file = approvalsPath(paths, taskId);
  if (!existsSync(file)) return [];
  const out: ApprovalRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)
        && parsed.taskId === taskId
        && typeof parsed.criterionId === 'string'
        && typeof parsed.approver === 'string'
        && typeof parsed.at === 'string'
        && typeof parsed.revision === 'string'
        && typeof parsed.evidenceHash === 'string') {
        out.push(parsed as unknown as ApprovalRecord);
      }
    } catch { /* ignore a partial line */ }
  }
  return out;
}

export function appendApproval(paths: Paths, approval: ApprovalRecord): string {
  const file = approvalsPath(paths, approval.taskId);
  ensureDir(dirname(file));
  appendFileSync(file, `${JSON.stringify(approval)}\n`);
  return file;
}

/**
 * Hash the non-human gate evidence supporting one criterion at one revision. Human approvals bind to
 * this value, so a different gate outcome (or a different worktree) requires a new approval. Gate
 * kinds, statuses and commands are used rather than raw output bytes: verify/test output often
 * contains timings, which would invalidate an approval on every harmless re-run.
 */
export function criterionEvidenceHash(
  criterion: AcceptanceCriterion,
  results: readonly GateResult[],
  revisionTree: string,
): string {
  const evidence = results
    .filter((r) => r.criterionId === criterion.id && r.gate !== 'human' && r.revision.tree === revisionTree)
    .map((r) => ({ gate: r.gate, status: r.status, command: r.command ?? '' }))
    .sort((a, b) => `${a.gate}\0${a.command}`.localeCompare(`${b.gate}\0${b.command}`));
  return createHash('sha256')
    .update(JSON.stringify({ criterionId: criterion.id, text: criterion.text, revision: revisionTree, evidence }))
    .digest('hex');
}

let artifactSeq = 0;

function writeArtifact(paths: Paths, taskId: string, label: string, content: string): GateEvidence | undefined {
  try {
    const dir = join(evidenceDir(paths, taskId), 'artifacts');
    ensureDir(dir);
    const safe = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'artifact';
    const file = join(dir, `${safe}-${stamp()}-${++artifactSeq}.txt`);
    const body = headAndTailBytes(content, 256 * 1024);
    writeFileSync(file, body);
    return {
      kind: 'command-output',
      path: rel(paths.root, file),
      sha256: createHash('sha256').update(body).digest('hex'),
      outputTail: body.slice(-4000),
    };
  } catch {
    return undefined;
  }
}

/** The latest result for one criterion/gate pair, or undefined when none exists. */
/** A diff path is a prefix: `src/`, `src/**` and `src` all match files under `src/`. */
function matchesPath(file: string, raw: string): boolean {
  const prefix = raw.trim().replace(/\/+$/, '').replace(/\/?\*+$/, '');
  return Boolean(prefix) && (file === prefix || file.startsWith(`${prefix}/`));
}

function latestResult(results: readonly GateResult[], criterionId: string, gate: SupportedGateKind): GateResult | undefined {
  let found: GateResult | undefined;
  for (const r of results) {
    if (r.criterionId === criterionId && r.gate === gate) found = r;
  }
  return found;
}

/**
 * Compute acceptance from the spec and the accumulated results. A result only counts at the exact
 * revision being accepted: a pass from an older tree is stale and makes the criterion inconclusive.
 */
export function decideAcceptance(spec: AcceptanceSpec, results: readonly GateResult[], revisionTree: string): AcceptanceDecision {
  const decisions: CriterionDecision[] = [];
  const reasons: string[] = [];

  for (const criterion of spec.criteria) {
    const criterionResults: GateResult[] = [];
    const statuses: GateStatus[] = [];
    const localReasons: string[] = [];
    for (const gate of criterion.gates) {
      const result = latestResult(results, criterion.id, gate.kind);
      if (result) criterionResults.push(result);
      if (!result) {
        statuses.push('inconclusive');
        localReasons.push(`${criterion.id}/${gate.kind}: no result at revision ${revisionTree.slice(0, 12)}`);
        continue;
      }
      if (result.revision.tree !== revisionTree) {
        statuses.push('inconclusive');
        localReasons.push(`${criterion.id}/${gate.kind}: stale evidence from revision ${result.revision.tree.slice(0, 12)}`);
        continue;
      }
      statuses.push(result.status);
      if (result.status !== 'pass') {
        localReasons.push(`${criterion.id}/${gate.kind}: ${result.status}${result.details ? ` — ${result.details}` : ''}`);
      }
    }
    if (!criterion.gates.length) {
      statuses.push('inconclusive');
      localReasons.push(`${criterion.id}: no gates declared`);
    }
    const status: GateStatus = statuses.includes('fail')
      ? 'fail'
      : statuses.includes('pending_human')
        ? 'pending_human'
        : statuses.includes('inconclusive')
          ? 'inconclusive'
          : 'pass';
    if (status !== 'pass') reasons.push(...localReasons);
    decisions.push({ ...criterion, status, results: criterionResults, ...(localReasons.length ? { reason: localReasons.join('; ') } : {}) });
  }

  const blocking = decisions.filter((d) => d.blocking);
  const status: AcceptanceStatus = blocking.some((d) => d.status === 'fail')
    ? 'failed'
    : blocking.some((d) => d.status === 'pending_human')
      ? 'pending_human'
      : blocking.some((d) => d.status === 'inconclusive')
        ? 'inconclusive'
        : 'accepted';
  return {
    status,
    accepted: status === 'accepted',
    criteria: decisions,
    reasons: status === 'accepted' ? ['all blocking acceptance gates passed'] : reasons,
  };
}

export interface EvaluateAcceptanceOptions {
  paths: Paths;
  task: Task;
  spec: AcceptanceSpec;
  config: Config;
  taskBaseSha?: string;
  /** Snapshot of the worktree the gates are evaluated against. */
  revision: WorktreeRevisionLike;
  log?: Logger;
  runVerify: (command: string, timeoutMs: number, env?: Record<string, string>) => VerifyResult;
  changedFiles: (base?: string) => string[];
  /** Extra attempts when a gate could not acquire evidence (timeout/spawn/network), before repair. */
  verifyRetries?: number;
  /** Delay between infrastructure retries. */
  retryDelayMs?: number;
  /** A focused repair session; returns true when it actually ran and verify should be retried. */
  repair?: (command: string, result: VerifyResult) => Promise<boolean>;
  /** Visual-semantic review. Wired to the configured vision model by the runner. */
  reviewImage?: (image: string, prompt: string) => Promise<{ text: string }>;
}

/** Last finite number in a command's output. */
function lastNumber(output: string): number | undefined {
  const matches = output.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g);
  if (!matches?.length) return undefined;
  const value = Number(matches[matches.length - 1]);
  return Number.isFinite(value) ? value : undefined;
}

function jsonPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const part of path.split('.').filter(Boolean)) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function parseMetricOutput(output: string, gate: AcceptanceGateSpec): number | undefined {
  let text = output;
  if (gate.regex) {
    try {
      const match = new RegExp(gate.regex).exec(output);
      if (!match) return undefined;
      text = match[1] ?? match[0];
    } catch {
      return undefined;
    }
  }
  if (gate.parser === 'json') {
    try {
      const parsed: unknown = JSON.parse(text.trim());
      const value = jsonPath(parsed, gate.metric);
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const n = Number(value.trim());
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  return lastNumber(text);
}

function aggregateValues(values: number[], aggregate: MetricAggregate): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  switch (aggregate) {
    case 'first': return values[0];
    case 'last': return values[values.length - 1];
    case 'min': return sorted[0];
    case 'max': return sorted[sorted.length - 1];
    case 'mean': return values.reduce((a, b) => a + b, 0) / values.length;
    case 'median': {
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
  }
}

function meetsTarget(value: number, operator: MetricOperator, target: number): boolean {
  switch (operator) {
    case '>=': return value >= target;
    case '>': return value > target;
    case '<=': return value <= target;
    case '<': return value < target;
    case '==': return value === target;
    case '!=': return value !== target;
  }
}

/** An incomplete gate (could not run, not a real failure) is retried before evidence is recorded. */
async function withEvidenceRetries(
  run: () => VerifyResult,
  retries: number,
  delayMs: number | undefined,
  retryAnyFailure = false,
): Promise<VerifyResult> {
  let res = run();
  for (let attempt = 0; !res.ok && (retryAnyFailure || res.code === null) && attempt < Math.max(0, retries); attempt++) {
    if (delayMs && delayMs > 0) await sleep(delayMs);
    res = run();
  }
  return res;
}

function fileEvidence(paths: Paths, file: string, kind: GateEvidence['kind']): GateEvidence | undefined {
  try {
    const bytes = readFileSync(file);
    if (!bytes.length) return undefined;
    return {
      kind,
      path: rel(paths.root, file),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return undefined;
  }
}

function expandVisualCommand(command: string, vars: Record<string, string>): string {
  return command.replace(/\{(actual|baseline|diff|threshold|artifactDir)\}/g, (whole, key: string) => vars[key] ?? whole);
}

interface GateOutcome {
  status: GateStatus;
  evidence: GateEvidence[];
  details: string;
  command?: string;
  exitCode?: number;
  value?: number;
  samples?: number[];
}

async function runMetricGate(o: EvaluateAcceptanceOptions, gate: AcceptanceGateSpec, label: string): Promise<GateOutcome> {
  const command = gate.command ?? '';
  const timeoutMin = gate.timeoutMin && gate.timeoutMin > 0 ? gate.timeoutMin : o.config.metric.timeoutMin;
  const timeoutMs = Math.max(1, Math.round(timeoutMin * 60_000));
  const warmup = gate.warmup ?? 0;
  const wanted = gate.samples ?? 1;
  const outputs: string[] = [];
  const values: number[] = [];
  let incomplete = 0;

  for (let i = 0; i < warmup; i++) {
    const res = await withEvidenceRetries(() => o.runVerify(command, timeoutMs), o.verifyRetries ?? 0, o.retryDelayMs, true);
    outputs.push(`# warmup ${i + 1} (exit ${res.code ?? 'none'})\n${res.output}`);
  }
  for (let i = 0; i < wanted; i++) {
    const res = await withEvidenceRetries(() => o.runVerify(command, timeoutMs), o.verifyRetries ?? 0, o.retryDelayMs, true);
    outputs.push(`# sample ${i + 1} (exit ${res.code ?? 'none'})\n${res.output}`);
    if (res.code === null) { incomplete += 1; continue; }
    const value = res.code === 0 ? parseMetricOutput(res.output, gate) : undefined;
    if (value === undefined) { incomplete += 1; continue; }
    values.push(value);
  }

  const artifact = writeArtifact(o.paths, o.task.id, `metric-${label}`, outputs.join('\n\n') || '(no output)');
  const evidence = artifact ? [artifact] : [];
  if (!values.length) {
    return {
      status: 'inconclusive',
      evidence,
      command,
      exitCode: undefined,
      details: `metric gate produced no usable sample after ${wanted} sample${wanted === 1 ? '' : 's'}${incomplete ? ` (${incomplete} incomplete)` : ''}: ${command}`,
    };
  }
  const value = aggregateValues(values, gate.aggregate ?? 'median');
  const pass = meetsTarget(value, gate.operator ?? '>=', gate.target ?? 0);
  return {
    status: pass ? 'pass' : 'fail',
    evidence: [...evidence, { kind: 'artifact', value, samples: values, command, outputTail: `${gate.aggregate ?? 'median'}(${values.join(', ')}) ${gate.operator ?? '>='} ${gate.target}` }],
    command,
    exitCode: 0,
    value,
    samples: values,
    details: `${gate.aggregate ?? 'median'} ${value} ${gate.operator ?? '>='} ${gate.target}${incomplete ? ` (${incomplete} of ${wanted} samples incomplete)` : ''}`,
  };
}

async function runVisualGate(o: EvaluateAcceptanceOptions, gate: AcceptanceGateSpec, label: string): Promise<GateOutcome> {
  const timeoutMin = gate.timeoutMin && gate.timeoutMin > 0 ? gate.timeoutMin : o.config.verifyTimeoutMin;
  const timeoutMs = Math.max(1, Math.round(timeoutMin * 60_000));
  const dir = visualArtifactDir(o.paths, o.task.id);
  ensureDir(dir);
  const safe = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'visual';
  const actual = join(dir, `${safe}-${stamp()}-${++artifactSeq}.png`);
  const diff = join(dir, `${safe}-${stamp()}-${++artifactSeq}-diff.png`);
  const baseline = join(o.paths.root, gate.baseline ?? '');
  const threshold = String(gate.threshold ?? 0);
  const vars = { actual, baseline, diff, threshold, artifactDir: dir };

  const capture = await withEvidenceRetries(
    () => o.runVerify(expandVisualCommand(gate.capture ?? '', vars), timeoutMs, {
      SYMPHONY_VISUAL_ACTUAL: actual,
      SYMPHONY_VISUAL_BASELINE: baseline,
      SYMPHONY_VISUAL_DIFF: diff,
      SYMPHONY_VISUAL_THRESHOLD: threshold,
      SYMPHONY_VISUAL_ARTIFACT_DIR: dir,
    }),
    o.verifyRetries ?? 0,
    o.retryDelayMs,
    true,
  );
  const actualEvidence = fileEvidence(o.paths, actual, 'image');
  if (capture.code !== 0 || !actualEvidence) {
    const artifact = writeArtifact(o.paths, o.task.id, `visual-capture-${label}`, capture.output || '(no output)');
    return {
      status: 'inconclusive',
      evidence: [...(artifact ? [artifact] : []), ...(actualEvidence ? [actualEvidence] : [])],
      command: gate.capture,
      exitCode: capture.code ?? undefined,
      details: `visual capture did not produce an image${capture.code === null ? ' (command could not run)' : ` (exit ${capture.code})`}: ${gate.capture}`,
    };
  }
  if (!existsSync(baseline)) {
    return {
      status: 'inconclusive',
      evidence: [actualEvidence],
      command: gate.compare,
      details: `visual baseline is missing: ${gate.baseline}`,
    };
  }

  const compare = await withEvidenceRetries(
    () => o.runVerify(expandVisualCommand(gate.compare ?? '', vars), timeoutMs, {
      SYMPHONY_VISUAL_ACTUAL: actual,
      SYMPHONY_VISUAL_BASELINE: baseline,
      SYMPHONY_VISUAL_DIFF: diff,
      SYMPHONY_VISUAL_THRESHOLD: threshold,
      SYMPHONY_VISUAL_ARTIFACT_DIR: dir,
    }),
    o.verifyRetries ?? 0,
    o.retryDelayMs,
  );
  const artifact = writeArtifact(o.paths, o.task.id, `visual-compare-${label}`, compare.output || '(no output)');
  const diffEvidence = fileEvidence(o.paths, diff, 'image');
  const evidence = [actualEvidence, ...(diffEvidence ? [diffEvidence] : []), ...(artifact ? [artifact] : [])];
  if (compare.code === null) {
    return {
      status: 'inconclusive',
      evidence,
      command: gate.compare,
      exitCode: undefined,
      details: `visual compare could not run: ${gate.compare}${compare.output ? ` — ${squash(compare.output, 240)}` : ''}`,
    };
  }
  return {
    status: compare.code === 0 ? 'pass' : 'fail',
    evidence,
    command: gate.compare,
    exitCode: compare.code,
    details: compare.code === 0
      ? `visual ${gate.kind} matched baseline within threshold ${threshold}`
      : `visual ${gate.kind} changed beyond threshold ${threshold}${compare.output ? ` — ${squash(compare.output, 240)}` : ''}`,
  };
}

async function runVisualSemanticGate(o: EvaluateAcceptanceOptions, gate: AcceptanceGateSpec, label: string): Promise<GateOutcome> {
  const timeoutMin = gate.timeoutMin && gate.timeoutMin > 0 ? gate.timeoutMin : o.config.verifyTimeoutMin;
  const timeoutMs = Math.max(1, Math.round(timeoutMin * 60_000));
  let image = gate.image ? join(o.paths.root, gate.image) : '';

  if (!image) {
    const dir = visualArtifactDir(o.paths, o.task.id);
    ensureDir(dir);
    const safe = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'visual';
    image = join(dir, `${safe}-${stamp()}-${++artifactSeq}.png`);
    const capture = await withEvidenceRetries(
      () => o.runVerify(gate.capture ?? '', timeoutMs, { SYMPHONY_VISUAL_ACTUAL: image, SYMPHONY_VISUAL_ARTIFACT_DIR: dir }),
      o.verifyRetries ?? 0,
      o.retryDelayMs,
      true,
    );
    if (capture.code !== 0 || !existsSync(image)) {
      const artifact = writeArtifact(o.paths, o.task.id, `visual-semantic-capture-${label}`, capture.output || '(no output)');
      return {
        status: 'inconclusive',
        evidence: artifact ? [artifact] : [],
        command: gate.capture,
        exitCode: capture.code ?? undefined,
        details: `visual-semantic capture did not produce an image: ${gate.capture}`,
      };
    }
  }

  const imageEvidence = fileEvidence(o.paths, image, 'image');
  if (!imageEvidence) {
    return { status: 'inconclusive', evidence: [], command: gate.capture, details: `visual-semantic image is missing or empty: ${gate.image ?? gate.capture}` };
  }
  if (!o.reviewImage) {
    return {
      status: 'inconclusive',
      evidence: [imageEvidence],
      command: gate.capture,
      details: 'visual-semantic review is unavailable (vision.enabled is off or no API key)',
    };
  }

  const prompt = `${gate.prompt ?? ''}\n\nJudge only what is visible in the image. End with exactly one line: "VERDICT: PASS" or "VERDICT: FAIL".`;
  let text: string;
  try {
    const review = await o.reviewImage(image, prompt);
    text = review.text;
  } catch (e) {
    return {
      status: 'inconclusive',
      evidence: [imageEvidence],
      command: gate.capture,
      details: `visual-semantic review could not run: ${(e as Error).message}`,
    };
  }
  const reviewArtifact = writeArtifact(o.paths, o.task.id, `visual-semantic-${label}`, text || '(no review)');
  const verdicts = [...text.matchAll(/VERDICT:\s*(PASS|FAIL)/gi)];
  const verdict = verdicts.length ? verdicts[verdicts.length - 1][1].toUpperCase() : undefined;
  return {
    status: verdict === 'PASS' ? 'pass' : verdict === 'FAIL' ? 'fail' : 'inconclusive',
    evidence: [imageEvidence, ...(reviewArtifact ? [reviewArtifact] : [])],
    command: gate.capture,
    details: verdict
      ? `visual-semantic review ${verdict === 'PASS' ? 'passed' : 'failed'}: ${squash(text, 240)}`
      : `visual-semantic review had no PASS/FAIL verdict: ${squash(text, 240)}`,
  };
}

function runHumanGate(o: EvaluateAcceptanceOptions, criterion: AcceptanceCriterion, gate: AcceptanceGateSpec, results: readonly GateResult[]): GateOutcome {
  const revision = o.revision.tree;
  const evidenceHash = criterionEvidenceHash(criterion, results, revision);
  const approvals = readApprovals(o.paths, o.task.id);
  const matching = approvals.filter((a) =>
    a.criterionId === criterion.id
    && a.revision === revision
    && a.evidenceHash === evidenceHash
    && (!gate.approver || a.approver === gate.approver));
  const approval = matching[matching.length - 1];
  if (approval) {
    return {
      status: 'pass',
      evidence: [{
        kind: 'approval',
        path: rel(o.paths.root, approvalsPath(o.paths, o.task.id)),
        sha256: createHash('sha256').update(JSON.stringify(approval)).digest('hex'),
        approver: approval.approver,
        at: approval.at,
        outputTail: approval.note,
      }],
      details: `approved by ${approval.approver} at ${approval.at}${approval.note ? ` — ${approval.note}` : ''}`,
    };
  }
  const stale = approvals.filter((a) => a.criterionId === criterion.id).length > 0;
  return {
    status: 'pending_human',
    evidence: [],
    details: stale
      ? `approval for ${criterion.id} is stale: the worktree or its evidence changed since it was recorded`
      : `waiting for human approval of ${criterion.id} (symphony approve ${o.task.id} ${criterion.id})`,
  };
}

/**
 * Run the supported gates and record immutable, revision-bound results.
 *
 * Evidence acquisition (metric sampling, screenshots, vision review) is retried and, when it still
 * cannot produce evidence, recorded as `inconclusive` rather than a task failure. Human gates run last
 * so their approval hash covers every other gate for the criterion.
 */
export async function evaluateAcceptance(o: EvaluateAcceptanceOptions): Promise<{
  decision: AcceptanceDecision;
  results: GateResult[];
  summary: AcceptanceSummary;
}> {
  const results: GateResult[] = [];
  const configRev = configRevision(o.config);
  const verifyCache = new Map<string, { res: VerifyResult; evidence: GateEvidence[]; repaired: boolean }>();

  const makeResult = (
    criterionId: string,
    gate: SupportedGateKind,
    outcome: GateOutcome,
  ): GateResult => ({
    criterionId,
    gate,
    status: outcome.status,
    revision: { ...o.revision, taskBaseSha: o.taskBaseSha },
    evidence: outcome.evidence,
    evaluator: { kind: 'harness', version: ACCEPTANCE_ENGINE_VERSION, configRevision: configRev },
    createdAt: nowIso(),
    ...(outcome.command ? { command: outcome.command } : {}),
    ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    ...(outcome.value !== undefined ? { value: outcome.value } : {}),
    ...(outcome.samples !== undefined ? { samples: outcome.samples } : {}),
    details: outcome.details,
  });

  const runGate = async (criterion: AcceptanceCriterion, gate: AcceptanceGateSpec, label: string): Promise<GateResult> => {
    let result: GateResult;
    try {
      if (gate.kind === 'verify') {
        const command = gate.command ?? '';
        const timeoutMin = gate.timeoutMin && gate.timeoutMin > 0 ? gate.timeoutMin : o.config.verifyTimeoutMin;
        const timeoutMs = Math.max(1, Math.round(timeoutMin * 60_000));
        const key = `${command}\0${timeoutMs}`;
        let ran = verifyCache.get(key);
        if (!ran) {
          let res = o.runVerify(command, timeoutMs);
          // An incomplete verify (timeout/spawn/network) is not a task failure. Retry it first.
          for (let attempt = 0; !res.ok && res.code === null && attempt < Math.max(0, o.verifyRetries ?? 0); attempt++) {
            if (o.retryDelayMs && o.retryDelayMs > 0) await sleep(o.retryDelayMs);
            res = o.runVerify(command, timeoutMs);
          }
          let repaired = false;
          if (!res.ok && o.repair) {
            repaired = await o.repair(command, res);
            if (repaired) res = o.runVerify(command, timeoutMs);
          }
          const artifact = writeArtifact(o.paths, o.task.id, `verify-${label}`, res.output || '(no output)');
          ran = { res, evidence: artifact ? [artifact] : [], repaired };
          verifyCache.set(key, ran);
        }
        const status: GateStatus = ran.res.ok ? 'pass' : ran.res.code === null ? 'inconclusive' : 'fail';
        result = makeResult(criterion.id, 'verify', {
          status,
          evidence: ran.evidence,
          command,
          exitCode: ran.res.code ?? undefined,
          details: ran.res.ok
            ? `verify passed${ran.repaired ? ' after a focused repair' : ''}: ${command}`
            : ran.res.code === null
              ? `verify could not complete${ran.repaired ? ' after a focused repair' : ''}: ${command}${ran.res.output ? ` — ${squash(ran.res.output, 240)}` : ''}`
              : `verify failed${ran.repaired ? ' after a focused repair' : ''} (exit ${ran.res.code}): ${command}${ran.res.output ? ` — ${squash(ran.res.output, 240)}` : ''}`,
        });
        if (ran.repaired) result.repaired = true;
      } else if (gate.kind === 'diff') {
        const files = o.changedFiles(o.taskBaseSha);
        const selected = gate.paths?.length
          ? files.filter((file) => gate.paths!.some((prefix) => matchesPath(file, prefix)))
          : files;
        result = makeResult(criterion.id, 'diff', {
          status: selected.length ? 'pass' : 'fail',
          evidence: [{ kind: 'files', outputTail: selected.slice(0, 200).join('\n') }],
          details: selected.length
            ? `${selected.length} changed file${selected.length === 1 ? '' : 's'}${gate.paths?.length ? ` under ${gate.paths.join(', ')}` : ''}`
            : `no changed files${gate.paths?.length ? ` under ${gate.paths.join(', ')}` : ''}`,
        });
      } else if (gate.kind === 'metric') {
        result = makeResult(criterion.id, 'metric', await runMetricGate(o, gate, label));
      } else if (gate.kind === 'visual-regression' || gate.kind === 'visual-layout') {
        result = makeResult(criterion.id, gate.kind, await runVisualGate(o, gate, label));
      } else if (gate.kind === 'visual-semantic') {
        result = makeResult(criterion.id, 'visual-semantic', await runVisualSemanticGate(o, gate, label));
      } else {
        result = makeResult(criterion.id, 'human', runHumanGate(o, criterion, gate, results));
      }
    } catch (e) {
      result = makeResult(criterion.id, gate.kind, {
        status: 'inconclusive',
        evidence: [],
        details: `acceptance gate failed to run: ${(e as Error).message}`,
      });
    }
    appendGateResult(o.paths, o.task.id, result);
    results.push(result);
    o.log?.info(`${o.task.id}: acceptance ${criterion.id}/${gate.kind} ${result.status}${result.details ? ` — ${result.details}` : ''}`);
    return result;
  };

  for (const criterion of o.spec.criteria) {
    for (const gate of criterion.gates) {
      if (gate.kind === 'human') continue;
      await runGate(criterion, gate, criterion.id);
    }
  }
  // Human approvals are bound to the evidence above, so they must be evaluated after it exists.
  for (const criterion of o.spec.criteria) {
    for (const gate of criterion.gates) {
      if (gate.kind !== 'human') continue;
      await runGate(criterion, gate, criterion.id);
    }
  }

  const decision = decideAcceptance(o.spec, results, o.revision.tree);
  const summary: AcceptanceSummary = {
    version: 2,
    revision: o.revision.tree,
    taskBaseSha: o.taskBaseSha,
    status: decision.status,
    criteria: decision.criteria.map((c) => ({ id: c.id, status: c.status, ...(c.reason ? { reason: c.reason } : {}) })),
    at: nowIso(),
  };
  return { decision, results, summary };
}
