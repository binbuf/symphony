import { canonicalId } from './roadmap.js';
import type { Task } from './tasks.js';

/**
 * The machine-checkable task contract and the dependency DAG it implies.
 *
 * Contract (all optional, all backwards compatible):
 *  - Front matter `dependsOn: T03, T04` (aliases `blockedBy: T03` and `blocks: T07`) declares edges.
 *    `blocks: T07` on T05 means T07 depends on T05; it is normalised into T07's `dependsOn`.
 *  - Acceptance checkboxes may carry a trailing tag:
 *      `- [ ] item`                      blocking (the default)
 *      `- [ ] item [blocking]`           explicit blocking
 *      `- [ ] item [deferrable]`         optional: not required to accept this task
 *      `- [ ] item [deferrable: mcp]`    optional, conditionally on capability `mcp`
 *    A tag in parentheses works the same (`(deferrable: cap)`), and the separator may be a dash.
 *
 * The harness parses this to order work before its consumers, suspend a task whose prerequisites are
 * unmet, and accept the landed green subset of a task whose remainder is deferrable/gated. Prose that
 * does not follow the grammar is simply a blocking item, so existing task files keep working.
 */

export interface AcceptanceItem {
  text: string;
  checked: boolean;
  blocking: boolean;
  /** Capability a deferrable item is gated on, when named. */
  capability?: string;
}

export interface TaskContract {
  /** Ids this task depends on (must land first). Normalised, deduped, in declaration order. */
  dependsOn: string[];
  /** Ids this task blocks (they depend on this task). Normalised, deduped. */
  blocks: string[];
  acceptance: AcceptanceItem[];
}

const EMPTY: TaskContract = { dependsOn: [], blocks: [], acceptance: [] };
const TAG_RE = /[[(]\s*(blocking|deferrable)(?:\s*[:=]\s*([\w.-]+))?\s*[\])]\s*$/i;
const CHECKBOX_RE = /^\s*[-*+]\s*\[([ xX])\]\s+(.*)$/gm;

/** Split a front-matter edge value (`T03, T04 T05`) into ids. */
function edgeIds(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(/[\s,;]+/)) {
    if (!raw) continue;
    const id = canonicalId(raw.replace(/^[:,]+/, ''));
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/** Parse the acceptance checkboxes of a task body, honouring the blocking/deferrable tags. */
export function parseAcceptance(body: string | undefined): AcceptanceItem[] {
  if (!body) return [];
  const out: AcceptanceItem[] = [];
  for (const m of body.matchAll(CHECKBOX_RE)) {
    let text = m[2].trim();
    let blocking = true;
    let capability: string | undefined;
    const tag = TAG_RE.exec(text);
    if (tag) {
      blocking = tag[1].toLowerCase() === 'blocking';
      capability = tag[2];
      text = text.slice(0, tag.index).trim();
    }
    out.push({ text, checked: m[1].toLowerCase() === 'x', blocking, capability });
  }
  return out;
}

/** Build the contract for one task from its front matter and body. */
export function parseContract(meta: Record<string, string> | undefined, body: string | undefined): TaskContract {
  const m = meta ?? {};
  const dependsOn = edgeIds(m.dependsOn ?? m.depends ?? m.blockedBy ?? m['blocked-by']);
  const blocks = edgeIds(m.blocks ?? m.blocking);
  return { dependsOn, blocks, acceptance: parseAcceptance(body) };
}

/** The contract for every task, resolving `blocks` back-edges into the blocked task's `dependsOn`. */
export function contractsFor(tasks: Task[], bodies: Map<string, string | undefined>): Map<string, TaskContract> {
  const out = new Map<string, TaskContract>();
  for (const t of tasks) out.set(t.id, { ...parseContract(t.meta, bodies.get(t.id)), blocks: [] });
  // Fold each task's `blocks: X` into X.dependsOn (and record the reverse edge on the blocker).
  for (const t of tasks) {
    const declared = parseContract(t.meta, bodies.get(t.id));
    const shaped = out.get(t.id)!;
    shaped.blocks = declared.blocks;
    for (const blockedId of declared.blocks) {
      const target = out.get(blockedId);
      if (target && !target.dependsOn.includes(t.id)) target.dependsOn.push(t.id);
    }
  }
  return out;
}

export interface ContractIssue { taskId: string; message: string }

/** Validate the graph against the known task ids: unknown references and cycles. */
export function validateContracts(tasks: Task[], contracts: Map<string, TaskContract>): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const known = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const dep of contracts.get(t.id)?.dependsOn ?? []) {
      if (!known.has(dep)) issues.push({ taskId: t.id, message: `depends on ${dep}, which is not in ROADMAP.md` });
      if (dep === t.id) issues.push({ taskId: t.id, message: 'depends on itself' });
    }
  }
  const cycle = findCycle(tasks.map((t) => t.id), contracts);
  if (cycle) issues.push({ taskId: cycle[0], message: `dependency cycle: ${cycle.join(' → ')}` });
  return issues;
}

