import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { BreakdownEvidence } from './breakdown.js';
import { scaffoldDocs } from './commands.js';
import { resolveSession } from './config.js';
import { docsContract } from './contract.js';
import { commitAll, currentBranch, describeCommit, ensureGitignore, restoreWorktree, snapshotWorktree } from './git.js';
import { checkAutoCreatedTasks } from './graph.js';
import { docsTree, formatLint, lintDocs, type LintReport } from './lint.js';
import type { Logger } from './logger.js';
import { rel, stopIgnoreEntry, type Paths } from './paths.js';
import { lintCommand, runDocsSession } from './prepare.js';
import { nextAdrNumber } from './prompt.js';
import { getProvider, variantSupported } from './providers/index.js';
import { idFromNum, parseRoadmap, patchRoadmapFile } from './roadmap.js';
import { haltBanner, preflight, type RunContext } from './runner.js';
import { acquireLock, DONE_STATES, HELD_STATES, releaseLock, saveState, startLockHeartbeat, type State, type TaskStatus } from './state.js';
import { updatePipelineStatus } from './status.js';
import { discoverTasks, parseFrontMatter, type Task } from './tasks.js';
import { renderPrompt } from './templates.js';
import { UsageError, clip, squash } from './util.js';

/** The task-file bodies of a discovered plan, for parsing acceptance items and dependency edges. */
function taskBodies(tasks: Task[]): Map<string, string | undefined> {
  const bodies = new Map<string, string | undefined>();
  for (const t of tasks) {
    bodies.set(t.id, t.taskFile && existsSync(t.taskFile) ? parseFrontMatter(readFileSync(t.taskFile, 'utf8')).body : undefined);
  }
  return bodies;
}

/** Reject a rewrite that would create a duplicate, depth-overflowing or DAG-breaking task. */
function assertPlanInvariants(ctx: RunContext, before: Task[], after: Task[]): string | undefined {
  const issues = checkAutoCreatedTasks(before, after, taskBodies(after), { maxSplitDepth: ctx.config.ceiling.maxSplitDepth });
  if (!issues.length) return undefined;
  for (const issue of issues) ctx.log.error(`replan: ${issue.taskId}: ${issue.message}`);
  return issues[0].message;
}

const ROADMAP_CAP = 16 * 1024;
const DIRECTION_CAP = 32 * 1024;

export interface ReplanDirection {
  /** Path relative to the project root, for the prompt. */
  path: string;
  body: string;
}

export interface ReplanOptions {
  /** Direction document: a path relative to the root, or absolute. Defaults to `<docs>/REPLAN.md`. */
  direction?: string;
  dryRun: boolean;
  /** Accept an id whose task already ran for different work, clearing its state. */
  allowIdReuse: boolean;
  /** Clear all task state so the new plan runs from the start. */
  resetState: boolean;
}

export interface ReplanConflict {
  id: string;
  oldTitle: string;
  newTitle: string;
  status: TaskStatus;
}

export interface ReplanStatePlan {
  conflicts: ReplanConflict[];
  /** State rows whose id is not in the new roadmap. */
  removed: string[];
}

/** One phase's id block: the ids already used in it and the next free id that keeps the block growing. */
export interface PhaseIdBlock {
  phase: string;
  min: number;
  max: number;
  nextId: string;
}

/**
 * The next free id in each phase, so tracks/id blocks can grow independently instead of every new task
 * being appended after the global maximum. Gaps between blocks are expected; the returned next id skips
 * any number already used anywhere, so an interleaved roadmap cannot produce a collision.
 */
export function phaseIdBlocks(tasks: Task[]): PhaseIdBlock[] {
  const used = new Set(tasks.map((t) => t.num));
  const span = new Map<string, { min: number; max: number }>();
  for (const t of tasks) {
    const cur = span.get(t.phase);
    if (!cur) span.set(t.phase, { min: t.num, max: t.num });
    else span.set(t.phase, { min: Math.min(cur.min, t.num), max: Math.max(cur.max, t.num) });
  }
  const out: PhaseIdBlock[] = [];
  for (const [phase, { min, max }] of span) {
    let n = max + 1;
    while (used.has(n)) n++;
    used.add(n);
    out.push({ phase, min, max, nextId: idFromNum(n) });
  }
  return out;
}

/** The per-phase id blocks as a prompt section, one line each. */
function formatIdBlocks(tasks: Task[]): string {
  const blocks = phaseIdBlocks(tasks);
  if (!blocks.length) return '(no tasks yet — start at T01)';
  return blocks.map((b) => `- ${b.phase}: ids up to ${idFromNum(b.max)} used; next free ${b.nextId}`).join('\n');
}

