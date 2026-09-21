#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { acceptCommand, briefCommand, clearHaltCommand, initCommand, statusCommand } from './commands.js';
import { DEFAULTS, loadConfig, resolveSession, type CliOverrides } from './config.js';
import { formatChecks, runDoctor } from './doctor.js';
import { formatLint, lintDocs } from './lint.js';
import { prepareCommand } from './prepare.js';
import { createLogger, type Logger } from './logger.js';
import { resolvePaths, type Paths } from './paths.js';
import { getProvider } from './providers/index.js';
import { parseRoadmap, patchRoadmapFile, type Roadmap } from './roadmap.js';
import { nudgeCommand, runCommand, type RunContext, type RunFlags } from './runner.js';
import { loadState, reconcile, saveState, type State } from './state.js';
import { discoverTasks, type Task } from './tasks.js';
import { UsageError, fileExists } from './util.js';
import { readFileSync } from 'node:fs';

const HELP = `symphony — run an LLM coding agent through your roadmap, one fresh session per task

Usage
  symphony run     [--prepare] [--provider P] [--model M] [--from T03] [--to T10] [--only T05,T06] [--retry]
                   [--continue-on-failure] [--dry-run] [--safe] [--no-nudge] [--timeout-min N]
                   [--budget USD] [--clear-halt]
  symphony status  [--json]              progress table (or JSON)
  symphony doctor                        preflight: binaries, auth, git, roadmap, halt/STOP/lock
  symphony lint                          check the project root and docs/ against the expected layout (no LLM)
  symphony prepare [--dry-run]           lint, then let the configured agent convert/repair the docs and commit
  symphony init                          scaffold the docs/ package (ROADMAP, PROGRESS, tasks/, design/, adr/) + config + .gitignore
  symphony accept  T05 [--note "..."]    human sign-off on a blocked/failed task (counts as done)
  symphony nudge   T05 [--note "..."]    resume a task's last session and ask it to close out
  symphony clear-halt                    lift a halt so run can start again
  symphony brief                         print a paste-ready prompt that makes any LLM client emit the docs package in this format

Providers: claude (Claude Code) · cursor (Cursor agent) · opencode · codex (Codex CLI) · gemini (Gemini CLI) · antigravity (Google Antigravity) · fake (fixture replay)
Provider/model precedence: --provider/--model > SYMPHONY_PROVIDER/SYMPHONY_MODEL > task front matter
> .symphony/symphony.config.json > defaults. All providers run with permissions bypassed unless --safe.
Every location (docs, tasks, progress, design, adr, stop, state, runs, log) is overridable via the
"paths" section of .symphony/symphony.config.json.

Controls
  touch .stop              pause at the next task boundary (nothing is killed); configurable via paths.stop
  touch .symphony/STOP     legacy alias for the above
  Ctrl-C                   stop the current session, record it as unfinished, exit 130

Exit codes: 0 ok/paused · 1 unexpected error · 2 stopped on a blocked/failed task · 3 halted · 4 usage/preflight · 130/143 interrupted
Every option also applies to the project given by --root DIR (default: the directory containing .symphony/).
`;

interface Loaded { paths: Paths; roadmap: Roadmap; tasks: Task[]; state: State; warnings: string[]; roadmapError?: string }

function loadProject(paths: Paths, log: Logger): Loaded {
  const state = loadState(paths);
  if (!fileExists(paths.roadmap)) return { paths, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [], state, warnings: [], roadmapError: `${paths.roadmap} missing (run: symphony init)` };
  let roadmap: Roadmap;
  try { roadmap = parseRoadmap(readFileSync(paths.roadmap, 'utf8')); } catch (e) {
    return { paths, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks: [], state, warnings: [], roadmapError: (e as Error).message };
  }
  const { tasks, warnings } = discoverTasks(paths, roadmap);
  const notes = reconcile(state, roadmap);
  if (notes.length) { notes.forEach((n) => log.info(`reconcile: ${n}`)); saveState(paths, state); }
  // State is authoritative for terminal statuses: make the roadmap markers agree.
  for (const t of tasks) {
    const st = state.tasks[t.id];
    if (!st) continue;
    try { if (patchRoadmapFile(paths.roadmap, t.id, st.status) === 'patched') log.info(`roadmap: ${t.id} marker set to ${st.status} from state`); } catch { /* reported by run */ }
  }
  return { paths, roadmap, tasks, state, warnings };
}

