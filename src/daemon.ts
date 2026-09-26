import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { acceptCommand } from './commands.js';
import { ControlServer, sendControl, type ControlRequest, type ControlResponse } from './control.js';
import type { Logger } from './logger.js';
import { placeStop, clearStop, type Paths } from './paths.js';
import type { RunContext } from './runner.js';
import { startRuntimeWriter } from './runtime.js';
import { liveLock, readLock, saveState, type Halted } from './state.js';
import { runWithResume, type ResumeHooks } from './tui/index.js';
import { ensureDir, nowIso, UsageError } from './util.js';

/**
 * The detached front-end. Where the local TUI answers halt prompts from a keyboard, the daemon answers
 * them from the control channel, so a `symphony start` run can be driven by an `symphony attach`
 * client in another terminal — or left completely alone. The run engine itself (`runWithResume` +
 * `runCommand`) is unchanged.
 */

interface DaemonRecord { pid: number; startedAt: string }

export function daemonRecordPath(paths: Paths): string {
  return join(paths.symphony, 'daemon.json');
}

function readDaemonRecord(paths: Paths): DaemonRecord | undefined {
  const file = daemonRecordPath(paths);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as DaemonRecord;
    return typeof parsed?.pid === 'number' ? parsed : undefined;
  } catch { return undefined; }
}

function clearDaemonRecord(paths: Paths): void {
  try { unlinkSync(daemonRecordPath(paths)); } catch { /* already gone */ }
}

/** Run the loop headless, servicing control requests and publishing the runtime heartbeat. */
export async function runWithDaemon(ctx: RunContext, run: () => Promise<number>): Promise<number> {
  const runtime = startRuntimeWriter(ctx.paths, { phase: 'starting' });
  let pendingHalt: ((d: 'clear' | 'quit') => void) | undefined;
  let planRevision = 0;
  let stopped = false;

  const finishHalt = (d: 'clear' | 'quit'): boolean => {
    const resolve = pendingHalt;
    pendingHalt = undefined;
    if (!resolve) return false;
    resolve(d);
    return true;
  };

  const handler = async (req: ControlRequest): Promise<ControlResponse> => {
    const ok = (message: string, code?: number): ControlResponse => ({ id: req.id, ok: true, code, message, at: nowIso() });
    const fail = (message: string): ControlResponse => ({ id: req.id, ok: false, code: 1, message, at: nowIso() });
    switch (req.action) {
      case 'pause':
        placeStop(ctx.paths);
        ctx.log.info('control: pause requested; will stop at the next boundary');
        return ok('pause requested');
      case 'resume':
        clearStop(ctx.paths);
        ctx.log.info('control: resume requested; pause sentinel removed');
        return ok('resumed');
      case 'pause-at': {
        const id = req.args?.id;
        if (typeof id === 'string' && id) {
          ctx.pauseAt = id;
          runtime.update({ pauseAt: id, note: `pausing before ${id}` });
          return ok(`pause queued before ${id}`);
        }
        delete ctx.pauseAt;
        runtime.update({ pauseAt: undefined, note: undefined });
        return ok('pause target cleared');
      }
      case 'accept': {
        const raw = req.args?.ids;
        const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
        const note = typeof req.args?.note === 'string' ? req.args.note : undefined;
        if (!ids.length) return fail('no task ids to accept');
        acceptCommand(ctx.paths, ctx.state, ctx.tasks, ids, note, ctx.log);
        return ok(`accepted ${ids.join(', ')}`);
      }
      case 'split': {
        const id = req.args?.id;
        if (typeof id !== 'string' || !id) return fail('split needs a task id');
        const into = typeof req.args?.into === 'number' ? req.args.into : undefined;
        const note = typeof req.args?.note === 'string' ? req.args.note : undefined;
        ctx.splitRequest = { id, into, note };
        const running = ctx.tasks.find((t) => (ctx.state.tasks[t.id]?.status ?? 'pending') === 'running');
        if (running?.id === id) ctx.active?.kill('interrupt');
        runtime.update({ note: `split ${id} requested` });
        return ok(`split ${id} queued`);
      }
      case 'clear-halt':
        if (finishHalt('clear')) return ok('clearing the halt and retrying');
        if (ctx.state.halted) {
          delete ctx.state.halted;
          saveState(ctx.paths, ctx.state);
          runtime.update({ phase: 'running', note: undefined });
          return ok('halt cleared');
        }
        return ok('not halted');
      case 'watch':
        ctx.watchRefresh?.();
        return ok('watch check requested');
      case 'stop':
        stopped = true;
        finishHalt('quit');
        ctx.interrupted = true;
        ctx.signalName = 'SIGTERM';
        ctx.abort.abort();
        ctx.active?.kill('interrupt');
        ctx.log.warn('control: stop requested; stopping the run');
        return ok('stopping');
      default:
        return fail(`unknown control action "${(req as { action?: string }).action}"`);
    }
  };

  const server = new ControlServer(ctx.paths, handler);
  server.start();

  const hooks: ResumeHooks = {
    awaitHaltAction: (h: Halted) => {
      runtime.update({ phase: 'halted', currentTask: h.taskId, note: `${h.category}: ${h.reason}` });
      return new Promise((resolve) => { pendingHalt = resolve; });
    },
    quitRequested: () => stopped,
    onSplitStart: (r) => { runtime.update({ note: `splitting ${r.id}: the agent is rewriting the task…` }); },
    onSplitFailed: (r, code) => { runtime.update({ note: `split ${r.id} did not finish (exit ${code})` }); },
    onPlanReloaded: (parentId, childIds) => {
      planRevision += 1;
      runtime.update({ planRevision, note: `split ${parentId} → ${childIds.join(', ')}` });
    },
  };

  // Publish where the pipeline is. The runtime file is what `attach` reads for the live stream,
  // the watch panel and the queued pause target.
  const reflect = setInterval(() => {
    const running = ctx.tasks.find((t) => (ctx.state.tasks[t.id]?.status ?? 'pending') === 'running');
    const st = running ? ctx.state.tasks[running.id] : undefined;
    const lastLog = st?.logs?.[st.logs.length - 1];
    runtime.update({
      phase: ctx.state.halted ? 'halted' : 'running',
      currentTask: running?.id,
      stream: lastLog?.log,
      watch: ctx.watch,
      pauseAt: ctx.pauseAt,
    });
  }, 500);
  reflect.unref?.();

  let code = 1;
  try {
    code = await runWithResume(ctx, run, hooks);
  } finally {
    clearInterval(reflect);
    server.stop();
    runtime.update({
      phase: code === 3 ? 'halted' : code === 0 ? 'done' : code === 2 || code === 130 || code === 143 ? 'stopped' : 'error',
      exitCode: code,
      currentTask: undefined,
    });
    runtime.stop();
    clearDaemonRecord(ctx.paths);
  }
  return code;
}

