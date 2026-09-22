import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { classifyFailure } from './classify.js';
import { scaffoldDocs } from './commands.js';
import { resolveSession, type SessionSpec } from './config.js';
import { docsContract } from './contract.js';
import { commitAll, currentBranch, describeCommit, ensureGitignore } from './git.js';
import { docsTree, formatLint, lintDocs, type LintReport } from './lint.js';
import { openRunSinks } from './logger.js';
import { rel, stopIgnoreEntry } from './paths.js';
import { getProvider } from './providers/index.js';
import type { Provider } from './providers/types.js';
import { parseResultBlock, type ResultBlock } from './result.js';
import { describeCmd, haltBanner, outcomeEvidence, preflight, type RunContext } from './runner.js';
import { startSession, type SessionOutcome } from './session.js';
import { acquireLock, releaseLock, saveState, startLockHeartbeat } from './state.js';
import { renderPrompt } from './templates.js';
import { clip, ensureDir, nowIso, stamp } from './util.js';

const LIVE_MAX = 400;
const LOG_MAX = 4000;
const ROADMAP_CAP = 16 * 1024;

export function lintCommand(ctx: RunContext): string {
  const wrapper = join(ctx.paths.symphony, 'symphony');
  if (existsSync(wrapper)) return `${wrapper} lint`;
  return `node ${join(import.meta.dirname, 'cli.js')} lint --root ${ctx.paths.root}`;
}

export function buildPreparePrompt(ctx: RunContext, report: LintReport): string {
  const { paths } = ctx;
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
  const candidatesNote = report.candidates.length
    ? `Fold their content into ${d.docs}/ (roadmap tasks, task files, design docs, ADRs). Move with \`git mv\` so history is kept; if other files link to the old path, leave a one-line pointer there. Leave genuine end-user documentation (README, API docs) where it is.`
    : '';
  const vars: Record<string, string | number> = {
    projectName: basename(paths.root),
    roadmapPath: d.roadmap,
    progress: d.progress,
    root: paths.root,
    contract: docsContract(paths, { design: ctx.config.designDocs }),
    findings,
    docsDir: d.docs,
    candidates: report.candidates.length ? report.candidates.map((c) => `- ${c}`).join('\n') : '(none)',
    candidatesNote,
    tree: tree.length ? tree.join('\n') : '(empty)',
    roadmapContent: roadmap,
    tasks: d.tasks,
    lintCommand: lintCommand(ctx),
  };
  return renderPrompt('prepare.md', vars);
}

export interface DocsSessionResult {
  outcome: SessionOutcome;
  /** The result block the session reported, if any. */
  block?: ResultBlock;
  /** Non-zero when the caller must return immediately: 130 interrupted, 3 fatal halt. */
  early?: number;
}

/**
 * Run one docs-editing agent session (used by `prepare` and `replan`): open the run sinks, spawn the
 * provider with the prompt, stream it, parse the result block and classify failures. The caller owns
 * the lock, preflight and the commit.
 */
export async function runDocsSession(
  ctx: RunContext,
  spec: SessionSpec,
  provider: Provider,
  opts: { prompt: string; runName: string; taskId: string; label: string; timeoutMin: number },
): Promise<DocsSessionResult> {
  const { paths, config, log, state } = ctx;
  const docsRel = rel(paths.root, paths.docs);
  ensureDir(paths.runs);
  const sinks = openRunSinks(paths.runs, `${opts.runName}-${stamp()}`);
  writeFileSync(sinks.promptPath, opts.prompt);
  const cmd = provider.buildCommand({
    bin: spec.bin, prompt: opts.prompt, promptFile: sinks.promptPath, taskId: opts.taskId, attempt: 1, kind: 'task',
    model: spec.model, autoApprove: spec.autoApprove, budgetUsd: spec.budgetUsd, extraArgs: spec.extraArgs, cwd: paths.root,
  });
  log.info(`=== ${opts.label} with ${spec.providerName} · model ${spec.model ?? 'default'}`);
  log.info(`${opts.taskId}: ${describeCmd(cmd)}`);
  log.info(`${opts.taskId}: streaming to ${relative(paths.root, sinks.logPath)}`);

  const session = startSession({
    spec: cmd, provider, cwd: paths.root,
    timeoutMs: opts.timeoutMin * 60_000, idleTimeoutMs: spec.idleTimeoutMin * 60_000,
    sinks, liveMaxChars: LIVE_MAX, logMaxChars: LOG_MAX, color: process.stdout.isTTY === true,
  });
  ctx.active = session;
  if (ctx.interrupted) session.kill('interrupt');
  const out = await session.done;
  ctx.active = undefined;
  await sinks.close();
  ctx.runCostUsd = (ctx.runCostUsd ?? 0) + (out.costUsd ?? 0);

  if (out.interrupted || ctx.interrupted) {
    log.warn(`${opts.label} interrupted; ${docsRel}/ may be half-written (check git status)`);
    return { outcome: out, early: 130 };
  }
  const block = parseResultBlock(out.result.text) ?? parseResultBlock(out.allText);
  if (!out.result.ok) {
    const c = classifyFailure(outcomeEvidence(out), config.halt.onCategories);
    if (c.fatal) {
      state.halted = { at: nowIso(), taskId: opts.taskId, category: c.category, reason: c.message };
      saveState(paths, state);
      haltBanner(ctx, state.halted);
      return { outcome: out, early: 3 };
    }
    log.error(`${opts.label} session failed: ${c.category}: ${c.message}`);
  } else if (block) log.info(`${opts.label}: agent reported ${block.status}${block.summary ? `: ${block.summary}` : ''}`);
  else log.warn(`${opts.label}: agent ended without a SYMPHONY_RESULT block`);
  return { outcome: out, block };
}