export async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      root: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      only: { type: 'string' },
      retry: { type: 'boolean' },
      'continue-on-failure': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      safe: { type: 'boolean' },
      'no-nudge': { type: 'boolean' },
      'timeout-min': { type: 'string' },
      budget: { type: 'string' },
      'clear-halt': { type: 'boolean' },
      prepare: { type: 'boolean' },
      note: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const cmd = positionals[0] ?? (v.help ? 'help' : 'help');
  if (v.help || cmd === 'help') { process.stdout.write(HELP); return 0; }

  const cli: CliOverrides = {
    provider: v.provider,
    model: v.model,
    timeoutMin: v['timeout-min'] !== undefined ? Number(v['timeout-min']) : undefined,
    budgetUsd: v.budget !== undefined ? Number(v.budget) : undefined,
    safe: v.safe,
    noNudge: v['no-nudge'],
  };
  if (cli.timeoutMin !== undefined && !(cli.timeoutMin > 0)) throw new UsageError('--timeout-min must be a positive number');
  if (cli.budgetUsd !== undefined && !(cli.budgetUsd > 0)) throw new UsageError('--budget must be a positive number');

  if (cmd === 'init' || cmd === 'brief') {
    const base = resolvePaths(v.root);
    let cfg = DEFAULTS;
    try { cfg = loadConfig(base, cli).config; } catch { /* scaffolding can proceed with defaults */ }
    const paths = resolvePaths(v.root, cfg.paths);
    const log = createLogger(undefined);
    return cmd === 'init' ? initCommand(paths, log, { design: cfg.designDocs }) : briefCommand(paths, log, { design: cfg.designDocs });
  }

  // Config may relocate the docs/tasks/progress/design/stop folders, so read it from the fixed
  // .symphony/ location first, then resolve the effective paths.
  const base = resolvePaths(v.root);
  const { config, warnings: cfgWarnings, fileExists: cfgExists } = loadConfig(base, cli);
  const paths = resolvePaths(v.root, config.paths);
  const log = createLogger(paths.log);
  cfgWarnings.forEach((w) => log.warn(w));
  if (!cfgExists && cmd !== 'doctor') log.info(`no ${paths.config}; using defaults`);
  if (cmd === 'lint') {
    const report = lintDocs(paths, { design: config.designDocs });
    formatLint(report).forEach((l) => log.plain(l));
    return report.ok ? 0 : 2;
  }

  let loaded = loadProject(paths, log);
  loaded.warnings.forEach((w) => log.warn(w));
  const wantsPrepare = cmd === 'prepare' || (cmd === 'run' && v.prepare === true);
  if (wantsPrepare) {
    const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: v['dry-run'] === true, clearHalt: v['clear-halt'] === true };
    const pctx: RunContext = { paths, config, cli, flags, log, roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state, interrupted: false, abort: new AbortController() };
    installSignalHandlers(pctx);
    if (pctx.state.halted && flags.clearHalt) { log.warn(`clearing halt (${pctx.state.halted.category}: ${pctx.state.halted.reason})`); delete pctx.state.halted; saveState(paths, pctx.state); }
    const code = await prepareCommand(pctx, { dryRun: flags.dryRun });
    if (cmd === 'prepare' || code !== 0) return code;
    loaded = loadProject(paths, log); // .docs/ may have changed shape
    loaded.warnings.forEach((w) => log.warn(w));
  }
  if (loaded.roadmapError && cmd !== 'doctor') throw new UsageError(loaded.roadmapError);

  switch (cmd) {
    case 'status':
      return statusCommand(paths, config, loaded.state, loaded.tasks, log, v.json === true);
    case 'accept': {
      const ids = positionals.slice(1).flatMap((s) => s.split(','));
      if (!ids.length) throw new UsageError('accept: give one or more task ids, e.g. symphony accept T05');
      return acceptCommand(paths, loaded.state, loaded.tasks, ids, v.note, log);
    }
    case 'clear-halt':
      return clearHaltCommand(paths, loaded.state, log);
    case 'doctor': {
      const { spec, warnings } = resolveSession(config, loaded.tasks[0], cli, process.env, (p) => getProvider(p).supportsBudget);
      warnings.forEach((w) => log.warn(w));
      const checks = runDoctor({ paths, config, state: loaded.state, spec, provider: getProvider(spec.providerName), taskCount: loaded.tasks.length, roadmapError: loaded.roadmapError });
      formatChecks(checks).forEach((l) => log.plain(l));
      return checks.some((c) => c.level === 'fail') ? 4 : 0;
    }
    case 'run':
    case 'nudge': {
      const flags: RunFlags = {
        from: v.from, to: v.to, only: v.only?.split(',').map((s) => s.trim()).filter(Boolean),
        retry: v.retry === true, continueOnFailure: v['continue-on-failure'] === true,
        dryRun: v['dry-run'] === true, clearHalt: v['clear-halt'] === true,
      };
      const ctx: RunContext = { paths, config, cli, flags, log, roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state, interrupted: false, abort: new AbortController() };
      installSignalHandlers(ctx);
      if (cmd === 'nudge') {
        const id = positionals[1];
        if (!id) throw new UsageError('nudge: give a task id, e.g. symphony nudge T05');
        return nudgeCommand(ctx, id, v.note);
      }
      return runCommand(ctx);
    }
    default:
      throw new UsageError(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

function installSignalHandlers(ctx: RunContext): void {
  let count = 0;
  const onSignal = (sig: NodeJS.Signals) => {
    count += 1;
    if (count === 1) {
      ctx.interrupted = true;
      ctx.signalName = sig;
      ctx.abort.abort();
      ctx.log.warn(`${sig} received: stopping the current session and recording it as unfinished (press again to force quit)`);
      ctx.active?.kill('interrupt');
      if (!ctx.active) setTimeout(() => process.exit(sig === 'SIGTERM' ? 143 : 130), 500).unref();
      return;
    }
    ctx.log.error(`${sig} received again: force quitting; the task row stays "running" and will be retried next run`);
    if (ctx.active?.pid) { try { process.kill(-ctx.active.pid, 'SIGKILL'); } catch { /* gone */ } }
    process.exit(sig === 'SIGTERM' ? 143 : 130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 250).unref(); })
  .catch((e: unknown) => {
    if (e instanceof UsageError) { process.stderr.write(`symphony: ${e.message}\n`); process.exitCode = e.exitCode; return; }
    if (e instanceof Error && e.name === 'TypeError' && /Unknown option|Option .* argument/.test(e.message)) { process.stderr.write(`symphony: ${e.message}\n\n${HELP}`); process.exitCode = 4; return; }
    process.stderr.write(`symphony: unexpected error: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exitCode = 1;
  });
