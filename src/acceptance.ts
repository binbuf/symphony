import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { rel, type Paths } from './paths.js';
import type { Task } from './tasks.js';
import { ensureDir, headAndTailBytes, isRecord, nowIso, squash, stamp } from './util.js';
import type { VerifyResult } from './verify.js';

/**
 * Structured acceptance (P0a).
 *
 * A task may contain one fenced `symphony-acceptance` JSON block. Tasks without the block keep the
 * legacy contract unchanged. A v2 contract is explicit: every criterion has a stable id, and every
 * criterion names the gates that prove it. The harness, not the agent's checkboxes, decides whether
 * the task is accepted.
 *
 * P0a implements the deterministic `verify` and `diff` gates. The parser recognises the later gate
 * kinds (metric/visual/semantic/human) so their contracts are explicit from day one, but rejects them
 * until the phase that implements the runner for them.
 */

export type GateStatus = 'pass' | 'fail' | 'inconclusive' | 'pending_human';
export type AcceptanceStatus = 'accepted' | 'failed' | 'inconclusive' | 'pending_human';
export type SupportedGateKind = 'verify' | 'diff';
export type RecognizedGateKind =
  | SupportedGateKind
  | 'semantic'
  | 'metric'
  | 'visual-regression'
  | 'visual-layout'
  | 'visual-semantic'
  | 'human';

export interface AcceptanceGateSpec {
  kind: SupportedGateKind;
  /** verify: the shell command the harness runs itself. */
  command?: string;
  /** verify: wall-clock cap; defaults to config.verifyTimeoutMin. */
  timeoutMin?: number;
  /** diff: optional path prefixes; at least one changed file must match. */
  paths?: string[];
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
  kind: 'command-output' | 'files' | 'artifact' | 'approval';
  /** Path relative to the project root, when the evidence is a file. */
  path?: string;
  sha256?: string;
  command?: string;
  /** A short excerpt; the full artifact is referenced by `path`. */
  outputTail?: string;
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
const SUPPORTED = new Set<SupportedGateKind>(['verify', 'diff']);

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
    errors.push(`${where}.kind "${kind}" is not supported in this build yet (currently verify and diff)`);
    return undefined;
  }

  if (kind === 'verify') {
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) errors.push(`${where}.command is required for a verify gate`);
    let timeoutMin: number | undefined;
    if (raw.timeoutMin !== undefined) {
      if (typeof raw.timeoutMin !== 'number' || !Number.isFinite(raw.timeoutMin) || raw.timeoutMin <= 0) {
        errors.push(`${where}.timeoutMin must be a positive number`);
      } else timeoutMin = raw.timeoutMin;
    }
    return { kind: 'verify', ...(command ? { command } : {}), ...(timeoutMin ? { timeoutMin } : {}) };
  }

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
        && (parsed.gate === 'verify' || parsed.gate === 'diff')
        && (parsed.status === 'pass' || parsed.status === 'fail' || parsed.status === 'inconclusive' || parsed.status === 'pending_human')
        && isRecord(parsed.revision)
        && typeof parsed.revision.tree === 'string') {
        out.push(parsed as unknown as GateResult);
      }
    } catch { /* a partial line from a crash is not a usable result */ }
  }
  return out;
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
  runVerify: (command: string, timeoutMs: number) => VerifyResult;
  changedFiles: (base?: string) => string[];
}

/**
 * Run the supported gates once and record immutable, revision-bound results. P0a deliberately has no
 * recovery loop: a missing/failed gate becomes a non-passing decision, which the runner handles
 * through its ordinary verify recovery. Richer evidence acquisition lands in P0c.
 */
export function evaluateAcceptance(o: EvaluateAcceptanceOptions): {
  decision: AcceptanceDecision;
  results: GateResult[];
  summary: AcceptanceSummary;
} {
  const results: GateResult[] = [];
  const configRev = configRevision(o.config);
  const verifyCache = new Map<string, { res: VerifyResult; evidence: GateEvidence[] }>();

  for (const criterion of o.spec.criteria) {
    for (const gate of criterion.gates) {
      let result: GateResult;
      try {
        if (gate.kind === 'verify') {
          const command = gate.command ?? '';
          const timeoutMin = gate.timeoutMin && gate.timeoutMin > 0 ? gate.timeoutMin : o.config.verifyTimeoutMin;
          const timeoutMs = Math.max(1, Math.round(timeoutMin * 60_000));
          const key = `${command}\0${timeoutMs}`;
          let ran = verifyCache.get(key);
          if (!ran) {
            const res = o.runVerify(command, timeoutMs);
            const artifact = writeArtifact(o.paths, o.task.id, `verify-${criterion.id}`, res.output || '(no output)');
            ran = { res, evidence: artifact ? [artifact] : [] };
            verifyCache.set(key, ran);
          }
          const status: GateStatus = ran.res.ok ? 'pass' : ran.res.code === null ? 'inconclusive' : 'fail';
          result = {
            criterionId: criterion.id,
            gate: 'verify',
            status,
            revision: { ...o.revision, taskBaseSha: o.taskBaseSha },
            evidence: ran.evidence,
            evaluator: { kind: 'harness', version: ACCEPTANCE_ENGINE_VERSION, configRevision: configRev },
            createdAt: nowIso(),
            command,
            exitCode: ran.res.code ?? undefined,
            details: ran.res.ok
              ? `verify passed: ${command}`
              : ran.res.code === null
                ? `verify could not complete: ${command}${ran.res.output ? ` — ${squash(ran.res.output, 240)}` : ''}`
                : `verify failed (exit ${ran.res.code}): ${command}${ran.res.output ? ` — ${squash(ran.res.output, 240)}` : ''}`,
          };
        } else {
          const files = o.changedFiles(o.taskBaseSha);
          const selected = gate.paths?.length
            ? files.filter((file) => gate.paths!.some((prefix) => matchesPath(file, prefix)))
            : files;
          result = {
            criterionId: criterion.id,
            gate: 'diff',
            status: selected.length ? 'pass' : 'fail',
            revision: { ...o.revision, taskBaseSha: o.taskBaseSha },
            evidence: [{
              kind: 'files',
              outputTail: selected.slice(0, 200).join('\n'),
            }],
            evaluator: { kind: 'harness', version: ACCEPTANCE_ENGINE_VERSION, configRevision: configRev },
            createdAt: nowIso(),
            details: selected.length
              ? `${selected.length} changed file${selected.length === 1 ? '' : 's'}${gate.paths?.length ? ` under ${gate.paths.join(', ')}` : ''}`
              : `no changed files${gate.paths?.length ? ` under ${gate.paths.join(', ')}` : ''}`,
          };
        }
      } catch (e) {
        result = {
          criterionId: criterion.id,
          gate: gate.kind,
          status: 'inconclusive',
          revision: { ...o.revision, taskBaseSha: o.taskBaseSha },
          evidence: [],
          evaluator: { kind: 'harness', version: ACCEPTANCE_ENGINE_VERSION, configRevision: configRev },
          createdAt: nowIso(),
          details: `acceptance gate failed to run: ${(e as Error).message}`,
        };
      }
      appendGateResult(o.paths, o.task.id, result);
      results.push(result);
      o.log?.info(`${o.task.id}: acceptance ${criterion.id}/${gate.kind} ${result.status}${result.details ? ` — ${result.details}` : ''}`);
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
