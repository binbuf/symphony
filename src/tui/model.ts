import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { acceptCommand, clearHaltCommand } from '../commands.js';
import { dispatchControl } from '../control.js';
import type { Logger } from '../logger.js';
import { clearStop, placeStop, stopPresent, type Paths } from '../paths.js';
import { loadProject } from '../project.js';
import { parseRoadmap } from '../roadmap.js';
import type { RunContext, SplitRequest } from '../runner.js';
import { readRuntime, type RuntimeState } from '../runtime.js';
import { activeLock, loadState, saveState, type State } from '../state.js';
import { discoverTasks, type Task } from '../tasks.js';
import type { TimeZone } from '../util.js';
import type { WatchState } from '../watch.js';

/**
 * What the run view needs from whatever it is showing. The local run is served straight from the
 * in-memory {@link RunContext}; `symphony attach` is served by polling the daemon's files. Keeping the
 * two behind one interface is what lets the same renderer, keys and overlays drive both.
 */
export interface TuiConfigView {
  timeZone?: TimeZone;
  provider: string;
}

export interface TuiModel {
  tasks: Task[];
  state: State;
  config: TuiConfigView;
  paths: Paths;
  log: Logger;
  watch?: WatchState;
  pauseAt?: string;
  splitRequest?: SplitRequest;
  /** Timer period for the view; remote attach polls more often to keep the stream fluid. */
  tickMs: number;
  /** True for an attach client: quitting leaves the harness running rather than stopping it. */
  detachOnQuit: boolean;
  /** True while a harness is live (a local run, or a fresh remote heartbeat). */
  isLive(): boolean;
  /** Refresh the backing store; called on every UI tick. A no-op for a local run. */
  poll(): void;
  /** Drain any output appended since the last call (remote stream tail). */
  takeOutput(): string;
  /** Accept a blocked/failed task as done by human sign-off. */
  accept(id: string): void;
  /** Lift a halt, locally or through the daemon. */
  clearHalt(): void;
  /** Ask for the selected task to be split; `stopRunning` interrupts the session when it is that task. */
  requestSplit(id: string, stopRunning: boolean): void;
  /** Queue a pause before a task (or clear it). */
  setPauseAt(id: string | undefined): void;
  /** Pause as soon as possible: stop the running session and close the task out before pausing. */
  requestWrapUp(): void;
  stopPresent(): boolean;
  placeStop(): void;
  clearStop(): void;
  /** Run a pipeline-watch check immediately. */
  refreshWatch(): void;
  /** Quit the view. For a local run this stops the session; for attach it just detaches. */
  quit(): void;
  /** Stop the backing harness itself (the daemon), not just the view. */
  stopHarness(): void;
}

/** True when the value is a live run context rather than an already-built model. */
function isRunContext(x: RunContext | TuiModel): x is RunContext {
  return typeof (x as RunContext).abort?.abort === 'function' && !!(x as RunContext).flags;
}

/** Wrap a raw argument in a model: a local run context is proxied, anything else is used as-is. */
export function asTuiModel(x: RunContext | TuiModel): TuiModel {
  return isRunContext(x) ? new LocalTuiModel(x) : x;
}

