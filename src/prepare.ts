import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { classifyFailure } from './classify.js';
import { scaffoldDocs } from './commands.js';
import { resolveSession } from './config.js';
import { docsContract } from './contract.js';
import { commitAll, describeCommit, ensureGitignore } from './git.js';
import { docsTree, formatLint, lintDocs, type LintReport } from './lint.js';
import { openRunSinks } from './logger.js';
import { rel, stopIgnoreEntry } from './paths.js';
import { getProvider } from './providers/index.js';
import { parseResultBlock } from './result.js';
import { describeCmd, haltBanner, outcomeEvidence, preflight, type RunContext } from './runner.js';
import { startSession } from './session.js';
import { acquireLock, releaseLock, saveState } from './state.js';
import { clip, ensureDir, nowIso, stamp } from './util.js';

const LIVE_MAX = 400;
const LOG_MAX = 4000;
const ROADMAP_CAP = 16 * 1024;

function lintCommand(ctx: RunContext): string {
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
  return `You are preparing the "${basename(paths.root)}" project for the symphony harness, which will later drive an autonomous coding agent through ${d.roadmap}, one task per session. Your only job in this session is to bring the project's planning documents into the exact layout and format below. Do not write or change application code, do not start any task, do not run the harness. Nobody can answer questions: make reasonable calls and record each one in ${d.progress} under a "## Preparation notes" section.

Project root: ${paths.root}  (your working directory; never touch files outside it)

## Required layout and formats
${docsContract(paths, { design: ctx.config.designDocs })}

## What the linter found (fix every ✗; fix ! and · where the source material allows)
${findings}

## Planning documents outside ${d.docs}/
${report.candidates.length ? report.candidates.map((c) => `- ${c}`).join('\n') : '(none)'}
${report.candidates.length ? `Fold their content into ${d.docs}/ (roadmap tasks, task files, design docs, ADRs). Move with \`git mv\` so history is kept; if other files link to the old path, leave a one-line pointer there. Leave genuine end-user documentation (README, API docs) where it is.` : ''}

## Current ${d.docs}/ tree
${tree.length ? tree.join('\n') : '(empty)'}

## Current ${d.roadmap}
${roadmap}

## Rules
- Preserve meaning. Convert, split, merge, renumber and move; do not add scope the documents do not already contain. When a document lists phases or milestones without tasks, break each into tasks small enough for one unattended coding session, in dependency order.
- Every roadmap task gets a task file at ${d.tasks}/NN-<slug>.md from the template, filled with what the sources say; put open questions under "Design notes" as explicit assumptions rather than guessing silently. Every task's "Done when" must name at least one automated test to run.
- Use "- [ ]" for work not yet done and "- [x]" only where the sources clearly say it is finished. Never write "[~]" or a "⟵" tag; the harness owns those.
- Do not create or edit anything under .symphony/. Do not commit or push; the harness commits after you finish.
- Run everything in the foreground and finish in this single turn.
- Before you end, run \`${lintCommand(ctx)}\` and fix anything it still reports as ✗. Repeat until it prints "lint: ok".
- End your final message with exactly this block, as plain text, no code fence, nothing after it:

SYMPHONY_RESULT
status: <exactly one word: done, blocked, or failed>
summary: <one line: what you changed, or what is missing>
END_SYMPHONY_RESULT

Use "blocked" only when there is genuinely no planning content to work from, and say what is missing.
`;
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
  try {
    ensureDir(paths.runs);
    const sinks = openRunSinks(paths.runs, `prepare-${stamp()}`);
    writeFileSync(sinks.promptPath, prompt);
    const cmd = provider.buildCommand({
      bin: spec.bin, prompt, promptFile: sinks.promptPath, taskId: 'prepare', attempt: 1, kind: 'task',
      model: spec.model, autoApprove: spec.autoApprove, budgetUsd: spec.budgetUsd, extraArgs: spec.extraArgs, cwd: paths.root,
    });
    log.info(`=== prepare: repairing ${docsRel}/ with ${spec.providerName} (${report.findings.filter((x) => x.level === 'error').length} errors, ${report.candidates.length} outside documents)`);
    log.info(`prepare: ${describeCmd(cmd)}`);
    log.info(`prepare: streaming to ${relative(paths.root, sinks.logPath)}`);

    const session = startSession({
      spec: cmd, provider, cwd: paths.root,
      timeoutMs: config.prepareTimeoutMin * 60_000, idleTimeoutMs: spec.idleTimeoutMin * 60_000,
      sinks, liveMaxChars: LIVE_MAX, logMaxChars: LOG_MAX, color: process.stdout.isTTY === true,
    });
    ctx.active = session;
    if (ctx.interrupted) session.kill('interrupt');
    const out = await session.done;
    ctx.active = undefined;
    await sinks.close();

    if (out.interrupted || ctx.interrupted) { log.warn(`prepare interrupted; ${docsRel}/ may be half-converted (check git status)`); return 130; }
    const block = parseResultBlock(out.result.text) ?? parseResultBlock(out.allText);
    if (!out.result.ok) {
      const c = classifyFailure(outcomeEvidence(out), config.halt.onCategories);
      if (c.fatal) {
        state.halted = { at: nowIso(), taskId: 'prepare', category: c.category, reason: c.message };
        saveState(paths, state);
        haltBanner(ctx, state.halted);
        return 3;
      }
      log.error(`prepare session failed: ${c.category}: ${c.message}`);
    } else if (block) log.info(`prepare: agent reported ${block.status}${block.summary ? `: ${block.summary}` : ''}`);
    else log.warn('prepare: agent ended without a SYMPHONY_RESULT block');

    const after = lintDocs(paths, { design: config.designDocs });
    log.plain('--- lint (after)');
    formatLint(after).forEach((l) => log.plain(l));
    const commit = commitAll(paths.root, `docs: normalise ${docsRel} for symphony [prepare]`);
    log.info(`prepare: git ${describeCommit(commit)}${out.costUsd !== undefined ? ` · $${out.costUsd.toFixed(2)}` : ''}`);
    if (!after.ok) { log.error(`${docsRel}/ is still not in the expected format; fix the ✗ items by hand or run \`symphony prepare\` again`); return 2; }
    return 0;
  } finally {
    releaseLock(paths);
  }
}