/** Resolve the direction document, defaulting to `<docs>/REPLAN.md`. */
export function resolveDirection(paths: Paths, direction: string | undefined): ReplanDirection {
  const fallback = join(paths.docs, 'REPLAN.md');
  const file = direction ? (isAbsolute(direction) ? direction : resolve(paths.root, direction)) : fallback;
  if (!existsSync(file)) {
    throw new UsageError(
      direction
        ? `--direction ${direction}: no such file (${file})`
        : `no direction given: write ${rel(paths.root, fallback)} or pass --direction FILE`,
    );
  }
  const body = readFileSync(file, 'utf8').trim();
  if (!body) throw new UsageError(`direction document ${rel(paths.root, file)} is empty`);
  return { path: rel(paths.root, file), body };
}

/** Compare the state rows with the rewritten roadmap: what disappeared, and which ids were reused. */
export function planReplanState(state: State, tasks: Task[]): ReplanStatePlan {
  const live = new Set(tasks.map((t) => t.id));
  const removed = Object.keys(state.tasks).filter((id) => !live.has(id));
  const conflicts: ReplanConflict[] = [];
  for (const t of tasks) {
    const row = state.tasks[t.id];
    if (!row?.title) continue;
    if (HELD_STATES.includes(row.status) && row.title !== t.title) {
      conflicts.push({ id: t.id, oldTitle: row.title, newTitle: t.title, status: row.status });
    }
  }
  return { conflicts, removed };
}

/**
 * Reconcile state with the rewritten plan: prune rows for tasks that no longer exist, clear reused
 * ids when allowed, or wipe everything for `--reset-state`. Returns the ids whose state was cleared.
 */
export function applyReplanState(
  paths: Paths,
  state: State,
  plan: ReplanStatePlan,
  opts: { allowIdReuse: boolean; resetState: boolean },
  log: Logger,
): string[] {
  const cleared: string[] = [];
  if (opts.resetState) {
    cleared.push(...Object.keys(state.tasks));
    state.tasks = {};
    delete state.halted;
    log.warn('replan: --reset-state cleared all task state; every task will run from the start');
  } else {
    for (const id of plan.removed) {
      delete state.tasks[id];
      log.info(`replan: pruned state for ${id} (no longer in the roadmap)`);
    }
    if (opts.allowIdReuse) {
      for (const c of plan.conflicts) {
        delete state.tasks[c.id];
        cleared.push(c.id);
        log.warn(`replan: ${c.id} reused (was "${c.oldTitle}" [${c.status}], now "${c.newTitle}"); state cleared so it runs`);
      }
    }
  }
  saveState(paths, state);
  return cleared;
}

export function buildReplanPrompt(ctx: RunContext, report: LintReport, direction: ReplanDirection): string {
  const { paths, config } = ctx;
  const d = {
    roadmap: rel(paths.root, paths.roadmap),
    progress: rel(paths.root, paths.progress),
    tasks: rel(paths.root, paths.tasksDir),
    design: rel(paths.root, paths.designDir),
    adr: rel(paths.root, paths.adrDir),
    docs: rel(paths.root, paths.docs),
  };
  const design = config.designDocs;
  const findings = report.findings.length
    ? report.findings.map((x) => `${x.level === 'error' ? '✗' : x.level === 'warn' ? '!' : '·'} ${x.code}: ${x.message}`).join('\n')
    : '(none)';
  const roadmap = existsSync(paths.roadmap) ? clip(readFileSync(paths.roadmap, 'utf8'), ROADMAP_CAP) : '(missing)';
  const tree = docsTree(paths);
  const maxNum = ctx.tasks.reduce((m, t) => Math.max(m, t.num), 0);
  const nextAdr = nextAdrNumber(paths.adrDir);
  const designRules = design
    ? `- Update the design docs under ${d.design}/ to the new architecture. Record the pivot as an ADR at ${d.adr}/NNNN-title.md with the next free number ${nextAdr} and sections Status / Context / Decision / Consequences; in it, mark the design docs it supersedes as "superseded by ${nextAdr}".\n`
    : '';

  const vars: Record<string, string | number> = {
    projectName: basename(paths.root),
    root: paths.root,
    directionPath: direction.path,
    directionBody: clip(direction.body, DIRECTION_CAP),
    contract: docsContract(paths, { design }),
    findings,
    docsDir: d.docs,
    tree: tree.length ? tree.join('\n') : '(empty)',
    roadmapPath: d.roadmap,
    roadmapContent: roadmap,
    progress: d.progress,
    tasks: d.tasks,
    designPhrase: design ? ` and the design docs under ${d.design}/` : '',
    designDir: d.design,
    nextId: idFromNum(maxNum + 1),
    idBlocks: formatIdBlocks(ctx.tasks),
    designRules,
    lintCommand: lintCommand(ctx),
  };
  return renderPrompt('replan.md', vars);
}