/** Lint .docs/, then let the configured provider repair it. Returns 0 when lint is clean afterwards. */
export async function prepareCommand(ctx: RunContext, opts: { dryRun: boolean }): Promise<number> {
  const { paths, config, log, state } = ctx;

  const before = lintDocs(paths, { design: config.designDocs });
  const docsRel = rel(paths.root, paths.docs);
  log.plain('--- lint (before)');
  formatLint(before).forEach((l) => log.plain(l));

  if (!existsSync(paths.docs) && before.candidates.length === 0) {
    log.error(`nothing to prepare from: no ${docsRel}/ and no planning documents found. Run \`symphony init\` and write ${rel(paths.root, paths.roadmap)}, or paste the output of \`symphony brief\` to your LLM.`);
    return 2;
  }

  // Deterministic part first: skeleton dirs/files and .gitignore never need an LLM. (Not in a dry run.)
  let report = before;
  if (!opts.dryRun) {
const created = scaffoldDocs(paths, { roadmap: false, config: false, design: config.designDocs });
    created.forEach((p) => log.info(`created ${relative(paths.root, p)}`));
    const stopEntry = stopIgnoreEntry(paths);
    const added = ensureGitignore(paths.root, ['.symphony/', ...(stopEntry ? [stopEntry] : [])]);
    if (created.length || added.length) report = lintDocs(paths, { design: config.designDocs });
  }
  if (report.ok) {
    log.info(`prepare: ${docsRel}/ is already in the expected format (${report.taskCount} task${report.taskCount === 1 ? '' : 's'}); nothing for the agent to do`);
    return 0;
  }
  if (state.halted) { haltBanner(ctx, state.halted); return 3; }

  const { spec, warnings } = resolveSession(config, undefined, ctx.cli, process.env, (p) => getProvider(p).supportsBudget);
  warnings.forEach((w) => log.warn(w));
  const provider = getProvider(spec.providerName);
  const prompt = buildPreparePrompt(ctx, report);

  if (opts.dryRun) {
    log.plain(`\nprovider: ${spec.providerName} [${spec.sources.provider}] · model: ${spec.model ?? 'provider default'} [${spec.sources.model}] · timeout ${config.prepareTimeoutMin} min`);
    log.plain(`--- prepare prompt (${Buffer.byteLength(prompt, 'utf8')} bytes) ---\n${prompt}--- end prompt ---`);
    return 0;
  }
  if (!preflight(ctx, spec, provider, { skipRoadmap: true })) { log.error('preflight failed; fix the ✗ items above'); return 4; }

  acquireLock(paths);
  ctx.startBranch = currentBranch(paths.root);
  const stopHeartbeat = startLockHeartbeat(paths);
  try {
    const label = `prepare: repairing ${docsRel}/ (${report.findings.filter((x) => x.level === 'error').length} errors, ${report.candidates.length} outside documents)`;
    const { outcome, early } = await runDocsSession(ctx, spec, provider, { prompt, runName: 'prepare', taskId: 'prepare', label, timeoutMin: config.prepareTimeoutMin });
    if (early !== undefined) return early;

    const after = lintDocs(paths, { design: config.designDocs });
    log.plain('--- lint (after)');
    formatLint(after).forEach((l) => log.plain(l));
    const commit = commitAll(paths.root, `docs: normalise ${docsRel} for symphony [prepare]`, (m) => log.warn(m), { autoIgnoreUntracked: config.git.autoIgnoreUntracked, extraIgnore: config.git.extraIgnore, expectedBranch: ctx.startBranch });
    log.info(`prepare: git ${describeCommit(commit)}${outcome.costUsd !== undefined ? ` · $${outcome.costUsd.toFixed(2)}` : ''}`);
    if (!after.ok) { log.error(`${docsRel}/ is still not in the expected format; fix the ✗ items by hand or run \`symphony prepare\` again`); return 2; }
    return 0;
  } finally {
    stopHeartbeat();
    releaseLock(paths);
  }
}
