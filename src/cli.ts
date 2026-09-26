#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { acceptCommand, briefCommand, clearHaltCommand, initCommand, logsCommand, resetCommand, statusCommand } from './commands.js';
import { DEFAULTS, findTaskSet, loadConfig, resolveSession, type CliOverrides, type Config } from './config.js';
import { formatChecks, runDoctor, type ExtraProvider } from './doctor.js';
import { formatLint, lintDocs } from './lint.js';
import { prepareCommand } from './prepare.js';
import { loadProject } from './project.js';
import { replanCommand } from './replan.js';
import { createLogger } from './logger.js';
import { resolvePaths, taskSetOverrides, type PathOverrides } from './paths.js';
import { getProvider, variantSupported } from './providers/index.js';
import { nudgeCommand, runCommand, type RunContext, type RunFlags } from './runner.js';
import { saveState } from './state.js';
import { splitCommand, splitTask } from './split.js';
import { runWithTui } from './tui/index.js';
import { UsageError } from './util.js';
import { describeImage, visionProblem } from './vision.js';

const HELP = `symphony — run an LLM coding agent through your roadmap, one fresh session per task

Usage
  symphony run     [--prepare] [--provider P] [--model M] [--model-provider P] [--variant V] [--from T03] [--to T10] [--only T05,T06] [--retry]
                   [--continue-on-failure] [--dry-run] [--safe] [--no-nudge] [--timeout-min N] [--max-tasks N]
                   [--max-iterations N] [--budget USD] [--max-cost USD] [--clear-halt] [--set NAME] [--tui|--no-tui]
                   [--mcp a,b|--no-mcp]
  symphony status  [--json]              progress table (or JSON)
  symphony logs    [T05]                 print a task's per-run log (docs/logs/T05.md); with no id, list them
  symphony doctor                        preflight: binaries, auth, git, roadmap, verify, halt/STOP/lock
  symphony lint                          check the project root and docs/ against the expected layout (no LLM)
  symphony prepare [--dry-run]           lint, then let the configured agent convert/repair the docs and commit
  symphony replan  [--direction FILE]    stop-and-pivot: let the agent rewrite the plan for a new direction and commit
                   [--allow-id-reuse] [--reset-state] [--dry-run]
  symphony split   T05 [--into N]        break one oversized task into subtasks (T05 → T05a, T05b, …): the agent
                   [--note "..."] [--dry-run]   rewrites the task into subtask files, the harness validates and commits
  symphony init                          scaffold the docs/ package (ROADMAP, PROGRESS, tasks/, design/, adr/) + config + .gitignore
  symphony accept  T05 [--note "..."]    human sign-off on a blocked/failed task (counts as done)
  symphony reset   T05 [--revert]        clear a task's state (and revert its commits with --revert) so it runs again
  symphony reset   --all                 clear every task's state and the halt, so a replaced roadmap starts clean
  symphony nudge   T05 [--note "..."]    resume a task's last session and ask it to close out
  symphony clear-halt                    lift a halt so run can start again
  symphony vision  <image> [--prompt "..."] [--context "..."]  analyze an image with the configured vision model and print its description
  symphony brief                         print a paste-ready prompt that makes any LLM client emit the docs package in this format
  symphony --version                     print the version

Providers: claude (Claude Code) · cursor (Cursor agent) · opencode (1.x) · codex (Codex CLI) · gemini (Gemini CLI) · antigravity (Google Antigravity) · fake (fixture replay)
Provider/model precedence: --provider/--model/--model-provider/--variant > SYMPHONY_PROVIDER/SYMPHONY_MODEL/SYMPHONY_MODEL_PROVIDER/SYMPHONY_VARIANT
> task front matter (provider, model, modelProvider, variant) > .symphony/symphony.config.json > defaults. All providers run with
permissions bypassed unless --safe. Reasoning effort ("variant") defaults to "high" for providers that support it
(claude --effort, opencode --variant, codex model_reasoning_effort, antigravity --effort) and is only sent when the
model supports it; override or clear it per run with --variant (empty string = provider default).
OpenCode addresses a model as "provider/model"; set "modelProvider" (e.g. "openrouter") next to a bare "model"
instead of writing the prefix yourself. A model that already starts with "modelProvider/" is passed through.
Every location (docs, tasks, progress, design, adr, logs, stop, state, runs, log) is overridable via the
"paths" section of .symphony/symphony.config.json.
Task sets: declare extra, independent task sets in the "taskSets" array of .symphony/symphony.config.json.
--set NAME runs that set's own roadmap/tasks/progress/design instead of the base docs/ package; its state
lives under .symphony/sets/NAME/. Every command accepts --set NAME.
MCP: with "mcp": {"enabled": true, …} in the config, each session is spawned with only the servers its
selection names (task front matter "mcp:"/"capabilities:", then mcp.sessions.<kind>, then mcp.defaultServers;
--mcp a,b / --no-mcp override). Claude, Codex, OpenCode 1.x and Gemini are scoped per session; cursor and
antigravity keep their own MCP config. Servers the registry defines can be disabled for a client; others
are excluded only where the client supports an allowlist.

Limits
  --max-tasks N            process at most N tasks this run (config maxTasksPerRun)
  --max-iterations N       at most N sessions per task, retries and continuations included (config maxIterationsPerTask)
  --budget USD             per-task budget passed to the provider (Claude only)
  --max-cost USD           stop the run once reported session cost reaches this (config maxCostUsdPerRun; 0 = off)
  verifyCommand            shell command the harness runs after a task reports done; per-task "verify:" wins.
                           Unset: the package.json test script is used when one exists (inferVerify)

Controls
  --tui / --no-tui         full-screen run view: a self-updating status table above the live output,
                           with scrolling, follow, pause/pause-at, accept and clear-halt keys. Default
                           on when stdout and stdin are a terminal; off when piped, in CI, or with
                           --no-tui. Set "tui": false in the config to disable it by default.
  touch .stop              pause at the next boundary: a task start or a continuation session end
                           (nothing is killed); configurable via paths.stop
  P (in the TUI)           queue a pause before the selected task: the run continues and the .stop
                           sentinel is placed when the pipeline reaches that task
  touch .symphony/STOP     legacy alias for the above
  Ctrl-C                   stop the current session, record it as unfinished, exit 130
  pipeline watch           while the run is in flight, a separate read-only model reads the harness
                           log and summarizes progress into the TUI's top strip and
                           .symphony/watch.log every watch.intervalMin (default 5 min, on by default;
                           press w in the TUI to check now). Configure via the "watch" config block.
  automatic breakdowns     with "breakdown": {"enabled": true} in the config, one decision (Jev, then
                           a fallback LLM, then deterministic rules) can break an oversized task into
                           subtasks at its start, at a "continue" boundary, or instead of escalating a
                           failure; the run reloads the plan and resumes on the subtasks. Configure via
                           the "breakdown" block (see the README).
  Slack notifications      with "slack": {"enabled": true, "channel": "#eng-alerts"} in the config,
                           post task done/continue/failed/blocked, halt and run-end events to a Slack
                           channel or DM a user, threading a task's later events under its start; every
                           event is its own flag, and the in-progress "watch" event is opt-in (see the
                           README).

Exit codes: 0 ok/paused · 1 unexpected error · 2 stopped on a blocked/failed task · 3 halted · 4 usage/preflight · 130/143 interrupted
Every option also applies to the project given by --root DIR (default: the directory containing .symphony/).
`;