/** Lint, let the configured agent rewrite the plan for the new direction, then commit it. */
export async function replanCommand(ctx: RunContext, opts: ReplanOptions): Promise<number> {
  const { paths, config, log, state } = ctx;
  const docsRel = rel(paths.root, paths.docs);
  const direction = resolveDirection(paths, opts.direction);

  const before = lintDocs(paths, { design: config.designDocs });
  log.plain('--- lint (before)');
  formatLint(before).forEach((l) => log.plain(l));

  if (!existsSync(paths.roadmap)) {
    log.error(`replan: ${rel(paths.root, paths.roadmap)} is missing; there is no plan to pivot from. Run \`symphony init\` first.`);
    return 2;
  }

  // Deterministic skeleton first so the agent always has tasks/ and design/ to write into.
  const created = scaffoldDocs(paths, { roadmap: false, config: false, design: config.designDocs });
  created.forEach((p) => log.info(`created ${relative(paths.root, p)}`));
  const stopEntry = stopIgnoreEntry(paths);
  const added = ensureGitignore(paths.root, ['.symphony/', ...(stopEntry ? [stopEntry] : [])]);
  if (added.length) log.info(`added ${added.join(', ')} to ${join(paths.root, '.gitignore')}`);
  const report = created.length || added.length ? lintDocs(paths, { design: config.designDocs }) : before;

  if (state.halted) { haltBanner(ctx, state.halted); return 3; }

  const { spec, warnings } = resolveSession(config, undefined, ctx.cli, process.env, (p) => getProvider(p).supportsBudget, variantSupported);
  warnings.forEach((w) => log.warn(w));
  const provider = getProvider(spec.providerName);
  const prompt = buildReplanPrompt(ctx, report, direction);

  if (opts.dryRun) {
    log.plain(`\nprovider: ${spec.providerName} [${spec.sources.provider}] · model: ${spec.model ?? 'provider default'} [${spec.sources.model}]${spec.variant ? ` · variant: ${spec.variant} [${spec.sources.variant}]` : ''} · timeout ${config.prepareTimeoutMin} min`);
    log.plain(`--- replan prompt (${Buffer.byteLength(prompt, 'utf8')} bytes) ---\n${prompt}--- end prompt ---`);
    return 0;
  }
  if (!preflight(ctx, spec, provider, { skipRoadmap: true })) { log.error('preflight failed; fix the ✗ items above'); return 4; }

  acquireLock(paths);
  ctx.startBranch = currentBranch(paths.root);
  const stopHeartbeat = startLockHeartbeat(paths);
  try {
    const label = `replan: rewriting ${docsRel}/ from ${direction.path}`;
    const { outcome, early } = await runDocsSession(ctx, spec, provider, { prompt, runName: 'replan', taskId: 'replan', label, timeoutMin: config.prepareTimeoutMin });
    if (early !== undefined) return early;

    const after = lintDocs(paths, { design: config.designDocs });
    log.plain('--- lint (after)');
    formatLint(after).forEach((l) => log.plain(l));
    if (!after.ok) {
      log.error(`${docsRel}/ is still not in the expected format after replanning; fix the ✗ items by hand or run \`symphony replan\` again`);
      return 2;
    }

    // The agent rewrote the plan on disk: reload it and reconcile the harness state with it.
    if (!existsSync(paths.roadmap)) {
      log.error(`replan: the agent removed ${rel(paths.root, paths.roadmap)}; refusing to commit. Restore it or run \`symphony prepare\`.`);
      return 2;
    }
    let newTasks: Task[];
    try {
      const roadmap = parseRoadmap(readFileSync(paths.roadmap, 'utf8'));
      const discovered = discoverTasks(paths, roadmap);
      newTasks = discovered.tasks;
      discovered.warnings.forEach((w) => log.warn(w));
    } catch (e) {
      log.error(`replan: the rewritten plan does not parse (${(e as Error).message}); refusing to commit.`);
      return 2;
    }
    const invariantError = assertPlanInvariants(ctx, ctx.tasks, newTasks);
    if (invariantError) {
      log.error('replan: refusing to commit. Rename the duplicate or depth-overflowing ticket, fix the dependency edges, or adjust ceiling.maxSplitDepth.');
      return 2;
    }
    const plan = planReplanState(state, newTasks);
    if (plan.conflicts.length && !opts.allowIdReuse && !opts.resetState) {
      for (const c of plan.conflicts) log.error(`replan: ${c.id} was reused for different work: it already ran as "${c.oldTitle}" [${c.status}] but the new plan titles it "${c.newTitle}"`);
      log.error('replan: refusing to commit. Rename or renumber those tasks, or re-run with `symphony replan --allow-id-reuse` to accept and clear their state, or `--reset-state` to clear all state.');
      return 2;
    }

    const cleared = applyReplanState(paths, state, plan, { allowIdReuse: opts.allowIdReuse, resetState: opts.resetState }, log);
    // Cleared tasks must not be resurrected from a leftover [x] marker by the next reconcile.
    const repend = opts.resetState ? newTasks.map((t) => t.id) : cleared;
    for (const id of repend) {
      try { patchRoadmapFile(paths.roadmap, id, 'pending'); } catch { /* reported by run */ }
    }
    updatePipelineStatus(paths, newTasks, state, log);

    const commit = commitAll(paths.root, `docs: replan ${docsRel} [replan]`, (m) => log.warn(m), { autoIgnoreUntracked: config.git.autoIgnoreUntracked, extraIgnore: config.git.extraIgnore, expectedBranch: ctx.startBranch });
    log.info(`replan: git ${describeCommit(commit)}${outcome.costUsd !== undefined ? ` · $${outcome.costUsd.toFixed(2)}` : ''}`);
    log.info(`replan: ${newTasks.length} task${newTasks.length === 1 ? '' : 's'} in the new plan; next: \`symphony run\``);
    return 0;
  } finally {
    stopHeartbeat();
    releaseLock(paths);
  }
}