/** The in-process view over a running harness, preserving the original direct access. */
export class LocalTuiModel implements TuiModel {
  readonly tickMs = 1000;
  readonly detachOnQuit = false;
  constructor(private readonly ctx: RunContext) {}
  get tasks(): Task[] { return this.ctx.tasks; }
  get state(): State { return this.ctx.state; }
  get config(): TuiConfigView { return this.ctx.config; }
  get paths(): Paths { return this.ctx.paths; }
  get log(): Logger { return this.ctx.log; }
  get watch(): WatchState | undefined { return this.ctx.watch; }
  get pauseAt(): string | undefined { return this.ctx.pauseAt; }
  get splitRequest(): SplitRequest | undefined { return this.ctx.splitRequest; }
  isLive(): boolean { return true; }
  poll(): void { /* in-process: nothing to refresh */ }
  takeOutput(): string { return ''; }
  accept(id: string): void { acceptCommand(this.ctx.paths, this.ctx.state, this.ctx.tasks, [id], undefined, this.ctx.log); }
  clearHalt(): void {
    if (!this.ctx.state.halted) return;
    delete this.ctx.state.halted;
    saveState(this.ctx.paths, this.ctx.state);
  }
  requestSplit(id: string, stopRunning: boolean): void {
    this.ctx.splitRequest = { id };
    if (stopRunning) this.ctx.active?.kill('interrupt');
  }
  setPauseAt(id: string | undefined): void {
    if (id === undefined) delete this.ctx.pauseAt;
    else this.ctx.pauseAt = id;
  }
  requestWrapUp(): void {
    if (this.ctx.active) {
      this.ctx.wrapUpRequest = true;
      this.ctx.active.kill('interrupt');
    } else {
      placeStop(this.ctx.paths);
    }
  }
  stopPresent(): boolean { return stopPresent(this.ctx.paths); }
  placeStop(): void { placeStop(this.ctx.paths); }
  clearStop(): void { clearStop(this.ctx.paths); }
  refreshWatch(): void { this.ctx.watchRefresh?.(); }
  quit(): void {
    this.ctx.interrupted = true;
    this.ctx.abort.abort();
    this.ctx.active?.kill('interrupt');
  }
  stopHarness(): void { this.quit(); }
}

export interface RemoteModelOptions {
  paths: Paths;
  config: TuiConfigView;
  log: Logger;
  /** Deliver a transient message to the view (toasts). */
  onMessage?: (msg: string) => void;
}

/**
 * The client view for `symphony attach`: reads state/roadmap/watch from the project's files, tails the
 * live session log named by `runtime.json`, and routes commands to the daemon's control channel. When
 * no daemon is live it degrades to a read-only browser that can still accept or clear a halt itself
 * (safe, because nothing else is writing state).
 */
export class RemoteTuiModel implements TuiModel {
  tasks: Task[] = [];
  state: State = { version: 1, tasks: {} };
  readonly config: TuiConfigView;
  readonly paths: Paths;
  readonly log: Logger;
  readonly tickMs = 300;
  readonly detachOnQuit = true;
  watch?: WatchState;
  pauseAt?: string;
  splitRequest?: SplitRequest;
  onMessage?: (msg: string) => void;

  private runtime?: RuntimeState;
  private lastStateAt = 0;
  private lastPlanAt = 0;
  private seenPlanRevision = -1;
  private streamPath?: string;
  private streamFd?: number;
  private streamPos = 0;

  constructor(opts: RemoteModelOptions) {
    this.paths = opts.paths;
    this.config = opts.config;
    this.log = opts.log;
    this.onMessage = opts.onMessage;
    this.refreshPlan();
    this.refreshState();
    this.poll();
  }

  isLive(): boolean {
    return activeLock(this.paths) !== undefined;
  }

  poll(): void {
    const now = Date.now();
    this.runtime = readRuntime(this.paths);
    if (now - this.lastPlanAt > 1500) {
      this.lastPlanAt = now;
      this.refreshPlan();
    }
    if (now - this.lastStateAt > 700) {
      this.lastStateAt = now;
      this.refreshState();
    }
    if (this.runtime) {
      this.watch = this.runtime.watch;
      this.pauseAt = this.runtime.pauseAt;
      if (this.runtime.planRevision !== this.seenPlanRevision) {
        this.seenPlanRevision = this.runtime.planRevision;
        this.refreshPlan();
        // The daemon has acted on a split (or performed one): stop showing it as queued.
        this.splitRequest = undefined;
      }
    }
  }

  takeOutput(): string {
    return this.readStreamDelta();
  }

