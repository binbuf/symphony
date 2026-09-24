import { existsSync, readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { scaffoldDocs } from './commands.js';
import { resolveSession } from './config.js';
import { docsContract } from './contract.js';
import { commitAll, currentBranch, describeCommit, ensureGitignore } from './git.js';
import { docsTree, formatLint, lintDocs, type LintReport } from './lint.js';
import { rel, stopIgnoreEntry, type Paths } from './paths.js';
import { lintCommand, runDocsSession } from './prepare.js';
import { taskFileBody } from './prompt.js';
import { getProvider, variantSupported } from './providers/index.js';
import { canonicalId, formatTaskId, parseTaskId, parseRoadmap, patchRoadmapFile, statusFromMarkers, type Roadmap } from './roadmap.js';
import { haltBanner, preflight, type RunContext, type RunFlags } from './runner.js';
import { acquireLock, DONE_STATES, releaseLock, saveState, startLockHeartbeat, type State } from './state.js';
import { updatePipelineStatus } from './status.js';
import { discoverTasks, type Task } from './tasks.js';
import { renderPrompt } from './templates.js';
import { UsageError, clip, squash } from './util.js';

const ROADMAP_CAP = 16 * 1024;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

export interface SplitOptions {
  /** The task to break down, in any accepted spelling (T10, 10, t10a). */
  id: string;
  /** Exact number of subtasks; omitted lets the splitting session choose (2–6). */
  into?: number;
  /** Extra guidance handed to the splitting session. */
  note?: string;
  dryRun: boolean;
}

/** The child ids a split of `parent` may use, in execution order, skipping ids already in the roadmap. */
export function childIdsFor(parent: string, taken: Iterable<string> = []): string[] {
  const used = new Set(taken);
  return childIdSequence(parent).filter((id) => !used.has(id));
}

/**
 * Every id a split of `parent` could produce, in order: letters for a base task (T10 → T10a, T10b, …),
 * letter+digits for an already-split task (T10a → T10a1, T10a2, …). Empty for a twice-split id.
 */
export function childIdSequence(parent: string): string[] {
  const parsed = parseTaskId(parent);
  if (!parsed) return [];
  const out: string[] = [];
  if (!parsed.suffix) {
    for (const letter of LETTERS) out.push(formatTaskId(parsed.num, letter));
  } else if (/^[a-z]$/.test(parsed.suffix)) {
    for (let i = 1; i <= 99; i++) out.push(formatTaskId(parsed.num, `${parsed.suffix}${i}`));
  }
  return out;
}

export interface SplitCheck {
  ok: boolean;
  errors: string[];
  /** The subtasks found in the rewritten roadmap, in roadmap order. */
  children: Task[];
}

/**
 * Validate a splitting session's rewrite before anything is committed: the parent bullet and its task
 * file are gone, the subtasks are exactly the expected ids in order, they sit where the parent was, and
 * each is a fresh bullet with a task file. Pure so the rules are testable without running an agent.
 */
export function checkSplit(opts: {
  parent: Task;
  /** Tasks in roadmap order before the split. */
  before: Task[];
  /** Tasks in roadmap order after the rewrite. */
  after: Task[];
  roadmap: Roadmap;
  /** The full child-id sequence for the parent (unfiltered). */
  sequence: string[];
  /** Exact ids required when `--into` was given; otherwise the ids must be a contiguous leading run. */
  expected?: string[];
  paths: Paths;
}): SplitCheck {
  const { parent, before, after, roadmap, sequence, expected, paths } = opts;
  const errors: string[] = [];
  const childSet = new Set(sequence);
  const children = after.filter((t) => childSet.has(t.id));
  const ids = children.map((t) => t.id);
  const wanted = expected ?? sequence.slice(0, ids.length);

  if (after.some((t) => t.id === parent.id)) {
    errors.push(`${parent.id}'s bullet is still in the roadmap; it must be replaced by ${(wanted.length ? wanted : sequence).slice(0, 6).join(', ')}`);
  }
  // The parent must be the only bullet that changed: one task out, N subtasks in.
  const expectedCount = before.length + children.length - 1;
  if (after.length !== expectedCount) {
    errors.push(`the roadmap must hold exactly ${expectedCount} task bullet${expectedCount === 1 ? '' : 's'} after the split (${before.length} before, minus ${parent.id}, plus ${children.length}); found ${after.length} — do not add, remove or renumber other tasks`);
  }
  if (expected && ids.length !== expected.length) {
    errors.push(`expected exactly ${expected.length} subtask${expected.length === 1 ? '' : 's'} (${expected.join(', ')}), found ${ids.length}${ids.length ? ` (${ids.join(', ')})` : ''}`);
  } else if (!expected && ids.length < 2) {
    errors.push(`expected at least 2 subtasks (${sequence.slice(0, 2).join(', ')}), found ${ids.length}`);
  } else if (!expected && ids.length > 6) {
    errors.push(`expected at most 6 subtasks, found ${ids.length} (${ids.join(', ')}); split again later if more are needed`);
  }
  if (ids.length && (ids.length !== wanted.length || ids.some((id, i) => id !== wanted[i]))) {
    errors.push(`the subtask ids must be exactly ${wanted.join(', ')}, in that order; found ${ids.join(', ') || '(none)'}`);
  }
  if (children.length) {
    const nowIds = after.map((t) => t.id);
    const start = nowIds.indexOf(ids[0]);
    if (ids.some((id, i) => nowIds[start + i] !== id)) errors.push('the subtask bullets must be consecutive in the roadmap');
    const beforeIds = before.map((t) => t.id);
    const pi = beforeIds.indexOf(parent.id);
    const prev = pi > 0 ? beforeIds[pi - 1] : undefined;
    const next = pi >= 0 && pi < beforeIds.length - 1 ? beforeIds[pi + 1] : undefined;
    const gotPrev = start > 0 ? nowIds[start - 1] : undefined;
    const gotNext = start + ids.length < nowIds.length ? nowIds[start + ids.length] : undefined;
    if (prev !== gotPrev) errors.push(`the subtasks must replace ${parent.id} where it was: the task before them must stay ${prev ?? '(they must come first)'}, found ${gotPrev ?? '(none)'}`);
    if (next !== gotNext) errors.push(`the subtasks must replace ${parent.id} where it was: the task after them must stay ${next ?? '(they must come last)'}, found ${gotNext ?? '(none)'}`);
  }
  for (const c of children) {
    const bullet = roadmap.bullets.find((b) => b.id === c.id)!;
    const implied = statusFromMarkers(bullet);
    if (implied !== 'pending') errors.push(`${c.id} must be a fresh "- [ ]" bullet; it is marked ${implied === 'done' || implied === 'accepted' ? '[x]' : `[~] ⟵ ${bullet.tag ?? 'unfinished'}`}`);
    if (!c.taskFile) errors.push(`${c.id} has no task file under ${rel(opts.paths.root, opts.paths.tasksDir)}/ (link it from the bullet or name the file ${c.id.replace(/^T/, '').toLowerCase()}-<slug>.md)`);
  }
  if (parent.taskFile && existsSync(parent.taskFile)) {
    errors.push(`the parent task file ${parent.taskFileRel} still exists; its content must move into the subtasks and the file must be removed`);
  }
  return { ok: errors.length === 0, errors, children };
}

/** Clear the split-away parent's state row (and a halt on it) so only the subtasks remain. */
export function applySplitState(paths: Paths, state: State, parentId: string, log?: { info(m: string): void }): void {
  if (state.tasks[parentId]) {
    log?.info(`split: cleared ${parentId}'s state row (it no longer exists in the roadmap)`);
    delete state.tasks[parentId];
  }
  if (state.halted?.taskId === parentId) {
    log?.info(`split: cleared the halt on ${parentId}`);
    delete state.halted;
  }
  saveState(paths, state);
}

/** Point a run's task selection at the subtasks that replaced the split parent. */
export function retargetFlags(flags: RunFlags, parentId: string, childIds: string[]): void {
  if (flags.only?.length) {
    flags.only = flags.only.flatMap((raw) => (canonicalId(raw) === parentId ? childIds : [raw]));
  }
  if (flags.from && canonicalId(flags.from) === parentId && childIds.length) flags.from = childIds[0];
  if (flags.to && canonicalId(flags.to) === parentId && childIds.length) flags.to = childIds[childIds.length - 1];
}

function parentStatusLine(task: Task, ctx: RunContext): string {
  const st = ctx.state.tasks[task.id];
  if (!st) return 'pending (never run)';
  const parts: string[] = [st.status];
  if (st.attempts) parts.push(`${st.attempts} session${st.attempts === 1 ? '' : 's'}`);
  const detail = st.lastError?.message ?? st.summary;
  if (detail) parts.push(`last: ${squash(detail, 200)}`);
  return parts.join(' · ');
}

/** The prompt for the splitting session: one oversized task, its file, the rules, and the child ids. */
export function buildSplitPrompt(ctx: RunContext, parent: Task, opts: { sequence: string[]; expected?: string[]; note?: string; findings: LintReport }): string {
  const { paths, config } = ctx;
  const d = { roadmap: rel(paths.root, paths.roadmap), progress: rel(paths.root, paths.progress), tasks: rel(paths.root, paths.tasksDir) };
  const body = taskFileBody(parent, config.maxTaskBytes);
  const roadmap = existsSync(paths.roadmap) ? clip(readFileSync(paths.roadmap, 'utf8'), ROADMAP_CAP) : '(missing)';
  const findings = opts.findings.findings.length
    ? opts.findings.findings.map((x) => `${x.level === 'error' ? '✗' : x.level === 'warn' ? '!' : '·'} ${x.code}: ${x.message}`).join('\n')
    : '(none)';
  const tree = docsTree(paths);
  const ids = opts.expected ?? opts.sequence;
  const fileExample = ids.slice(0, 3).map((id) => `${id} → ${d.tasks}/${id.replace(/^T/, '').toLowerCase()}-<slug>.md`).join(', ');
  const countRule = opts.expected
    ? `exactly ${opts.expected.length} subtask bullets`
    : 'between 2 and 6 subtask bullets (fewer when the parent is nearly done, more when it covers several independent deliverables)';
  const childIdRule = opts.expected
    ? `Use exactly these ids, in this order: ${opts.expected.join(', ')}.`
    : `Use a contiguous run of ids starting at ${opts.sequence[0]} and increasing alphabetically (${opts.sequence.slice(0, 4).join(', ')}, …): the first N of that series, with no gaps and no reuse of another task's id.`;
  const firstChild = ids[0];
  const firstChildFile = firstChild.replace(/^T/, '').toLowerCase();
  const vars: Record<string, string | number> = {
    projectName: basename(paths.root),
    root: paths.root,
    taskId: parent.id,
    taskTitle: parent.title,
    taskPhase: parent.phase,
    taskFile: parent.taskFileRel ?? '(no task file)',
    parentStatus: parentStatusLine(parent, ctx),
    parentBody: body ?? `(no task file — the roadmap bullet is the whole spec: "${parent.id} — ${parent.title}")`,
    contract: docsContract(paths, { design: config.designDocs }),
    roadmapPath: d.roadmap,
    roadmapContent: roadmap,
    findings,
    tree: tree.length ? tree.join('\n') : '(empty)',
    progress: d.progress,
    tasks: d.tasks,
    countRule,
    childIdRule,
    childFileRule: `Name each subtask file <id-without-T>-<slug>.md under ${d.tasks}/ (${fileExample}${ids.length > 3 ? ', …' : ''}).`,
    parentFileRule: parent.taskFile
      ? `The parent task file ${parent.taskFileRel} must be removed once its content lives in the subtasks.`
      : 'The parent had no task file; the subtask files are new.',
    firstChild,
    firstChildFile,
    noteBlock: opts.note ? `## Guidance from the human (authoritative)\n${opts.note}\n` : '',
    lintCommand: lintCommand(ctx),
  };
  return renderPrompt('split.md', vars);
}

/**
 * Break one task into subtasks: lint, hand the task file and the roadmap to one agent session that
 * rewrites the plan, validate the rewrite, reconcile the parent's state away, and commit the docs
 * change. The subtasks then run in the parent's place like any other task.
 */
export async function splitCommand(ctx: RunContext, opts: SplitOptions): Promise<number> {
  const { paths, config, log, state } = ctx;
  const docsRel = rel(paths.root, paths.docs);
  const id = canonicalId(opts.id);
  const parent = id ? ctx.tasks.find((t) => t.id === id) : undefined;
  if (!parent) throw new UsageError(`split ${opts.id}: no such task in ROADMAP.md`);
  if (opts.into !== undefined && (!Number.isInteger(opts.into) || opts.into < 2 || opts.into > 26)) {
    throw new UsageError('split: --into must be a whole number between 2 and 26');
  }

  const status = state.tasks[parent.id]?.status ?? 'pending';
  if (DONE_STATES.includes(status)) {
    throw new UsageError(`split ${parent.id}: it is ${status}; only pending, failed, blocked or interrupted tasks can be split (use \`symphony reset ${parent.id}\` first to redo it)`);
  }

  const sequence = childIdsFor(parent.id, ctx.tasks.map((t) => t.id));
  if (!sequence.length) {
    throw new UsageError(parent.suffix
      ? `split ${parent.id}: it is already a sub-split; split its parent instead, or create new tasks for the remaining work`
      : `split ${parent.id}: every subtask id (${formatTaskId(parent.num, 'a')}–${formatTaskId(parent.num, 'z')}) is already in use; split one of those instead`);
  }
  const expected = opts.into !== undefined ? sequence.slice(0, opts.into) : undefined;
  if (expected && expected.length < opts.into!) {
    throw new UsageError(`split ${parent.id}: only ${expected.length} free subtask id${expected.length === 1 ? '' : 's'} remain (${sequence.join(', ')}); split again after those run, or use fewer with --into`);
  }

  const before = lintDocs(paths, { design: config.designDocs });
  log.plain('--- lint (before)');
  formatLint(before).forEach((l) => log.plain(l));

  // A halt anywhere else is a real blocker; a halt on this task is exactly what a split remedies.
  if (state.halted && state.halted.taskId !== parent.id) { haltBanner(ctx, state.halted); return 3; }

  const { spec, warnings } = resolveSession(config, undefined, ctx.cli, process.env, (p) => getProvider(p).supportsBudget, variantSupported);
  warnings.forEach((w) => log.warn(w));
  const provider = getProvider(spec.providerName);
  const plan = { sequence, expected, note: opts.note };

  if (opts.dryRun) {
    const prompt = buildSplitPrompt(ctx, parent, { ...plan, findings: before });
    log.plain(`\nprovider: ${spec.providerName} [${spec.sources.provider}] · model: ${spec.model ?? 'provider default'} [${spec.sources.model}]${spec.variant ? ` · variant: ${spec.variant} [${spec.sources.variant}]` : ''} · timeout ${config.prepareTimeoutMin} min`);
    log.plain(`parent: ${parent.id} — ${parent.title} [${status}] → ${(expected ?? sequence.slice(0, 3)).join(', ')}${expected ? '' : ', …'}`);
    log.plain(`--- split prompt (${Buffer.byteLength(prompt, 'utf8')} bytes) ---\n${prompt}--- end prompt ---`);
    return 0;
  }
  // The halt on this task (if any) is about to be cleared by the split, so preflight must not
  // refuse the run because of it; a halt anywhere else returned above.
  if (!preflight(ctx, spec, provider, { ignoreHalt: state.halted?.taskId === parent.id })) { log.error('preflight failed; fix the ✗ items above'); return 4; }

  // Deterministic skeleton first, so the session always has tasks/ and design/ to write into, and a
  // PROGRESS.md to append to.
  let findings = before;
  const created = scaffoldDocs(paths, { roadmap: false, config: false, design: config.designDocs });
  created.forEach((p) => log.info(`created ${relative(paths.root, p)}`));
  const stopEntry = stopIgnoreEntry(paths);
  const added = ensureGitignore(paths.root, ['.symphony/', ...(stopEntry ? [stopEntry] : [])]);
  if (added.length) log.info(`added ${added.join(', ')} to ${paths.root}/.gitignore`);
  if (created.length || added.length) findings = lintDocs(paths, { design: config.designDocs });
  const prompt = buildSplitPrompt(ctx, parent, { ...plan, findings });

  acquireLock(paths);
  ctx.startBranch = currentBranch(paths.root);
  const stopHeartbeat = startLockHeartbeat(paths);
  try {
    const childNote = expected ? expected.join(', ') : `${sequence[0]}…`;
    const label = `split: breaking ${parent.id} — ${parent.title} into ${childNote}`;
    const { outcome, early } = await runDocsSession(ctx, spec, provider, {
      prompt, runName: `split-${parent.id}`, taskId: `split-${parent.id}`, label, timeoutMin: config.prepareTimeoutMin,
    });
    if (early !== undefined) return early;

    // The agent rewrote the plan on disk: reload it and check it against the rules before committing.
    const text = readFileSync(paths.roadmap, 'utf8');
    let roadmap: Roadmap;
    let after: Task[];
    try {
      roadmap = parseRoadmap(text);
      const discovered = discoverTasks(paths, roadmap);
      after = discovered.tasks;
      discovered.warnings.forEach((w) => log.warn(w));
    } catch (e) {
      log.error(`split: the rewritten plan does not parse (${(e as Error).message}); refusing to commit. Fix it by hand or run \`symphony split\` again.`);
      return 2;
    }
    const check = checkSplit({ parent, before: ctx.tasks, after, roadmap, sequence, expected, paths });
    if (!check.ok) {
      check.errors.forEach((e) => log.error(`split: ${e}`));
      log.error(`split: refusing to commit. Nothing was recorded; fix ${rel(paths.root, paths.roadmap)} by hand or run \`symphony split ${parent.id}\` again.`);
      return 2;
    }
    const afterLint = lintDocs(paths, { design: config.designDocs });
    log.plain('--- lint (after)');
    formatLint(afterLint).forEach((l) => log.plain(l));
    if (!afterLint.ok) {
      log.error(`${docsRel}/ is still not in the expected format after the split; fix the ✗ items by hand or run \`symphony split ${parent.id}\` again`);
      return 2;
    }

    applySplitState(paths, state, parent.id, log);
    for (const child of check.children) {
      try { patchRoadmapFile(paths.roadmap, child.id, 'pending'); } catch { /* reported above */ }
    }
    updatePipelineStatus(paths, after, state, log);
    const childIds = check.children.map((c) => c.id);
    const commit = commitAll(paths.root, `docs: split ${parent.id} into ${childIds.join(', ')} [split]`, (m) => log.warn(m), { autoIgnoreUntracked: config.git.autoIgnoreUntracked, extraIgnore: config.git.extraIgnore, expectedBranch: ctx.startBranch });
    log.info(`split: git ${describeCommit(commit)}${outcome.costUsd !== undefined ? ` · $${outcome.costUsd.toFixed(2)}` : ''}`);
    log.info(`split: ${parent.id} — ${parent.title} → ${childIds.join(', ')}; next: \`symphony run\``);
    return 0;
  } finally {
    stopHeartbeat();
    releaseLock(paths);
  }
}
