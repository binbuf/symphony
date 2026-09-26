import type { Logger } from '../logger.js';
import type { Paths } from '../paths.js';
import { UsageError, type TimeZone } from '../util.js';
import { TuiApp } from './app.js';
import { tuiSupported } from './index.js';
import { RemoteTuiModel } from './model.js';
import { AnsiTerminal } from './terminal.js';

export interface AttachOptions {
  paths: Paths;
  provider: string;
  timeZone?: TimeZone;
  log: Logger;
}

/**
 * `symphony attach`: open the full run view against an already-running (or finished) harness, reading
 * its state from disk. Quitting detaches — the harness keeps going — and the terminal is restored.
 */
export async function runAttach(opts: AttachOptions): Promise<number> {
  if (!tuiSupported()) {
    throw new UsageError('attach needs an interactive terminal (stdout and stdin must be a TTY); use `symphony status` for a snapshot');
  }
  const realWrite = process.stdout.write.bind(process.stdout);
  const term = new AnsiTerminal((s) => realWrite(s));
  const model = new RemoteTuiModel({
    paths: opts.paths,
    config: { timeZone: opts.timeZone, provider: opts.provider },
    log: opts.log,
  });
  const app = new TuiApp(model, term);
  model.onMessage = (m) => app.toast(m);

  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    try { app.stop(); } catch { try { term.leave(); } catch { /* exiting anyway */ } }
  };
  const onFatal = (error: Error): void => {
    leave();
    try { realWrite(`\nsymphony attach: view stopped after an error (${error.message})\n`); } catch { /* stdout gone */ }
  };
  const onSignal = (): void => { leave(); process.exit(0); };
  process.once('exit', leave);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', (r) => onFatal(r instanceof Error ? r : new Error(String(r))));
  process.on('SIGHUP', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    return await new Promise<number>((resolve) => {
      app.onQuit = () => resolve(0);
      app.start();
    });
  } finally {
    process.removeListener('exit', leave);
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('SIGHUP', onSignal);
    process.removeListener('SIGTERM', onSignal);
    leave();
  }
}