  accept(id: string): void {
    if (this.isLive()) {
      dispatchControl(this.paths, 'accept', { ids: [id] });
      this.onMessage?.(`accepted ${id}`);
      return;
    }
    try {
      const loaded = loadProject(this.paths, this.log);
      acceptCommand(this.paths, loaded.state, loaded.tasks, [id], undefined, this.log);
      this.refreshState();
      this.refreshPlan();
      this.onMessage?.(`${id} accepted`);
    } catch (e) {
      this.onMessage?.(`${id}: ${(e as Error).message}`);
    }
  }

  clearHalt(): void {
    if (this.isLive()) {
      dispatchControl(this.paths, 'clear-halt');
      this.onMessage?.('clearing the halt…');
      return;
    }
    try {
      const loaded = loadProject(this.paths, this.log);
      clearHaltCommand(this.paths, loaded.state, this.log);
      this.refreshState();
      this.onMessage?.('halt cleared');
    } catch (e) {
      this.onMessage?.(`clear-halt: ${(e as Error).message}`);
    }
  }

  requestSplit(id: string, _stopRunning: boolean): void {
    if (!this.isLive()) {
      this.onMessage?.(`${id}: the run is not active; use \`symphony split ${id}\``);
      return;
    }
    dispatchControl(this.paths, 'split', { id });
    this.splitRequest = { id };
    this.onMessage?.(`split queued: ${id}`);
  }

  setPauseAt(id: string | undefined): void {
    if (!this.isLive()) {
      this.onMessage?.('the run is not active; nothing to pause');
      return;
    }
    dispatchControl(this.paths, 'pause-at', { id: id ?? null });
    this.pauseAt = id;
  }

  requestWrapUp(): void {
    if (!this.isLive()) {
      this.onMessage?.('the run is not active; nothing to pause');
      return;
    }
    dispatchControl(this.paths, 'wrap-up');
    this.onMessage?.('pause-now requested: closing out the running task');
  }

  stopPresent(): boolean { return stopPresent(this.paths); }
  placeStop(): void { placeStop(this.paths); }
  clearStop(): void { clearStop(this.paths); }

  refreshWatch(): void {
    if (!this.isLive()) {
      this.onMessage?.('pipeline watch is off');
      return;
    }
    dispatchControl(this.paths, 'watch');
  }

  quit(): void { /* attach only detaches */ }

  stopHarness(): void {
    if (!this.isLive()) return;
    dispatchControl(this.paths, 'stop');
  }

  private refreshState(): void {
    try { this.state = loadState(this.paths); } catch { /* keep the last good state */ }
  }

  private refreshPlan(): void {
    try {
      if (!existsSync(this.paths.roadmap)) return;
      const roadmap = parseRoadmap(readFileSync(this.paths.roadmap, 'utf8'));
      const { tasks } = discoverTasks(this.paths, roadmap);
      this.tasks = tasks;
    } catch { /* keep the last good plan */ }
  }

  /** Read whatever the active session's rendered log has appended since the last poll. */
  private readStreamDelta(): string {
    const rel = this.runtime?.stream;
    if (!rel) { this.closeStream(); return ''; }
    const abs = isAbsolute(rel) ? rel : join(this.paths.root, rel);
    if (!this.streamFd || abs !== this.streamPath) {
      this.closeStream();
      this.streamPath = abs;
      try { this.streamFd = openSync(abs, 'r'); } catch { this.streamFd = undefined; return ''; }
    }
    try {
      const size = fstatSync(this.streamFd).size;
      if (size < this.streamPos) this.streamPos = 0; // truncated or replaced
      if (size === this.streamPos) return '';
      const length = size - this.streamPos;
      const buf = Buffer.allocUnsafe(length);
      const read = readSync(this.streamFd, buf, 0, length, this.streamPos);
      this.streamPos += read;
      return buf.subarray(0, read).toString('utf8');
    } catch {
      this.closeStream();
      return '';
    }
  }

  private closeStream(): void {
    if (this.streamFd !== undefined) {
      try { closeSync(this.streamFd); } catch { /* already closed */ }
    }
    this.streamFd = undefined;
    this.streamPath = undefined;
    this.streamPos = 0;
  }
}