/** Version of the harness, read from the package.json beside the build (falls back to 'dev'). */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'dev';
  } catch {
    return 'dev';
  }
})();

const COMMANDS = new Set(['run', 'status', 'logs', 'doctor', 'lint', 'prepare', 'replan', 'split', 'init', 'accept', 'reset', 'nudge', 'clear-halt', 'vision', 'brief', 'help']);

/**
 * The effective path overrides for this invocation: the base `paths`, or — with `--set NAME` — a
 * named task set's isolated bundle. An unknown name is a usage error listing what is declared.
 */
function effectiveOverrides(config: Config, setName: string | undefined, configPath: string): PathOverrides {
  if (setName === undefined) return config.paths;
  const set = findTaskSet(config, setName);
  if (!set) {
    const known = config.taskSets.map((s) => s.name);
    throw new UsageError(`--set ${setName}: no such task set. ${known.length ? `Known sets: ${known.join(', ')}` : `none are defined; add one to the "taskSets" array of ${configPath}`}.`);
  }
  return taskSetOverrides(config.paths, set.name, set.paths);
}

/** Absolute docs dir of every task set plus the base package: tools that scan the tree skip them all. */
function allDocsDirs(root: string, config: Config): string[] {
  return [
    resolvePaths(root, config.paths).docs,
    ...config.taskSets.map((s) => resolvePaths(root, taskSetOverrides(config.paths, s.name, s.paths)).docs),
  ];
}