/** One automatic replan: the exit code, a detail on failure, and the ids the rewritten plan queues next. */
export interface ReplanResult {
  code: number;
  error?: string;
  /** Task ids in the rewritten plan that have not finished, in roadmap order (for logs/toasts). */
  pending?: string[];
}

/** A one-line statement of the stage for the auto-replan prompt, and the evidence line beneath it. */
function autoReplanEvidence(ev: BreakdownEvidence): { stageLine: string; label: string; text: string } {
  const task = `${ev.task.id} — ${ev.task.title}`;
  if (ev.stage === 'failure') {
    return {
      stageLine: 'it failed, and the decision was that the plan around it — not just the task — is the problem.',
      label: `failure (${ev.category ?? 'task'})`,
      text: squash(ev.reason ?? '(no message)', 2000),
    };
  }
  if (ev.stage === 'blocked') {
    return {
      stageLine: 'it reported blocked, and the decision was that the upcoming plan should be reshaped around the human item.',
      label: 'block summary',
      text: squash(ev.reason ?? '(none given)', 2000),
    };
  }
  if (ev.stage === 'continue') {
    return {
      stageLine: `it has used ${ev.continuations} continuation slice(s) without finishing, and the decision was that the plan itself is the problem.`,
      label: 'last slice reported',
      text: squash(ev.reason ?? 'continue', 2000),
    };
  }
  return {
    stageLine: 'it is about to start, and the decision was that the upcoming plan is wrong enough to fix before running anything.',
    label: 'trigger',
    text: `breaks down was considered for ${task} at its start (${ev.attempts} session(s) recorded so far)`,
  };
}

