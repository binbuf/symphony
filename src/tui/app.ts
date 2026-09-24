import { acceptCommand } from '../commands.js';
import { clearStop, placeStop, stopPresent } from '../paths.js';
import type { RunContext } from '../runner.js';
import { saveState } from '../state.js';
import { buildStatusTable, formatStatusRow, statusColumnWidths, type StatusTable } from '../status.js';
import type { Key, MouseKey } from './keys.js';
import { AnsiTerminal } from './terminal.js';
import { displayWidth, fit, padTo, sanitizeLine, sliceColumns, splice, wrapColumns, wrapText } from './text.js';
import { fmtTime } from '../util.js';
import type { WatchState } from '../watch.js';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', inv: '\x1b[7m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m',
  // Full-row backgrounds for the task the pipeline is on: forest green while it runs, deep red when
  // it is the task the run halted on after failing. Truecolor, with a bright foreground for contrast.
  bgRunning: '\x1b[97;48;2;34;139;34m',
  bgFailed: '\x1b[97;48;2;139;0;0m',
} as const;

const STREAM_MAX = 5000;
const TABLE_TTL_MS = 250;
const TOAST_MS = 5000;
const BAR_ROWS = 2;
/** Height of the pipeline-watch panel (a title line plus four body lines, enough for a 3–5 sentence summary). */
const WATCH_ROWS = 5;

export type Layout = 'both' | 'top' | 'bottom';

