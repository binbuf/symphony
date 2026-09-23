import type { RunContext } from '../runner.js';
import { saveState } from '../state.js';
import { TuiApp } from './app.js';
import { AnsiTerminal } from './terminal.js';

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
    app.pushOutput(text);
    const done = typeof enc === 'function' ? enc : typeof cb === 'function' ? cb : undefined;
    if (done) (done as () => void)();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = patched;
  return () => { process.stdout.write = original; };
}

/**
 * Run the main loop inside the TUI when the terminal supports it, else fall back to the plain
 * streaming output unchanged. On a halt the view stays open so the user can clear the halt and
 * retry (`c`) or exit (`q`). When it finishes, the last lines are replayed to normal scrollback.
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
  const onExit = () => { try { term.leave(); } catch { /* exiting anyway */ } };
  process.once('exit', onExit);

  let code = 1;
  try {
    app.start();
    code = await run();
    // A halt ends the loop but not the session: let the user clear it and try again.
    while (code === 3 && ctx.state.halted && !app.quitRequested) {
      const halted = ctx.state.halted;
      const decision = await app.awaitHaltAction();
      if (decision === 'quit' || app.quitRequested) break;
      // An `attempts` halt is re-raised unless the task's counter is bypassed too, so mirror the
      // documented hint (`run --clear-halt --retry --only Txx`) rather than clearing the flag alone.
      if (halted.category === 'attempts' && halted.taskId) {
        ctx.flags.retry = true;
        ctx.flags.only = [halted.taskId];
        app.toast(`retrying ${halted.taskId}…`);
      }
      delete ctx.state.halted;
      saveState(ctx.paths, ctx.state);
      ctx.interrupted = false;
      code = await run();
    }
  } finally {
    process.removeListener('exit', onExit);
    restore();
    app.stop();
    const tail = app.tail(10);
    if (tail.length) realWrite(`${tail.join('\n')}\n`);
    realWrite(`symphony run finished (exit ${code}).\n`);
  }
  return code;
}