export async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
      root: { type: 'string' },
      set: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'model-provider': { type: 'string' },
      variant: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      only: { type: 'string' },
      retry: { type: 'boolean' },
      'continue-on-failure': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      safe: { type: 'boolean' },
      'no-nudge': { type: 'boolean' },
      'timeout-min': { type: 'string' },
      'max-tasks': { type: 'string' },
      'max-iterations': { type: 'string' },
      budget: { type: 'string' },
      'max-cost': { type: 'string' },
      mcp: { type: 'string' },
      'no-mcp': { type: 'boolean' },
      'clear-halt': { type: 'boolean' },
      prepare: { type: 'boolean' },
      tui: { type: 'boolean' },
      'no-tui': { type: 'boolean' },
      direction: { type: 'string' },
      'allow-id-reuse': { type: 'boolean' },
      'reset-state': { type: 'boolean' },
      into: { type: 'string' },
      all: { type: 'boolean' },
      note: { type: 'string' },
      revert: { type: 'boolean' },
      json: { type: 'boolean' },
      prompt: { type: 'string' },
      context: { type: 'string' },
    },
  });
  const cmd = positionals[0] ?? (v.help ? 'help' : 'help');
  if (v.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  if (v.help || cmd === 'help') { process.stdout.write(HELP); return 0; }
  if (!COMMANDS.has(cmd)) throw new UsageError(`unknown command "${cmd}"\n\n${HELP}`);

  const cli: CliOverrides = {
    provider: v.provider,
    model: v.model,
    modelProvider: v['model-provider'],
    variant: v.variant,
    timeoutMin: v['timeout-min'] !== undefined ? Number(v['timeout-min']) : undefined,
    maxTasks: v['max-tasks'] !== undefined ? Number(v['max-tasks']) : undefined,
    maxIterations: v['max-iterations'] !== undefined ? Number(v['max-iterations']) : undefined,
    budgetUsd: v.budget !== undefined ? Number(v.budget) : undefined,
    maxCostUsd: v['max-cost'] !== undefined ? Number(v['max-cost']) : undefined,
    mcp: v.mcp !== undefined ? v.mcp.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    noMcp: v['no-mcp'] === true,
    safe: v.safe,
    noNudge: v['no-nudge'],
  };
  if (cli.timeoutMin !== undefined && !(cli.timeoutMin > 0)) throw new UsageError('--timeout-min must be a positive number');
  if (cli.maxTasks !== undefined && !(cli.maxTasks >= 0)) throw new UsageError('--max-tasks must be zero or a positive number');
  if (cli.maxIterations !== undefined && !(cli.maxIterations >= 0)) throw new UsageError('--max-iterations must be zero or a positive number');
  if (cli.budgetUsd !== undefined && !(cli.budgetUsd > 0)) throw new UsageError('--budget must be a positive number');
  if (cli.maxCostUsd !== undefined && !(cli.maxCostUsd >= 0)) throw new UsageError('--max-cost must be zero or a positive number');

  if (cmd === 'init' || cmd === 'brief') {
    const base = resolvePaths(v.root);
    let cfg: Config = DEFAULTS;
    // With --set the config must exist to name the set, so a load error surfaces instead of being swallowed.
    if (v.set !== undefined) cfg = loadConfig(base, cli).config;
    else { try { cfg = loadConfig(base, cli).config; } catch { /* scaffolding can proceed with defaults */ } }
    const paths = resolvePaths(v.root, effectiveOverrides(cfg, v.set, base.config));
    const log = createLogger(undefined);
    return cmd === 'init' ? initCommand(paths, log, { design: cfg.designDocs }) : briefCommand(paths, log, { design: cfg.designDocs });
  }

  // Config may relocate the docs/tasks/progress/design/stop folders, so read it from the fixed
  // .symphony/ location first, then resolve the effective paths (the base package or a named set).
  const base = resolvePaths(v.root);
  const { config, warnings: cfgWarnings, fileExists: cfgExists } = loadConfig(base, cli);
  const paths = resolvePaths(v.root, effectiveOverrides(config, v.set, base.config));
  // The vision tool is invoked by a task session through this same CLI. It needs the config (model,
  // key, router) but not the roadmap/state. Return only its description on stdout: normal config
  // warnings and run logging would otherwise become part of the agent's image evidence.
  if (cmd === 'vision') {
    const image = positionals[1];
    if (!image) throw new UsageError('vision: give an image path or URL, e.g. symphony vision shot.png [--prompt "..."] [--context "..."]');
    const problem = visionProblem(config.vision);
    if (problem) throw new UsageError(`vision: unavailable (${problem}); enable it with "vision": {"enabled": true} in ${paths.config} and set ${config.vision.apiKeyEnv}`);
    const result = await describeImage(config.vision, { image, prompt: v.prompt, context: v.context, cwd: paths.root });
    process.stdout.write(`${result.text}\n`);
    return 0;
  }

  const log = createLogger(paths.log);
  cfgWarnings.forEach((w) => log.warn(w));
  if (!cfgExists && cmd !== 'doctor') log.info(`no ${paths.config}; using defaults`);
  if (cmd === 'lint') {
    const report = lintDocs(paths, { design: config.designDocs, skipDirs: allDocsDirs(paths.root, config) });
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
  if (loaded.roadmapError && cmd !== 'doctor' && cmd !== 'replan') throw new UsageError(loaded.roadmapError);

  switch (cmd) {
    case 'status':
      return statusCommand(paths, config, loaded.state, loaded.tasks, log, v.json === true, v.set);
    case 'logs':
      return logsCommand(paths, loaded.tasks, positionals[1], log);
    case 'accept': {
      const ids = positionals.slice(1).flatMap((s) => s.split(','));
      if (!ids.length) throw new UsageError('accept: give one or more task ids, e.g. symphony accept T05');
      return acceptCommand(paths, loaded.state, loaded.tasks, ids, v.note, log);
    }
    case 'clear-halt':
      return clearHaltCommand(paths, loaded.state, log);
    case 'reset': {
      const id = positionals[1];
      if (!id && v.all !== true) throw new UsageError('reset: give a task id, e.g. symphony reset T05 [--revert], or --all to clear everything');
      return resetCommand(paths, loaded.state, loaded.tasks, id, { revert: v.revert === true, all: v.all === true, log, commitTemplate: config.commitMessageTemplate });
    }
    case 'doctor': {
      const { spec, warnings } = resolveSession(config, loaded.tasks[0], cli, process.env, (p) => getProvider(p).supportsBudget, variantSupported);
      warnings.forEach((w) => log.warn(w));
      const extraProviders: ExtraProvider[] = [];
      const seen = new Set([spec.providerName]);
      for (const t of loaded.tasks) {
        const rs = resolveSession(config, t, cli, process.env, (p) => getProvider(p).supportsBudget, variantSupported);
        if (seen.has(rs.spec.providerName)) continue;
        seen.add(rs.spec.providerName);
        rs.warnings.forEach((w) => log.warn(`${t.id}: ${w}`));
        extraProviders.push({ spec: rs.spec, provider: getProvider(rs.spec.providerName), label: t.id });
      }
      const checks = runDoctor({ paths, config, state: loaded.state, spec, provider: getProvider(spec.providerName), extraProviders, taskCount: loaded.tasks.length, roadmapError: loaded.roadmapError });
      formatChecks(checks).forEach((l) => log.plain(l));
      return checks.some((c) => c.level === 'fail') ? 4 : 0;
    }
    case 'replan': {
      const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: v['dry-run'] === true, clearHalt: v['clear-halt'] === true };
      const ctx: RunContext = { paths, config, cli, flags, log, roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state, interrupted: false, abort: new AbortController() };
      installSignalHandlers(ctx);
      return replanCommand(ctx, {
        direction: v.direction,
        dryRun: v['dry-run'] === true,
        allowIdReuse: v['allow-id-reuse'] === true,
        resetState: v['reset-state'] === true,
      });
    }
    case 'split': {
      const id = positionals[1];
      if (!id) throw new UsageError('split: give the task to break down, e.g. symphony split T05 [--into 3]');
      const into = v.into !== undefined ? Number(v.into) : undefined;
      if (into !== undefined && (!Number.isInteger(into) || into < 2 || into > 26)) throw new UsageError('--into must be a whole number between 2 and 26');
      const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: v['dry-run'] === true, clearHalt: false };
      const ctx: RunContext = { paths, config, cli, flags, log, roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state, interrupted: false, abort: new AbortController() };
      installSignalHandlers(ctx);
      return splitCommand(ctx, { id, into, note: v.note, dryRun: v['dry-run'] === true });
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
      // Automatic breakdowns (config `breakdown`) run the `split` machinery from inside the run,
      // sharing this run's lock and branch instead of acquiring its own.
      ctx.performSplit = (taskId) => splitTask(ctx, { id: taskId, dryRun: false, keepLock: true });
      // The full-screen view is the default on a real terminal; --no-tui (or config tui:false, CI, a
      // pipe) falls back to the plain stream. --tui forces it and warns when that is not possible.
      // --dry-run prints prompts meant to be read or piped, so it always stays plain.
      const tuiEnabled = v['no-tui'] === true ? false : v.tui === true ? true : config.tui;
      const tui = v['dry-run'] === true ? { enabled: false, force: false } : { enabled: tuiEnabled, force: v.tui === true };
      return runWithTui(ctx, () => runCommand(ctx), tui);
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
    ctx.active?.kill('force');
    process.exit(sig === 'SIGTERM' ? 143 : 130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // Closing the terminal window (or the TUI) sends SIGHUP. Handle it like the other stops so an
  // attended close records the task unfinished and gives its attempt back, rather than dying abruptly
  // and leaving the row "running" with a counted attempt.
  process.on('SIGHUP', onSignal);
}

/** True when this module is the process entry point (so tests can import it without running the CLI). */
function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return resolve(arg) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 250).unref(); })
    .catch((e: unknown) => {
      if (e instanceof UsageError) { process.stderr.write(`symphony: ${e.message}\n`); process.exitCode = e.exitCode; return; }
      if (e instanceof Error && e.name === 'TypeError' && /Unknown option|Option .* argument/.test(e.message)) { process.stderr.write(`symphony: ${e.message}\n\n${HELP}`); process.exitCode = 4; return; }
      process.stderr.write(`symphony: unexpected error: ${(e as Error)?.stack ?? String(e)}\n`);
      process.exitCode = 1;
    });
}