/** Depth-first cycle detection; returns the cycle path when one exists. */
export function findCycle(ids: string[], contracts: Map<string, TaskContract>): string[] | undefined {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(ids.map((id) => [id, WHITE]));
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of contracts.get(id)?.dependsOn ?? []) {
      if (!color.has(dep)) continue;
      const c = color.get(dep);
      if (c === GRAY) return [...stack.slice(stack.indexOf(dep)), dep];
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return undefined;
  };
  for (const id of ids) if (color.get(id) === WHITE) {
    const found = visit(id);
    if (found) return found;
  }
  return undefined;
}

/**
 * A stable topological order: prerequisites before consumers, otherwise the incoming order preserved.
 * Unknown dependencies are ignored (they are reported by `validateContracts`, not reordered blindly).
 */
export function topoOrder(tasks: Task[], contracts: Map<string, TaskContract>): Task[] {
  const index = new Map(tasks.map((t, i) => [t.id, i]));
  const known = new Set(tasks.map((t) => t.id));
  const remaining = tasks.slice();
  const ordered: Task[] = [];
  const placed = new Set<string>();
  while (remaining.length) {
    let progressed = false;
    for (let i = 0; i < remaining.length; i++) {
      const t = remaining[i];
      const deps = (contracts.get(t.id)?.dependsOn ?? []).filter((d) => known.has(d) && !placed.has(d));
      if (deps.length) continue;
      ordered.push(t);
      placed.add(t.id);
      remaining.splice(i, 1);
      progressed = true;
      break;
    }
    if (!progressed) break; // a cycle or unknown edge; caller validates and reports
  }
  // Anything left (cycle) keeps its original order after the resolved prefix.
  remaining.sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
  return [...ordered, ...remaining];
}

/** The transitive prerequisite closure of `ids`, including the ids themselves. */
export function dependencyClosure(ids: string[], contracts: Map<string, TaskContract>): Set<string> {
  const out = new Set<string>();
  const visit = (id: string): void => {
    if (out.has(id)) return;
    out.add(id);
    for (const dep of contracts.get(id)?.dependsOn ?? []) visit(dep);
  };
  for (const id of ids) visit(id);
  return out;
}

export interface AcceptanceSummary {
  total: number;
  checked: number;
  /** Unchecked items that must land before the task can be accepted. */
  unmetBlocking: AcceptanceItem[];
  /** Unchecked items that may be deferred (optionally to a named capability). */
  unmetDeferrable: AcceptanceItem[];
}

export function summarizeAcceptance(acceptance: AcceptanceItem[]): AcceptanceSummary {
  const unmet = acceptance.filter((a) => !a.checked);
  return {
    total: acceptance.length,
    checked: acceptance.length - unmet.length,
    unmetBlocking: unmet.filter((a) => a.blocking),
    unmetDeferrable: unmet.filter((a) => !a.blocking),
  };
}

/**
 * True when every remaining acceptance item is deferrable: all blocking work has landed, so the
 * green subset can be accepted programmatically and the deferrable remainder recorded.
 */