/** The prompt for an automatic replan: the trigger, the plan, the rules, and the free child ids. */
export function buildAutoReplanPrompt(ctx: RunContext, ev: BreakdownEvidence, report: LintReport, decisionReason = ''): string {
  const { paths, config } = ctx;
  const d = {
    roadmap: rel(paths.root, paths.roadmap),
    progress: rel(paths.root, paths.progress),
    tasks: rel(paths.root, paths.tasksDir),
    design: rel(paths.root, paths.designDir),
    adr: rel(paths.root, paths.adrDir),
    docs: rel(paths.root, paths.docs),
  };
  const findings = report.findings.length
    ? report.findings.map((x) => `${x.level === 'error' ? '✗' : x.level === 'warn' ? '!' : '·'} ${x.code}: ${x.message}`).join('\n')
    : '(none)';
  const roadmap = existsSync(paths.roadmap) ? clip(readFileSync(paths.roadmap, 'utf8'), ROADMAP_CAP) : '(missing)';
  const tree = docsTree(paths);
  const maxNum = ctx.tasks.reduce((m, t) => Math.max(m, t.num), 0);
  const evidence = autoReplanEvidence(ev);

  const vars: Record<string, string | number> = {
    projectName: basename(paths.root),
    root: paths.root,
    stage: ev.stage,
    stageLine: evidence.stageLine,
    taskId: ev.task.id,
    taskTitle: ev.task.title,
    taskPhase: ev.task.phase,
    status: ev.status,
    attempts: ev.attempts,
    continuations: ev.continuations,
    evidenceLabel: evidence.label,
    evidence: evidence.text,
    decisionReason: decisionReason || 'the upcoming plan should be rewritten',
    taskBody: ev.taskBody?.trim() ? clip(ev.taskBody, 12_000) : '(no task file — the roadmap bullet is the whole task)',
    contract: docsContract(paths, { design: config.designDocs }),
    findings,
    docsDir: d.docs,
    tree: tree.length ? tree.join('\n') : '(empty)',
    roadmapPath: d.roadmap,
    roadmapContent: roadmap,
    progress: d.progress,
    tasks: d.tasks,
    nextId: idFromNum(maxNum + 1),
    idBlocks: formatIdBlocks(ctx.tasks),
    lintCommand: lintCommand(ctx),
  };
  return renderPrompt('replan-auto.md', vars);
}

/** The verdict on an automatic replan's rewrite, before anything is recorded. */
export interface AutoReplanCheck {
  ok: boolean;
  errors: string[];
  /** Ids of tasks in the rewritten plan that have not finished, in roadmap order. */
  pending: string[];
}

/**
 * Validate an automatic replan against the harness state: the rewrite must not remove or retitle a
 * task that already ran (done, accepted or blocked), and must leave at least one task. Pure, so the
 * rules are testable without running an agent.
 */
export function checkAutoReplanState(state: State, tasks: Task[]): AutoReplanCheck {
  const errors: string[] = [];
  if (!tasks.length) errors.push('the rewrite left no tasks in the roadmap');
  const plan = planReplanState(state, tasks);
  for (const id of plan.removed) {
    const status = state.tasks[id]?.status;
    if (status !== undefined && HELD_STATES.includes(status)) {
      errors.push(`${id} already ran [${status}] but the rewrite removed it; finished work must be preserved`);
    }
  }
  for (const c of plan.conflicts) {
    errors.push(`${c.id} was retitled: it already ran as "${c.oldTitle}" [${c.status}] but the new plan calls it "${c.newTitle}"; finished work must be preserved`);
  }
  return { ok: errors.length === 0, errors, pending: tasks.filter((t) => !DONE_STATES.includes(state.tasks[t.id]?.status ?? 'pending')).map((t) => t.id) };
}

/**
 * Rewrite the upcoming part of the plan on an open breakdown verdict of `replan`: one docs session
 * reshapes `ROADMAP.md` and the task files, then the rewrite is validated — finished work must be
 * untouched, removed rows must not have run — and committed. The caller (a live run) already holds
 * the lock and reloads the plan on success. Pure plan work: no application code, no design docs.
 */