interface PanelState { vOffset: number; hOffset: number; follow: boolean }
interface Dialog { title: string; lines: string[]; confirm: () => void }
interface Box { title: string; lines: string[] }

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** HH:MM:SS, so the pipeline and current-task clocks visibly tick. */
export function fmtClock(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '--:--:--';
  const s = Math.max(0, Math.round(seconds));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** `m:ss` until `at` (epoch ms), used for the watch panel's next-check countdown. */
function fmtCountdown(at: number): string {
  const s = Math.max(0, Math.round((at - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/** Local HH:MM:SS for an ISO stamp, for the watch panel's "updated" label. */
function fmtIsoClock(iso?: string): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? fmtTime(d) : '--:--:--';
}

function progressBar(done: number, total: number, width: number): string {
  if (total <= 0) return '░'.repeat(width);
  const filled = clamp(Math.round((done / total) * width), 0, width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

/** The ANSI colour a captured stream line is tagged with, or '' when it is plain. */
function colorFor(line: string): string {
  if (/\bERROR\b|\[error\]|\[tool-result ERROR\]|\[stderr\]/.test(line)) return C.red;
  if (/\bWARN\b/.test(line)) return C.yellow;
  if (line.includes('[think]')) return C.magenta;
  if (line.includes('[tool]')) return C.cyan;
  if (line.includes('[result] ok')) return C.green;
  if (line.includes('[text]')) return C.bold;
  return '';
}

/** Colour a captured stream line by its leading tag; ANSI-free input, ANSI-coloured output. */
function colorLog(line: string): string {
  const color = colorFor(line);
  return color ? `${color}${line}${C.reset}` : line;
}

/**
 * The interactive run view: a self-updating status table on top, the live provider/harness stream
 * below, and a metrics + keybinding bar at the bottom. It renders from the same in-memory state the
 * runner mutates, and captures the run's stdout through `runWithTui` rather than owning a logger.
 */
export class TuiApp {
  private focus: 'status' | 'log' = 'status';
  private statusPanel: PanelState = { vOffset: 0, hOffset: 0, follow: false };
  private logPanel: PanelState = { vOffset: 0, hOffset: 0, follow: true };
  private stream: string[] = [];
  private partial = '';
  private selected = 0;
  private dialog?: Dialog;
  private help = false;
  private haltMode = false;
  private toastMsg?: string;
  private toastUntil = 0;
  private splitRatio = 0.5;
  private layout: Layout = 'both';
  /** When true every status cell is shown in full and the user pans with ← →. */
  private expand = false;
  /** When true the live output wraps long lines instead of clipping and panning them. */
  private logWrap = false;
  /** Anchor column of an in-progress middle-button drag, for horizontal panning. */
  private mouseDrag?: { x: number };
  private lastStatuses = new Map<string, string>();
  private lastHalted = false;
  private renderScheduled = false;
  private timer?: NodeJS.Timeout;
  private tableCache?: { at: number; table: StatusTable };
  private wrapCache?: { cols: number; version: number; lines: string[] };
  /** Bumped whenever the stream changes; the wrap cache's key, since its length can plateau at the cap. */
  private streamVersion = 0;
  private haltResolve?: (d: 'clear' | 'quit') => void;
  private stopped = false;
  /** Set once the user confirms quitting; the wrapper stops looping on it. */
  quitRequested = false;

  constructor(private readonly ctx: RunContext, private readonly term: AnsiTerminal) {}

  start(): void {
    this.term.enter();
    this.term.onKey((k) => this.handleKey(k));
    this.term.onResize(() => this.render());
    this.selected = this.initialSelection();
    this.snapshotStatuses();
    this.render();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.term.dispose();
    this.term.leave();
  }

  /** Feed captured stdout (may hold several lines or a partial one) into the stream panel. */
  pushOutput(text: string): void {
    this.partial += text;
    const parts = this.partial.split('\n');
    this.partial = parts.pop() ?? '';
    for (const line of parts) this.stream.push(sanitizeLine(line));
    if (this.stream.length > STREAM_MAX) this.stream.splice(0, this.stream.length - STREAM_MAX);
    if (parts.length) this.streamVersion += 1;
    this.scheduleRender();
  }

  /** The last `n` stream lines, printed after the alternate screen is left so the outcome survives. */
  tail(n: number): string[] {
    return this.stream.slice(-n);
  }

  toast(msg: string): void {
    this.toastMsg = sanitizeLine(msg);
    this.toastUntil = Date.now() + TOAST_MS;
    this.scheduleRender();
  }

  /** Keep the TUI open after a halt; resolves when the user clears the halt or quits. */
  awaitHaltAction(): Promise<'clear' | 'quit'> {
    this.haltMode = true;
    this.toast('halted: press c to clear the halt and retry, or q to exit');
    this.render();
    return new Promise((resolve) => { this.haltResolve = resolve; });
  }

  private resolveHalt(d: 'clear' | 'quit'): void {
    this.haltMode = false;
    const resolve = this.haltResolve;
    this.haltResolve = undefined;
    this.toast(d === 'clear' ? 'halt cleared; restarting the run' : 'exiting');
    this.render();
    resolve?.(d);
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    setTimeout(() => { this.renderScheduled = false; this.render(); }, 33).unref?.();
  }

  private tick(): void {
    this.checkTransitions();
    this.render();
  }

  private checkTransitions(): void {
    for (const t of this.ctx.tasks) {
      const status = this.ctx.state.tasks[t.id]?.status ?? 'pending';
      const prev = this.lastStatuses.get(t.id);
      if (prev !== undefined && prev !== status) this.toast(`${t.id} → ${status}`);
      this.lastStatuses.set(t.id, status);
    }
    const halted = !!this.ctx.state.halted;
    if (halted && !this.lastHalted) this.toast(`halted: ${this.ctx.state.halted!.category}`);
    this.lastHalted = halted;
  }

  private snapshotStatuses(): void {
    for (const t of this.ctx.tasks) this.lastStatuses.set(t.id, this.ctx.state.tasks[t.id]?.status ?? 'pending');
    this.lastHalted = !!this.ctx.state.halted;
  }

  private initialSelection(): number {
    const running = this.ctx.tasks.findIndex((t) => this.ctx.state.tasks[t.id]?.status === 'running');
    if (running >= 0) return running;
    const held = this.ctx.tasks.findIndex((t) => ['blocked', 'failed'].includes(this.ctx.state.tasks[t.id]?.status ?? ''));
    return held >= 0 ? held : 0;
  }

  private table(): StatusTable {
    const now = Date.now();
    if (!this.tableCache || now - this.tableCache.at > TABLE_TTL_MS) {
      this.tableCache = { at: now, table: buildStatusTable(this.ctx.tasks, this.ctx.state, { expand: this.expand, timeZone: this.ctx.config.timeZone }) };
    }
    return this.tableCache.table;
  }

  private selectedTaskId(): string | undefined {
    return this.ctx.tasks[this.selected]?.id;
  }

  /**
   * The task the pipeline is "on": the one in flight, or — once a run has halted on a task that
   * failed — that task. Failed tasks left over from earlier runs (or a continued run that moved
   * past a failure) are not current and so are not flagged.
   */
  private currentTaskId(): string | undefined {
    const running = this.ctx.tasks.find((t) => this.ctx.state.tasks[t.id]?.status === 'running');
    if (running) return running.id;
    const halted = this.ctx.state.halted?.taskId;
    if (halted && this.ctx.state.tasks[halted]?.status === 'failed') return halted;
    return undefined;
  }

  // ---------------------------------------------------------------- key handling

  private handleKey(k: Key): void {
    if (this.help) { this.help = false; this.render(); return; }
    if (this.dialog) return this.handleDialogKey(k);
    if (k.type === 'mouse') return this.handleMouse(k);
    const name = k.type === 'key' ? k.name : undefined;
    const char = k.type === 'char' ? k.char : undefined;

    if (this.haltMode) {
      if (char === 'c' || char === 'y') { this.resolveHalt('clear'); return; }
      if (char === 'q' || name === 'ctrl-c' || name === 'escape') { this.resolveHalt('quit'); return; }
    }

    if (char === 'q' || name === 'ctrl-c') return this.openQuit();
    if (char === '?') { this.help = true; return this.render(); }
    if (name === 'tab') return this.cycleFocus(1);
    if (name === 'shift-tab') return this.cycleFocus(-1);
    if (name === 'up') return this.scroll('up', 1);
    if (name === 'down') return this.scroll('down', 1);
    if (name === 'pageup') return this.scroll('up', this.focusBodyHeight());
    if (name === 'pagedown') return this.scroll('down', this.focusBodyHeight());
    if (name === 'home' || char === 'g') return this.scrollTo('top');
    if (name === 'end' || char === 'G') return this.scrollTo('bottom');
    if (name === 'left' || char === 'h') return this.pan(-4);
    if (name === 'right' || char === 'l') return this.pan(4);
    if (char === 's') return this.toggleFollow();
    if (char === 'n') return this.selectTask(1);
    if (char === 'N') return this.selectTask(-1);
    if (char === 'a') return this.openAccept();
    if (char === 'b') return this.openSplit();
    if (char === 'c') return this.openClearHalt();
    if (char === 'p') return this.togglePause();
    if (char === 'P') return this.togglePauseAt();
    if (char === 'w') return this.refreshWatch();
    if (char === 'e') return this.toggleExpand();
    if (char === 't') return this.toggleWrap();
    if (char === 'z') return this.cycleLayout();
    if (char === '[' || char === '-') return this.adjustSplit(-0.05);
    if (char === ']' || char === '+') return this.adjustSplit(0.05);
  }

  private handleDialogKey(k: Key): void {
    const name = k.type === 'key' ? k.name : undefined;
    const char = k.type === 'char' ? k.char : undefined;
    if (char === 'y' || name === 'enter') { const d = this.dialog!; this.dialog = undefined; d.confirm(); this.render(); return; }
    if (char === 'n' || name === 'escape' || char === 'q' || name === 'ctrl-c') { this.dialog = undefined; this.render(); }
  }

  // ---------------------------------------------------------------- mouse

  /** Route a decoded SGR mouse event: wheels scroll/pan, drag pans, clicks focus and select. */
  private handleMouse(m: MouseKey): void {
    if (m.button === 'wheel-up') return this.scroll('up', 3);
    if (m.button === 'wheel-down') return this.scroll('down', 3);
    if (m.button === 'wheel-left') return this.pan(-4);
    if (m.button === 'wheel-right') return this.pan(4);
    if (m.button === 'middle') {
      if (m.release) { this.mouseDrag = undefined; return; }
      if (m.motion) {
        if (this.mouseDrag) {
          const delta = m.x - this.mouseDrag.x;
          this.mouseDrag.x = m.x;
          if (delta) this.pan(delta);
        }
        return;
      }
      this.mouseDrag = { x: m.x };
      return;
    }
    if (m.motion || m.release) return;
    if (m.button === 'left') return this.handleLeftClick(m);
    if (m.button === 'right') return this.toggleFollow();
  }

  /** Left click focuses the panel under the pointer; on a status body row it selects that task. */
  private handleLeftClick(m: MouseKey): void {
    const row = m.y - 1;
    const g = this.panelGeometry();
    if (g.statusHeight > 0 && row >= g.statusTop && row < g.statusTop + g.statusHeight) {
      this.focus = 'status';
      const bodyRow = row - (g.statusTop + 2);
      if (bodyRow >= 0) {
        const bodyArea = Math.max(0, g.statusHeight - 2);
        const table = this.table();
        const maxOff = Math.max(0, table.rows.length - bodyArea);
        const off = this.statusPanel.follow ? maxOff : clamp(this.statusPanel.vOffset, 0, maxOff);
        const id = table.rowTask[off + bodyRow];
        const idx = id ? this.ctx.tasks.findIndex((t) => t.id === id) : -1;
        if (idx >= 0) {
          this.selected = idx;
          this.statusPanel.follow = false;
        }
      }
      return this.render();
    }
    if (g.logHeight > 0 && row >= g.logTop && row < g.logTop + g.logHeight) {
      this.focus = 'log';
      return this.render();
    }
    this.render();
  }

  private openQuit(): void {
    this.dialog = {
      title: 'Quit symphony run?',
      lines: [
        'The current session is stopped and recorded unfinished,',
        'exactly like pressing Ctrl-C. The task is retried next run.',
        '',
        'y / Enter  quit now        n / Esc  keep running',
      ],
      confirm: () => {
        this.quitRequested = true;
        this.ctx.interrupted = true;
        this.ctx.abort.abort();
        this.ctx.active?.kill('interrupt');
        if (this.haltResolve) { this.resolveHalt('quit'); return; }
        this.toast('quitting: stopping the current session…');
      },
    };
    this.render();
  }

  private openAccept(): void {
    const id = this.selectedTaskId();
    if (!id) return this.toast('no task selected');
    const status = this.ctx.state.tasks[id]?.status ?? 'pending';
    if (status !== 'blocked' && status !== 'failed') return this.toast(`${id} is ${status}; only blocked/failed tasks can be accepted`);
    this.dialog = {
      title: `Accept ${id}?`,
      lines: [
        `This records ${id} as done by human sign-off (was ${status}).`,
        'Its commits are kept; the roadmap bullet becomes [x] ⟵ accepted.',
        '',
        'y / Enter  accept          n / Esc  cancel',
      ],
      confirm: () => {
        try {
          acceptCommand(this.ctx.paths, this.ctx.state, this.ctx.tasks, [id], undefined, this.ctx.log);
          this.toast(`${id} accepted`);
        } catch (e) {
          this.toast(`${id}: ${(e as Error).message}`);
        }
        this.tableCache = undefined;
      },
    };
    this.render();
  }

  /**
   * Split the selected task into subtasks (T10 → T10a, T10b, …). The run is stopped at a boundary
   * first — or the running session is stopped when this task is the one in flight — then the view
   * hands the request to the wrapper, which runs the split session and resumes the run on the
   * subtasks. Unlike `P`, which only places a sentinel, this is the only key that rewrites the plan.
   */
  private openSplit(): void {
    const id = this.selectedTaskId();
    if (!id) return this.toast('no task selected');
    const status = this.ctx.state.tasks[id]?.status ?? 'pending';
    if (status === 'done' || status === 'accepted') return this.toast(`${id} is ${status}; nothing to split`);
    if (this.ctx.splitRequest) {
      return this.toast(this.ctx.splitRequest.id === id
        ? `${id} is already queued for a split`
        : `a split of ${this.ctx.splitRequest.id} is already queued`);
    }
    const running = status === 'running';
    this.dialog = {
      title: `Split ${id} into subtasks?`,
      lines: [
        'The agent rewrites the task into 2–6 smaller task files',
        `(${id}a, ${id}b, …), replaces its roadmap bullet, then the`,
        'run resumes automatically on the subtasks. The split is a',
        'normal git commit; undo it with git or `symphony replan`.',
        '',
        running ? 'The session running now is stopped and recorded unfinished.' : 'The run pauses at the next task boundary.',
        '',
        'y / Enter  split           n / Esc  cancel',
      ],
      confirm: () => {
        this.ctx.splitRequest = { id };
        if (running) this.ctx.active?.kill('interrupt');
        this.toast(running ? `${id}: stopping the session, then splitting…` : `split queued: run stops at the next boundary, then splits ${id}`);
        // The view is in halt mode (the run loop has already returned): release it so the wrapper
        // can pick the request up and act on it.
        if (this.haltMode) this.resolveHalt('quit');
      },
    };
    this.render();
  }

  /** The plan was rewritten underneath the view (a split): drop caches and re-clamp the selection. */
  onPlanChanged(): void {
    this.tableCache = undefined;
    this.wrapCache = undefined;
    this.selected = clamp(this.selected, 0, Math.max(0, this.ctx.tasks.length - 1));
    this.snapshotStatuses();
    this.render();
  }

  private openClearHalt(): void {
    const h = this.ctx.state.halted;
    if (!h) return this.toast('not halted');
    this.dialog = {
      title: 'Clear the halt?',
      lines: [
        `${h.taskId ? `${h.taskId} · ` : ''}${h.category}: ${h.reason}`,
        h.category === 'attempts' ? 'An attempts halt needs --retry or reset T.. too.' : '',
        '',
        'y / Enter  clear           n / Esc  cancel',
      ].filter((l) => l !== ''),
      confirm: () => {
        if (this.haltResolve) { this.resolveHalt('clear'); return; }
        delete this.ctx.state.halted;
        saveState(this.ctx.paths, this.ctx.state);
        this.toast('halt cleared');
      },
    };
    this.render();
  }

  private togglePause(): void {
    const { paths } = this.ctx;
    try {
      if (stopPresent(paths)) {
        clearStop(paths);
        this.toast('resumed: pause sentinel removed');
      } else {
        placeStop(paths);
        this.toast('pausing at the next task/continuation boundary');
      }
    } catch (e) {
      this.toast(`pause toggle failed: ${(e as Error).message}`);
    }
    this.render();
  }

  /**
   * Queue a pause before the selected task (or clear it when it is already the target). Unlike `p`,
   * which stops at the next boundary, the run keeps going and the sentinel is placed only when the
   * pipeline reaches that task, so the stop lands exactly where the user asked.
   */
  private togglePauseAt(): void {
    if (this.layout === 'bottom') return this.toast('status panel hidden (press z)');
    const id = this.selectedTaskId();
    if (!id) return this.toast('no task selected');
    if (this.ctx.pauseAt === id) {
      delete this.ctx.pauseAt;
      this.toast(`pause target cleared: ${id}`);
      this.render();
      return;
    }
    if (stopPresent(this.ctx.paths)) {
      this.toast('already paused (.stop present); press p to resume first');
      return this.render();
    }
    const status = this.ctx.state.tasks[id]?.status ?? 'pending';
    if (status === 'done' || status === 'accepted' || status === 'blocked') {
      this.toast(`${id} is ${status}; it will not run again`);
      return this.render();
    }
    if (status === 'running') {
      this.toast(`${id} is already running; pause will not apply to it`);
      return this.render();
    }
    this.ctx.pauseAt = id;
    this.toast(`pause queued: run stops before ${id}`);
    this.render();
  }

  /** Ask the pipeline watcher to run a check immediately (the next scheduled one is unchanged). */
  private refreshWatch(): void {
    if (!this.ctx.watch) return this.toast('pipeline watch is off');
    if (!this.ctx.watchRefresh) return this.toast('pipeline watch is not running');
    this.toast('pipeline watch: checking now…');
    this.ctx.watchRefresh();
    this.render();
  }

  // ---------------------------------------------------------------- scrolling

  private cycleFocus(dir: number): void {
    const order: Array<'status' | 'log'> = this.layout === 'top' ? ['status'] : this.layout === 'bottom' ? ['log'] : ['status', 'log'];
    const i = order.indexOf(this.focus);
    this.focus = order[(i + dir + order.length) % order.length];
    this.render();
  }

  private scroll(dir: 'up' | 'down', n: number): void {
    const p = this.focus === 'status' ? this.statusPanel : this.logPanel;
    const max = this.focusMaxOffset();
    p.vOffset = clamp(p.vOffset + (dir === 'down' ? n : -n), 0, max);
    if (dir === 'up') p.follow = false;
    else if (p.vOffset >= max) p.follow = true;
    this.render();
  }

  private scrollTo(where: 'top' | 'bottom'): void {
    const p = this.focus === 'status' ? this.statusPanel : this.logPanel;
    p.vOffset = where === 'top' ? 0 : this.focusMaxOffset();
    p.follow = where === 'bottom';
    this.render();
  }

  private pan(delta: number): void {
    const p = this.focus === 'status' ? this.statusPanel : this.logPanel;
    const { cols } = this.term.size();
    p.hOffset = clamp(p.hOffset + delta, 0, Math.max(0, this.focusMaxWidth() - cols));
    this.render();
  }

  private toggleFollow(): void {
    const p = this.focus === 'status' ? this.statusPanel : this.logPanel;
    p.follow = !p.follow;
    if (p.follow) p.vOffset = this.focusMaxOffset();
    this.toast(`${this.focus} panel follow ${p.follow ? 'on' : 'off'}`);
    this.render();
  }

  private cycleLayout(): void {
    this.layout = this.layout === 'both' ? 'top' : this.layout === 'top' ? 'bottom' : 'both';
    if (this.layout === 'top') this.focus = 'status';
    if (this.layout === 'bottom') this.focus = 'log';
    this.toast(`layout: ${this.layout}`);
    this.render();
  }

  /** Toggle full-width status cells; the extra width is reached by panning the focused panel. */
  private toggleExpand(): void {
    this.expand = !this.expand;
    this.tableCache = undefined;
    this.statusPanel.hOffset = 0;
    if (this.layout !== 'bottom') this.focus = 'status';
    this.toast(this.expand ? 'columns expanded — pan with ← →' : 'columns compact');
    this.render();
  }

  /** Toggle wrapping of over-long live-output lines (on = wrap, off = clip and pan with ← →). */
  private toggleWrap(): void {
    this.logWrap = !this.logWrap;
    this.logPanel.hOffset = 0;
    this.wrapCache = undefined;
    if (this.layout !== 'top') this.focus = 'log';
    this.toast(this.logWrap ? 'live output wraps long lines' : 'live output clips long lines — pan with ← →');
    this.render();
  }

  private adjustSplit(delta: number): void {
    this.splitRatio = clamp(this.splitRatio + delta, 0.2, 0.8);
    this.render();
  }

  private selectTask(delta: number): void {
    if (this.layout === 'bottom') return this.toast('status panel hidden (press z)');
    this.focus = 'status';
    this.statusPanel.follow = false;
    this.selected = clamp(this.selected + delta, 0, Math.max(0, this.ctx.tasks.length - 1));
    this.ensureSelectionVisible();
    this.render();
  }

  private ensureSelectionVisible(): void {
    const id = this.selectedTaskId();
    if (!id) return;
    const row = this.table().taskRow[id];
    if (row === undefined) return;
    const area = Math.max(1, this.focusBodyHeight());
    if (row < this.statusPanel.vOffset) this.statusPanel.vOffset = row;
    else if (row >= this.statusPanel.vOffset + area) this.statusPanel.vOffset = row - area + 1;
  }

  private focusBodyHeight(): number {
    const { rows } = this.term.size();
    const { top, bottom } = this.panelHeights(rows - BAR_ROWS - this.watchRows());
    return this.focus === 'status' ? Math.max(1, top - 2) : Math.max(1, bottom - 1);
  }

  private focusMaxOffset(): number {
    const area = this.focusBodyHeight();
    const total = this.focus === 'status' ? this.table().rows.length : this.logLineCount();
    return Math.max(0, total - area);
  }

  private focusMaxWidth(): number {
    if (this.focus === 'status') {
      const table = this.table();
      const widths = statusColumnWidths(table);
      const header = formatStatusRow(table.head, widths);
      let max = displayWidth(header);
      for (const row of table.rows) max = Math.max(max, displayWidth(formatStatusRow(row, widths)));
      return max;
    }
    // A wrapped panel always fits the viewport, so there is nothing to pan to.
    if (this.logWrap) return this.term.size().cols;
    let max = 0;
    for (const line of this.stream) max = Math.max(max, displayWidth(line));
    return max;
  }

  /** Number of display lines the live output occupies (wrapped or not), for scroll bounds. */
  private logLineCount(): number {
    return this.logWrap ? this.wrappedLogLines().length : this.stream.length;
  }

  /**
   * The live stream hard-wrapped to the current width, each segment padded to a full row and coloured
   * by its source line's tag. Cached per (cols, stream length): stream lines are append-only.
   */
  private wrappedLogLines(cols = this.term.size().cols): string[] {
    const cached = this.wrapCache;
    if (cached && cached.cols === cols && cached.version === this.streamVersion) return cached.lines;
    const lines: string[] = [];
    for (const raw of this.stream) {
      const color = colorFor(raw);
      for (const segment of wrapColumns(raw, cols)) {
        const padded = padTo(segment, cols);
        lines.push(color ? `${color}${padded}${C.reset}` : padded);
      }
    }
    this.wrapCache = { cols, version: this.streamVersion, lines };
    return lines;
  }

  /** Screen row spans of each pane, so mouse coordinates can be mapped back to a panel. */
  private panelGeometry(rows = this.term.size().rows): { statusTop: number; statusHeight: number; logTop: number; logHeight: number } {
    const watchRows = this.watchRows(rows);
    const { top, bottom } = this.panelHeights(rows - BAR_ROWS - watchRows);
    const statusTop = watchRows;
    return { statusTop, statusHeight: top, logTop: statusTop + top, logHeight: bottom };
  }

  private panelHeights(avail: number): { top: number; bottom: number } {
    if (avail <= 0) return { top: 0, bottom: 0 };
    if (this.layout === 'top') return { top: avail, bottom: 0 };
    if (this.layout === 'bottom') return { top: 0, bottom: avail };
    const min = Math.min(3, Math.floor(avail / 2));
    const top = clamp(Math.round(avail * this.splitRatio), min, avail - min);
    return { top, bottom: avail - top };
  }

  // ---------------------------------------------------------------- rendering

  render(): void {
    if (this.stopped) return;
    const { cols, rows } = this.term.size();
    this.term.draw(this.renderLines(cols, rows));
  }

  renderLines(cols: number, rows: number): string[] {
    const out = new Array<string>(rows).fill(' '.repeat(cols));
    const watchRows = this.watchRows(rows);
    const { top, bottom } = this.panelHeights(rows - BAR_ROWS - watchRows);
    const table = this.table();
    const widths = statusColumnWidths(table);

    let y = 0;
    if (watchRows > 0) {
      const lines = this.watchPanelLines(cols);
      for (let i = 0; i < watchRows && i < lines.length; i++) out[y++] = lines[i];
      y = watchRows;
    }

    const statusTop = y;
    if (top > 0) {
      out[y++] = this.panelTitle('Status', this.statusTitleRight(table), cols, this.focus === 'status');
      const header = formatStatusRow(table.head, widths);
      if (top >= 2) out[y++] = this.clip(header, this.statusPanel.hOffset, cols);
      const bodyArea = Math.max(0, top - 2);
      const bodyRows = table.rows.map((r) => formatStatusRow(r, widths));
      const maxOff = Math.max(0, bodyRows.length - bodyArea);
      const off = this.statusPanel.follow ? maxOff : clamp(this.statusPanel.vOffset, 0, maxOff);
      const selectedId = this.selectedTaskId();
      const currentId = this.currentTaskId();
      for (let i = 0; i < bodyArea; i++) {
        const idx = off + i;
        if (idx >= bodyRows.length) break;
        let line = this.clip(bodyRows[idx], this.statusPanel.hOffset, cols);
        const rowId = table.rowTask[idx];
        // The task in flight (or the one the run halted on) is background-coloured so its state is
        // obvious at a glance: forest green while running, red once it has failed. The selected row
        // is otherwise shown inverted, and a queued pause target in yellow.
        const isTaskRow = table.taskRow[rowId] === idx;
        if (rowId === currentId && isTaskRow) {
          const bg = this.ctx.state.tasks[rowId]?.status === 'failed' ? C.bgFailed : C.bgRunning;
          line = `${bg}${C.bold}${line}${C.reset}`;
        } else if (rowId === selectedId) line = `${C.inv}${line}${C.reset}`;
        else if (this.ctx.pauseAt !== undefined && rowId === this.ctx.pauseAt) line = `${C.yellow}${line}${C.reset}`;
        out[y++] = line;
      }
      y = statusTop + top;
    }

    if (bottom > 0) {
      out[y++] = this.panelTitle('Live output', this.logTitleRight(), cols, this.focus === 'log');
      const bodyArea = Math.max(0, bottom - 1);
      if (this.logWrap) {
        const wrapped = this.wrappedLogLines(cols);
        const maxOff = Math.max(0, wrapped.length - bodyArea);
        const off = this.logPanel.follow ? maxOff : clamp(this.logPanel.vOffset, 0, maxOff);
        for (let i = 0; i < bodyArea; i++) {
          const idx = off + i;
          if (idx >= wrapped.length) break;
          out[y++] = wrapped[idx];
        }
      } else {
        const maxOff = Math.max(0, this.stream.length - bodyArea);
        const off = this.logPanel.follow ? maxOff : clamp(this.logPanel.vOffset, 0, maxOff);
        for (let i = 0; i < bodyArea; i++) {
          const idx = off + i;
          if (idx >= this.stream.length) break;
          out[y++] = colorLog(this.clip(this.stream[idx], this.logPanel.hOffset, cols));
        }
      }
    }

    // The key-hints row is permanent: a transient toast temporarily takes the metrics row instead,
// so the toolbar never looks like it vanished while a run is active.
    out[rows - 1] = fit(this.hintsLine(), cols);
    out[rows - 2] = this.toastActive()
      ? padTo(`${C.yellow}${sliceColumns(this.toastMsg!, 0, cols)}${C.reset}`, cols)
      : fit(this.metricsLine(table), cols);

    const overlay = this.help ? this.helpBox() : this.dialog ? this.dialogBox(this.dialog) : undefined;
    if (overlay) this.drawBox(out, cols, rows, overlay);
    return out;
  }

  private clip(line: string, hOffset: number, cols: number): string {
    return padTo(sliceColumns(sanitizeLine(line), hOffset, cols), cols);
  }

  private panelTitle(left: string, right: string, cols: number, focused: boolean): string {
    const l = ` ${left} `;
    const r = right ? ` ${right} ` : '';
    const fill = '─'.repeat(Math.max(0, cols - displayWidth(l) - displayWidth(r)));
    const line = fit(`${l}${fill}${r}`, cols);
    return focused ? `${C.inv}${line}${C.reset}` : `${C.dim}${line}${C.reset}`;
  }

  private statusTitleRight(table: StatusTable): string {
    const s = table.summary;
    return `${s.done}/${s.total} done${this.statusPanel.follow ? ' · follow' : ''}${this.expand ? ' · wide' : ''}`;
  }

  private logTitleRight(): string {
    const mode = this.logPanel.follow ? 'FOLLOW' : 'SCROLL';
    return `${this.logWrap ? 'WRAP · ' : ''}${mode} · ${this.stream.length} lines`;
  }

  // ---------------------------------------------------------------- pipeline watch panel

  /** The watch panel only exists once the watcher is running (or has failed to start). */
  private watchRows(rows = this.term.size().rows): number {
    if (!this.ctx.watch) return 0;
    // Never let the strip crowd out the status table on a very short terminal.
    return Math.max(0, Math.min(WATCH_ROWS, rows - BAR_ROWS - 2));
  }

  private watchTitleRight(w: WatchState): string {
    if (w.status === 'waiting') return w.nextAt !== undefined ? `next in ${fmtCountdown(w.nextAt)}` : 'waiting';
    if (w.status === 'running') return 'checking…';
    if (w.status === 'error') return `error${w.nextAt !== undefined ? ` · retry in ${fmtCountdown(w.nextAt)}` : ''}`;
    return `${w.checks} update${w.checks === 1 ? '' : 's'} · ${fmtIsoClock(w.updatedAt)}`;
  }

  private watchPanelLines(cols: number): string[] {
    const w = this.ctx.watch!;
    const lines = [this.panelTitle('Pipeline watch', this.watchTitleRight(w), cols, false)];
    const bodyRows = WATCH_ROWS - 1;
    const bodyWidth = Math.max(1, cols - 1);
    let text: string;
    let color: string;
    if (w.status === 'waiting') {
      // The countdown lives in the panel title on the right; keep the body text single-purpose.
      text = 'Waiting for updates';
      color = C.dim;
    } else if (w.status === 'running') {
      text = w.summary ? `${w.summary}  ·  checking for updates…` : 'Checking pipeline health…';
      color = C.yellow;
    } else if (w.status === 'error') {
      text = w.summary ? `${w.summary}  ·  watch error: ${w.error ?? 'unknown'}` : `Watch error: ${w.error ?? 'unknown'}`;
      color = C.red;
    } else {
      text = w.summary ?? '';
      color = C.green;
    }
    const wrapped = wrapText(text, bodyWidth, bodyRows);
    for (let i = 0; i < bodyRows; i++) {
      const body = wrapped[i];
      lines.push(padTo(body ? `${color} ${body}${C.reset}` : '', cols));
    }
    return lines;
  }

  private metricsLine(table: StatusTable): string {
    const s = table.summary;
    const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
    const st = s.running ? this.ctx.state.tasks[s.running.id] : undefined;
    const provider = st?.provider ?? this.ctx.config.provider;
    const model = st?.model ? ` · ${st.model}${st.variant ? `#${st.variant}` : ''}` : '';
    const bits = [
      `${progressBar(s.done, s.total, 10)} ${s.done}/${s.total} ${pct}%`,
      `pipeline ${fmtClock(s.durationS)}`,
      s.running ? `task ${s.running.id} ${fmtClock(s.running.elapsedS)}` : 'task --:--:--',
      `$${(s.costUsd || 0).toFixed(2)}`,
      `${provider}${model}`,
    ];
    if (s.blocked.length) bits.push(`blocked ${s.blocked.join(',')}`);
    if (this.ctx.pauseAt) bits.push(`pause@${this.ctx.pauseAt}`);
    if (stopPresent(this.ctx.paths)) bits.push('PAUSED');
    if (this.ctx.state.halted) bits.push(`HALTED ${this.ctx.state.halted.category}`);
    return bits.join('  ·  ');
  }

  private hintsLine(): string {
    if (this.haltMode) return 'c clear halt & retry · b split the halted task · q quit · ↑↓ scroll · Tab focus';
    const base = 'q quit · ? help · Tab focus · ↑↓ scroll · ←→ pan · PgUp/PgDn · Home/End · s follow · n/N task · a accept · b split · c clear-halt · p pause · P pause-at · w watch · e expand · t wrap · z zoom · [ ] panels';
    return base;
  }

  private toastActive(): boolean {
    return this.toastMsg !== undefined && Date.now() < this.toastUntil;
  }

  // ---------------------------------------------------------------- overlays

  private dialogBox(dialog: Dialog): Box {
    return { title: dialog.title, lines: dialog.lines };
  }

  private helpBox(): Box {
    return {
      title: 'Keys',
      lines: [
        'q / Ctrl-C   quit (asks for confirmation)',
        '?            this help (any key closes)',
        'Tab          focus status / live output',
        '↑ ↓          scroll focused panel one line',
        'PgUp PgDn    scroll one screen      Home/End  top / bottom',
        '← →          pan horizontally (h / l too)',
        's            toggle follow (tail) on the focused panel',
        'n / N        select next / previous task',
        'a            accept the selected blocked/failed task',
        'b            split the selected task into subtasks (T10 → T10a, T10b, …)',
        'c            clear a halt (asks for confirmation)',
        'p            pause / resume (toggles the .stop sentinel now)',
        'P            queue a pause before the selected task (placed when the run reaches it)',
        'w            run a pipeline-watch check now',
        'e            expand all status columns (pan the focused panel with ← →)',
        't            wrap long live-output lines (off = clip and pan)',
        'z            cycle layout: both / status only / output only',
        '[ ]  or  - + adjust the panel sizes',
        '',
        'Status: header stays put, rows scroll vertically and pan horizontally.',
        'Live output tails by default; scroll up to pause, s to resume following.',
        'Pipeline watch (top strip): a separate read-only model summarizes progress and health.',
        'Automatic breakdowns (config "breakdown") can rewrite a task into subtasks mid-run; the',
        'view refreshes and toasts when one lands. b does the same on the selected task.',
        '',
        'Mouse: wheel scrolls, tilt-wheel pans, middle-drag pans horizontally,',
        'left-click selects a task, right-click toggles follow. Shift+drag selects text.',
      ],
    };
  }

  private drawBox(out: string[], cols: number, rows: number, box: Box): void {
    const maxLine = Math.max(displayWidth(box.title), ...box.lines.map(displayWidth));
    const width = clamp(maxLine + 4, 24, Math.max(24, cols - 4));
    const boxLines = this.buildBoxLines(box.title, box.lines, width);
    const height = boxLines.length;
    const top = Math.max(0, Math.floor((rows - height) / 2));
    const left = Math.max(0, Math.floor((cols - width) / 2));
    for (let i = 0; i < height; i++) {
      const y = top + i;
      if (y >= rows) break;
      out[y] = splice(out[y], boxLines[i], left, cols);
    }
  }

  private buildBoxLines(title: string, body: string[], width: number): string[] {
    const inner = Math.max(1, width - 2);
    const label = ` ${title} `;
    const dashes = Math.max(0, inner - displayWidth(label) - 1);
    const lines = [`┌─${label}${'─'.repeat(dashes)}┐`];
    for (const b of body) lines.push(`│${fit(` ${b}`, inner)}│`);
    lines.push(`└${'─'.repeat(inner)}┘`);
    return lines;
  }
}