export function isLandedSubset(acceptance: AcceptanceItem[]): boolean {
  if (!acceptance.length) return false;
  const unmet = acceptance.filter((a) => !a.checked);
  return unmet.length > 0 && unmet.every((a) => !a.blocking);
}

export function emptyContract(): TaskContract {
  return { ...EMPTY };
}

export interface PlanInvariantOptions {
  /** Maximum split depth an auto-created task may have. `0` disables the bound. */
  maxSplitDepth: number;
}

/**
 * Hard invariants for any rewrite that can add tasks (an automatic replan, or a generated remainder).
 * An auto-created ticket must not:
 *  - duplicate a task that survives the rewrite (by id or normalised title), so the harness cannot
 *    keep recreating the same missing prerequisite under a new spelling;
 *  - sit deeper than `ceiling.maxSplitDepth` in a split chain; and
 *  - introduce an unknown dependency or a cycle into the task DAG.
 * `before` is the plan prior to the rewrite, `after` the plan it produced; `bodies` maps each after
 * task id to its body so acceptance items and dependency edges can be parsed. Pure and testable.
 */
export function checkAutoCreatedTasks(
  before: Task[],
  after: Task[],
  bodies: Map<string, string | undefined>,
  opts: PlanInvariantOptions,
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const afterIds = new Set(after.map((t) => t.id));
  // A duplicate only counts against work that still exists after the rewrite, plus work this very
  // rewrite already added (so two new tickets cannot share a title either).
  const persistent = before.filter((t) => afterIds.has(t.id));
  const created: Task[] = [];
  for (const t of after) {
    if (afterIds.has(t.id) && before.some((b) => b.id === t.id)) continue; // pre-existing
    if (opts.maxSplitDepth > 0 && splitDepth(t.id) > opts.maxSplitDepth) {
      issues.push({ taskId: t.id, message: `auto-created at split depth ${splitDepth(t.id)}, above ceiling.maxSplitDepth (${opts.maxSplitDepth})` });
    }
    const dup = findDuplicateTask({ title: t.title }, [...persistent, ...created]);
    if (dup && dup.id !== t.id) {
      issues.push({ taskId: t.id, message: `duplicates existing ${dup.id} ("${dup.title}"); reuse or retitle it instead of creating a parallel ticket` });
    }
    created.push(t);
  }
  // Only DAG problems introduced by the newly created tickets block the rewrite: a pre-existing
  // dangling edge or cycle is reported at run time, but must not wedge every future replan.
  const contracts = contractsFor(after, bodies);
  const knownAfter = new Set(after.map((t) => t.id));
  const createdIds = new Set(created.map((t) => t.id));
  for (const t of created) {
    for (const dep of contracts.get(t.id)?.dependsOn ?? []) {
      if (!knownAfter.has(dep)) issues.push({ taskId: t.id, message: `depends on ${dep}, which is not in ROADMAP.md` });
      if (dep === t.id) issues.push({ taskId: t.id, message: 'depends on itself' });
    }
  }
  const cycle = findCycle(after.map((t) => t.id), contracts);
  if (cycle && cycle.some((id) => createdIds.has(id))) {
    issues.push({ taskId: cycle[0], message: `dependency cycle: ${cycle.join(' → ')}` });
  }
  return issues;
}

/** Split depth of a task id: T10 = 0, T10a = 1, T10a1 = 2. Bounds a runaway split chain. */
export function splitDepth(id: string): number {
  const m = /^T?\d{1,3}([a-z]\d*)$/i.exec(id);
  return m ? m[1].length : 0;
}

/**
 * Find an existing task a proposed (auto-created) ticket duplicates, by id or normalised title. The
 * harness never recreates a prerequisite that already exists under a different spelling.
 */
export function findDuplicateTask(proposed: { id?: string; title: string }, tasks: Task[]): Task | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const title = norm(proposed.title);
  if (!title && !proposed.id) return undefined;
  return tasks.find((x) => (proposed.id !== undefined && x.id === proposed.id) || (title !== '' && norm(x.title) === title));
}