/**
 * `symphony start`: launch the harness detached, forwarding the run flags. The child writes its pid to
 * `.symphony/daemon.json` (via `runWithDaemon`) and owns the lock exactly as a foreground run does.
 */
export function startCommand(paths: Paths, forwarded: string[], log: Logger): number {
  const live = liveLock(paths);
  if (live) throw new UsageError(`another symphony run is active (pid ${live.pid}, started ${live.startedAt}). Wait for it or remove ${paths.lock} if it is stale.`);
  const previous = readDaemonRecord(paths);
  if (previous && isAlive(previous.pid)) throw new UsageError(`a symphony daemon is already running (pid ${previous.pid}, started ${previous.startedAt}).`);

  ensureDir(paths.symphony);
  const logFile = join(paths.symphony, 'daemon.log');
  const fd = openSync(logFile, 'a');
  const cli = process.argv[1];
  const args = [...process.execArgv, cli, ...forwarded];
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: paths.root,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: process.env,
    });
  } finally {
    closeSync(fd);
  }
  child.unref();
  if (child.pid === undefined) throw new UsageError('could not start the symphony daemon');
  writeDaemonRecord(paths, { pid: child.pid, startedAt: nowIso() });
  log.info(`symphony started in the background (pid ${child.pid}); output → ${logFile}`);
  log.info(`attach with: symphony attach    ·    stop with: symphony stop`);
  return 0;
}

/** `symphony stop`: ask the daemon to stop gracefully, falling back to a signal. */
export async function stopCommand(paths: Paths, log: Logger): Promise<number> {
  const record = readDaemonRecord(paths);
  const lock = readLock(paths);
  const pid = record?.pid ?? lock?.pid;
  if (!pid || !isAlive(pid)) {
    clearDaemonRecord(paths);
    log.info('no running symphony daemon');
    return 0;
  }
  const res = await sendControl(paths, 'stop', undefined, { timeoutMs: 4000 });
  if (res?.ok) {
    log.info(`stop requested (pid ${pid})`);
    return 0;
  }
  log.warn(`no answer from the control channel; sending SIGTERM to pid ${pid}`);
  try { process.kill(pid, 'SIGTERM'); } catch (e) {
    log.warn(`could not signal pid ${pid}: ${(e as Error).message}`);
  }
  return 0;
}

function writeDaemonRecord(paths: Paths, record: DaemonRecord): void {
  ensureDir(paths.symphony);
  try { writeFileSync(daemonRecordPath(paths), `${JSON.stringify(record, null, 2)}\n`); } catch { /* best effort */ }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}