export async function replanForBreakdown(ctx: RunContext, ev: BreakdownEvidence, opts: { dryRun?: boolean; decisionReason?: string } = {}): Promise<ReplanResult> {
  const { paths, config, log, state } = ctx;
  const docsRel = rel(paths.root, paths.docs);
  const fail = (code: number, error: string): ReplanResult => ({ code, error });

  if (state.halted && state.halted.taskId !== ev.task.id) {
    haltBanner(ctx, state.halted);
    return fail(3, `halted on ${state.halted.taskId ?? '?'} (${state.halted.category})`);
  }

  // A refused automatic replan must not leave its half-written plan in the worktree: the run carries
  // on with the task afterwards and its final commit would otherwise sweep the rejected rewrite in.
  const snapshot = snapshotWorktree(paths.root);
  const reject = (code: number, error: string): ReplanResult => {
    restoreWorktree(paths.root, snapshot);
    log.warn(`replan: restored the working tree; the refused rewrite around ${ev.task.id} was discarded`);
    return fail(code, error);
  };

  let findings = lintDocs(paths, { design: config.designDocs });
  log.plain('--- lint (before)');
  formatLint(findings).forEach((l) => log.plain(l));

  // Deterministic skeleton first, so the session always has tasks/ to write into.
  const created = scaffoldDocs(paths, { roadmap: false, config: false, design: config.designDocs });
  created.forEach((p) => log.info(`created ${relative(paths.root, p)}`));
  const stopEntry = stopIgnoreEntry(paths);
  const added = ensureGitignore(paths.root, ['.symphony/', ...(stopEntry ? [stopEntry] : [])]);
  if (added.length) log.info(`added ${added.join(', ')} to ${join(paths.root, '.gitignore')}`);
  if (created.length || added.length) findings = lintDocs(paths, { design: config.designDocs });

  const { spec, warnings } = resolveSession(config, undefined, ctx.cli, process.env, (p) => getProvider(p).supportsBudget, variantSupported);
  warnings.forEach((w) => log.warn(w));
  const provider = getProvider(spec.providerName);
  const prompt = buildAutoReplanPrompt(ctx, ev, findings, opts.decisionReason);

  if (opts.dryRun) {
    log.plain(`\nprovider: ${spec.providerName} [${spec.sources.provider}] · model: ${spec.model ?? 'provider default'} [${spec.sources.model}]${spec.variant ? ` · variant ${spec.variant} [${spec.sources.variant}]` : ''} · timeout ${config.prepareTimeoutMin} min`);
    log.plain(`--- auto-replan prompt (${Buffer.byteLength(prompt, 'utf8')} bytes) ---\n${prompt}--- end prompt ---`);
    return { code: 0 };
  }

  const label = `replan: reshaping the upcoming plan around ${ev.task.id} — ${ev.task.title}`;
  const { outcome, early } = await runDocsSession(ctx, spec, provider, {
    prompt, runName: `replan-${ev.task.id}`, taskId: `replan-${ev.task.id}`, label, timeoutMin: config.prepareTimeoutMin,
  });
  if (early !== undefined) return reject(early, `replan session ended early (exit ${early})`);

  const after = lintDocs(paths, { design: config.designDocs });
  log.plain('--- lint (after)');
  formatLint(after).forEach((l) => log.plain(l));
  if (!after.ok) {
    log.error(`${docsRel}/ is still not in the expected format after the replan; fix the ✗ items by hand or let a later run try again`);
    return reject(2, `${docsRel}/ is still not in the expected format after the replan`);
  }

  // The agent rewrote the plan on disk: reload it and check the rewrite before committing.
  let newTasks: Task[];
  try {
    const roadmap = parseRoadmap(readFileSync(paths.roadmap, 'utf8'));
    const discovered = discoverTasks(paths, roadmap);
    newTasks = discovered.tasks;
    discovered.warnings.forEach((w) => log.warn(w));
  } catch (e) {
    log.error(`replan: the rewritten plan does not parse (${(e as Error).message}); refusing to commit.`);
    return reject(2, 'the rewritten plan does not parse');
  }

  const check = checkAutoReplanState(state, newTasks);
  if (!check.ok) {
    check.errors.forEach((e) => log.error(`replan: ${e}`));
    log.error('replan: refusing to commit. Nothing was recorded.');
    return reject(2, check.errors[0]);
  }
  const invariantError = assertPlanInvariants(ctx, ctx.tasks, newTasks);
  if (invariantError) {
    log.error('replan: refusing to commit. Nothing was recorded.');
    return reject(2, invariantError);
  }

  const plan = planReplanState(state, newTasks);
  applyReplanState(paths, state, plan, { allowIdReuse: false, resetState: false }, log);
  for (const t of newTasks) {
    if (state.tasks[t.id]) continue;
    try { patchRoadmapFile(paths.roadmap, t.id, 'pending'); } catch { /* reported by the run */ }
  }
  updatePipelineStatus(paths, newTasks, state, log);
  const commit = commitAll(paths.root, `docs: auto-replan after ${ev.task.id} (${ev.stage}) [replan]`, (m) => log.warn(m), { autoIgnoreUntracked: config.git.autoIgnoreUntracked, extraIgnore: config.git.extraIgnore, expectedBranch: ctx.startBranch });
  log.info(`replan: git ${describeCommit(commit)}${outcome.costUsd !== undefined ? ` · $${outcome.costUsd.toFixed(2)}` : ''}`);
  log.info(`replan: ${newTasks.length} task${newTasks.length === 1 ? '' : 's'} in the rewritten plan; next: ${check.pending.join(' ') || '(nothing left)'}`);
  return { code: 0, pending: check.pending };
}
