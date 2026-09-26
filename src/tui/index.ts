import { applyPlan, loadProject, retargetFlags } from '../project.js';
import type { RunContext, SplitRequest } from '../runner.js';
import { childIdSequence, splitCommand } from '../split.js';
import { releaseLock, saveState, type Halted } from '../state.js';
import { TuiApp } from './app.js';
import { AnsiTerminal } from './terminal.js';
import { UsageError } from '../util.js';

export interface TuiOptions {
  /** The TUI is allowed (config `tui`, or default). */
  enabled: boolean;
  /** `--tui` was passed explicitly; forces it when possible and warns when it cannot. */
  force?: boolean;
}

/** Whether an interactive full-screen TUI makes sense here: both ends are a real terminal, not CI. */
export function tuiSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!process.stdout.isTTY && !!process.stdin.isTTY && env.TERM !== 'dumb' && !env.CI;
}

/**
 * Route everything the run writes to stdout into the stream panel. The logger and the session
 * reader both go through `process.stdout.write`, so one patch captures harness events and live
 * provider output alike; the TUI itself writes through the saved reference so it stays on screen.
 */
function captureStdout(app: TuiApp): () => void {
  const original = process.stdout.write;
  const patched = ((chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
    const text = typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString(typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8')
        : String(chunk);
    try { app.pushOutput(text); } catch { /* a capture fault must never break the writer */ }
    const done = typeof enc === 'function' ? enc : typeof cb === 'function' ? cb : undefined;
    if (done) (done as () => void)();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = patched;
  return () => { process.stdout.write = original; };
}

/** How the resume loop talks back to its view; the TUI backs these with toasts and the halt dialog. */
export interface ResumeHooks {
  /** Stay open after a halt so the user can clear it (`clear`) or leave (`quit`). */
  awaitHaltAction(halted: Halted): Promise<'clear' | 'quit'>;
  /** The user already asked to quit. */
  quitRequested(): boolean;
  onSplitStart(request: SplitRequest): void;
  onSplitFailed(request: SplitRequest, code: number): void;
  /** The plan was reloaded after a split: refresh the view and report the subtasks. */
  onPlanReloaded(parentId: string, childIds: string[]): void;
}

/**
 * The run loop the full-screen view wraps, in plain code so it is testable without a terminal:
 * run; if the view queued a split, rewrite the task into subtasks, reload the plan and resume on
 * them; if the run halted, let the view clear the halt and retry or quit. Returns the exit code.
 */
export async function runWithResume(ctx: RunContext, run: () => Promise<number>, hooks: ResumeHooks): Promise<number> {
  for (;;) {
    const code = await run();

    // A split requested from the run view: the loop stopped at a boundary (or the session was
    // stopped), so rewrite the task into subtasks, reload the plan, and carry on.
    if (ctx.splitRequest) {
      const request = ctx.splitRequest;
      delete ctx.splitRequest;
      ctx.interrupted = false;
      delete ctx.signalName;
      hooks.onSplitStart(request);
      let splitCode: number;
      try {
        splitCode = await splitCommand(ctx, { id: request.id, into: request.into, note: request.note, dryRun: false });
      } catch (e) {
        ctx.log.error(`split ${request.id}: ${(e as Error).message}`);
        splitCode = e instanceof UsageError ? e.exitCode : 1;
      }
      if (splitCode !== 0) {
        hooks.onSplitFailed(request, splitCode);
        return splitCode;
      }
      const childIds = reloadPlan(ctx, request.id);
      retargetFlags(ctx.flags, request.id, childIds);
      if (ctx.pauseAt && !ctx.tasks.some((t) => t.id === ctx.pauseAt)) delete ctx.pauseAt;
      hooks.onPlanReloaded(request.id, childIds);
      continue;
    }

    // A halt ends the loop but not the session: let the user clear it and try again.
    if (code === 3 && ctx.state.halted && !hooks.quitRequested()) {
      const halted = ctx.state.halted;
      const decision = await hooks.awaitHaltAction(halted);
      if (ctx.splitRequest) continue;
      if (decision === 'quit' || hooks.quitRequested()) return code;
      // An `attempts` halt is re-raised unless the task's counter is bypassed too, so mirror the
      // documented hint (`run --clear-halt --retry --only Txx`) rather than clearing the flag alone.
      if (halted.category === 'attempts' && halted.taskId) {
        ctx.flags.retry = true;
        ctx.flags.only = [halted.taskId];
      }
      delete ctx.state.halted;
      saveState(ctx.paths, ctx.state);
      ctx.interrupted = false;
      continue;
    }
    return code;
  }
}

/**
 * Re-read the plan and state after a split rewrote them, in place on the context. Returns the ids
 * of the subtasks that replaced the split task.
 */
export function reloadPlan(ctx: RunContext, parentId: string): string[] {
  const loaded = loadProject(ctx.paths, ctx.log);
  loaded.warnings.forEach((w) => ctx.log.warn(w));
  if (loaded.roadmapError) ctx.log.error(loaded.roadmapError);
  applyPlan(ctx, loaded);
  const children = new Set(childIdSequence(parentId));
  return loaded.tasks.map((t) => t.id).filter((id) => children.has(id));
}

/**
 * Run the main loop inside the TUI when the terminal supports it, else fall back to the plain
 * streaming output unchanged. On a halt the view stays open so the user can clear the halt and
 * retry (`c`) or exit (`q`). When a split is requested (`b`), the loop stops, one docs session
 * rewrites the task into subtasks, the plan is reloaded the same way the CLI loads it, and the run
 * resumes on the subtasks. When it finishes, the last lines are replayed to normal scrollback.
 */
export async function runWithTui(ctx: RunContext, run: () => Promise<number>, opts: TuiOptions): Promise<number> {
  const supported = tuiSupported();
  if (!supported) {
    if (opts.force) ctx.log.warn('--tui requested but stdout/stdin is not a terminal; using plain output');
    return run();
  }
  if (!opts.enabled && !opts.force) return run();

  const realWrite = process.stdout.write.bind(process.stdout);
  const term = new AnsiTerminal((s) => realWrite(s));
  const app = new TuiApp(ctx, term);
  const restore = captureStdout(app);
  let restored = false;
  const restoreStdout = () => {
    if (restored) return;
    restored = true;
    try { restore(); } catch { /* stdout already restored */ }
  };
  const leaveTerminal = () => { try { app.stop(); } catch { try { term.leave(); } catch { /* exiting anyway */ } } };

  // A TUI fault (a bug in a frame or key handler, a terminal that went away) degrades to plain
  // streaming output instead of killing the harness. The run itself is untouched.
  app.onFatal = (error: Error) => {
    restoreStdout();
    leaveTerminal();
    realWrite(`\nsymphony: run view disabled after an error (${error.message}); continuing with plain output\n`);
  };

  // Last line of defense: whatever else throws — an async watcher bug, a provider parser fault, a
  // stray rejection — restore the terminal and stop the active session before the process dies, so
  // the terminal is never left in raw mode with mouse reporting on and the harness never hangs.
  const fatal = (error: Error) => {
    leaveTerminal();
    try { ctx.active?.kill('force'); } catch { /* already gone */ }
    // The run loop's finally never runs when a detached callback crashes, so drop the lock here too;
    // otherwise the next run would refuse to start until the heartbeat goes stale.
    try { releaseLock(ctx.paths); } catch { /* nothing we can do at exit */ }
    try { realWrite(`\nsymphony: fatal error: ${error.stack ?? error.message}\n`); } catch { /* stdout gone */ }
    process.exit(1);
  };
  const onUncaught = (error: Error) => fatal(error);
  const onRejection = (reason: unknown) => fatal(reason instanceof Error ? reason : new Error(String(reason)));
  const onExit = () => leaveTerminal();
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  process.once('exit', onExit);

  let code = 1;
  try {
    app.start();
    // An automatic breakdown inside the run rewrites the plan too: refresh the view when it does.
    ctx.onPlanChanged = (parentId, childIds) => {
      if (app.fatalError) return;
      app.onPlanChanged();
      app.toast(`broke ${parentId} into ${childIds.join(', ')}; resuming`);
    };
    code = await runWithResume(ctx, run, {
      awaitHaltAction: () => app.awaitHaltAction(),
      quitRequested: () => app.quitRequested,
      onSplitStart: (request) => app.toast(`splitting ${request.id}: the agent is rewriting the task…`),
      onSplitFailed: (request, failed) => app.toast(`split ${request.id} did not finish (exit ${failed}); see the live output`),
      onPlanReloaded: (parentId, childIds) => {
        app.onPlanChanged();
        app.toast(`split ${parentId} → ${childIds.join(', ')}; resuming the run`);
      },
    });
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
    process.removeListener('exit', onExit);
    restoreStdout();
    leaveTerminal();
    const tail = app.tail(10);
    if (tail.length && !app.fatalError) realWrite(`${tail.join('\n')}\n`);
    realWrite(`symphony run finished (exit ${code}).\n`);
  }
  return code;
}
