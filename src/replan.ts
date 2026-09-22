import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { scaffoldDocs } from './commands.js';
import { resolveSession } from './config.js';
import { docsContract } from './contract.js';
import { commitAll, currentBranch, describeCommit, ensureGitignore } from './git.js';
import { docsTree, formatLint, lintDocs, type LintReport } from './lint.js';
import type { Logger } from './logger.js';
import { rel, stopIgnoreEntry, type Paths } from './paths.js';
import { lintCommand, runDocsSession } from './prepare.js';
import { nextAdrNumber } from './prompt.js';
import { getProvider } from './providers/index.js';
import { idFromNum, parseRoadmap, patchRoadmapFile } from './roadmap.js';
import { haltBanner, preflight, type RunContext } from './runner.js';
import { acquireLock, HELD_STATES, releaseLock, saveState, startLockHeartbeat, type State, type TaskStatus } from './state.js';
import { updatePipelineStatus } from './status.js';
import { discoverTasks, type Task } from './tasks.js';
import { renderPrompt } from './templates.js';
import { UsageError, clip } from './util.js';

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

  const { spec, warnings } = resolveSession(config, undefined, ctx.cli, process.env, (p) => getProvider(p).supportsBudget);
  warnings.forEach((w) => log.warn(w));
  const provider = getProvider(spec.providerName);
  const prompt = buildReplanPrompt(ctx, report, direction);

  if (opts.dryRun) {
    log.plain(`\nprovider: ${spec.providerName} [${spec.sources.provider}] · model: ${spec.model ?? 'provider default'} [${spec.sources.model}] · timeout ${config.prepareTimeoutMin} min`);
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
