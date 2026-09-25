import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import { loadProject } from '../src/project.js';
import type { RunContext, RunFlags } from '../src/runner.js';
import { newTaskState, type State } from '../src/state.js';
import { buildStatusTable } from '../src/status.js';
import type { Task } from '../src/tasks.js';
import { TuiApp } from '../src/tui/app.js';
import { runWithResume, runWithTui } from '../src/tui/index.js';
import { KeyParser, type Key, type MouseButton, type MouseKey } from '../src/tui/keys.js';
import { AnsiTerminal } from '../src/tui/terminal.js';
import { displayWidth, fit, padTo, sanitizeLine, sliceColumns, splice, stripAnsi, wrapColumns, wrapText } from '../src/tui/text.js';

const task = (id: string, num: number, phase = 'Phase 1'): Task => ({ id, num, title: `Task ${num}`, phase, order: num - 1, meta: {} });

function makeCtx(tasks: Task[], state: State): RunContext {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'symphony-tui-')));
  const log: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };
  return {
    paths, config: DEFAULTS, cli: {}, flags: { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false },
    log, roadmap: { bullets: [], lines: [], eol: '\n' }, tasks, state, interrupted: false, abort: new AbortController(),
  };
}

test('text: display width, slicing, fitting and overlaying account for wide chars and ANSI', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('日本'), 4);
  assert.equal(displayWidth('\x1b[31mred\x1b[0m'), 3);
  assert.equal(sliceColumns('abcdef', 2, 3), 'cde');
  assert.equal(sliceColumns('abcdef', 0, 3), 'abc');
  // A wide character straddling the left edge becomes a space rather than overflowing.
  assert.equal(sliceColumns('a日b', 2, 2), ' b');
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.equal(padTo('ab', 5), 'ab   ');
  assert.equal(splice('abcdefgh', 'XY', 3, 8), 'abcXYfgh');
  assert.equal(stripAnsi('\x1b[1mhi\x1b[0m'), 'hi');
  // Control chars are neutralized: tabs become a space, other C0 controls drop, ESC survives for ANSI.
  assert.equal(sanitizeLine('a\tb'), 'a b');
  assert.equal(sanitizeLine('a\rb\x07c\x1b[31mred'), 'abc\x1b[31mred');
  assert.equal(displayWidth(sanitizeLine('a\tb')), 3);
});

test('text: wrapText wraps on spaces, hard-slices long words, and ellipsizes the overflow', () => {
  assert.deepEqual(wrapText('one two three four', 7, 2).map((s) => s.trimEnd()), ['one two', 'three…']);
  assert.deepEqual(wrapText('short', 10, 2).map((s) => s.trimEnd()), ['short']);
  assert.deepEqual(wrapText('abcdefghij', 4, 3).map((s) => s.trimEnd()), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapText('   ', 5, 2), []);
});

test('text: wrapColumns hard-wraps by display columns without losing characters', () => {
  assert.deepEqual(wrapColumns('abcdef', 4), ['abcd', 'ef']);
  assert.deepEqual(wrapColumns('abc', 4), ['abc']);
  assert.deepEqual(wrapColumns('', 4), ['']);
  // A wide character is never split across the boundary; it moves to the next chunk whole.
  assert.deepEqual(wrapColumns('a日b', 2), ['a', '日', 'b']);
});

test('keys: decodes arrows, paging, modifiers, control keys and split sequences', () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed('\x1b[A'), [{ type: 'key', name: 'up' }]);
  assert.deepEqual(p.feed('\x1b[B\x1b[C\x1b[D'), [{ type: 'key', name: 'down' }, { type: 'key', name: 'right' }, { type: 'key', name: 'left' }]);
  assert.deepEqual(p.feed('\x1b[5~'), [{ type: 'key', name: 'pageup' }]);
  assert.deepEqual(p.feed('\x1b[6~'), [{ type: 'key', name: 'pagedown' }]);
  assert.deepEqual(p.feed('\x1b[Z'), [{ type: 'key', name: 'shift-tab' }]);
  assert.deepEqual(p.feed('\x1b[H'), [{ type: 'key', name: 'home' }]);
  assert.deepEqual(p.feed('\x1b[F'), [{ type: 'key', name: 'end' }]);
  assert.deepEqual(p.feed('\x03'), [{ type: 'key', name: 'ctrl-c' }]);
  assert.deepEqual(p.feed('q'), [{ type: 'char', char: 'q' }]);
  assert.deepEqual(p.feed('\x1b'), [{ type: 'key', name: 'escape' }]);
  // A sequence split across two reads is held until it is complete.
  assert.deepEqual(p.feed('\x1b['), []);
  assert.deepEqual(p.feed('A'), [{ type: 'key', name: 'up' }]);
});

test('keys: decodes SGR mouse press, release, drag and wheel events', () => {
  const p = new KeyParser();
  const mouse = (button: MouseButton, x: number, y: number, motion = false, release = false): MouseKey =>
    ({ type: 'mouse', button, x, y, motion, release });
  assert.deepEqual(p.feed('\x1b[<0;10;5M'), [mouse('left', 10, 5)]);
  assert.deepEqual(p.feed('\x1b[<2;7;3M'), [mouse('right', 7, 3)]);
  assert.deepEqual(p.feed('\x1b[<1;4;9M'), [mouse('middle', 4, 9)]);
  // 32 marks motion; the low bits still name the held button.
  assert.deepEqual(p.feed('\x1b[<33;4;9M'), [mouse('middle', 4, 9, true)]);
  // A trailing `m` is a release (the button bits are meaningless then).
  assert.deepEqual(p.feed('\x1b[<0;10;5m'), [mouse('none', 10, 5, false, true)]);
  // 64 selects the wheel; the low bits give the axis and direction.
  assert.deepEqual(p.feed('\x1b[<64;1;1M'), [mouse('wheel-up', 1, 1)]);
  assert.deepEqual(p.feed('\x1b[<65;1;1M'), [mouse('wheel-down', 1, 1)]);
  assert.deepEqual(p.feed('\x1b[<66;1;1M'), [mouse('wheel-left', 1, 1)]);
  assert.deepEqual(p.feed('\x1b[<67;1;1M'), [mouse('wheel-right', 1, 1)]);
});

test('buildStatusTable maps child session rows back to their parent task', () => {
  const tasks = [task('T01', 1), task('T02', 2)];
  const state: State = {
    version: 1,
    tasks: {
      T01: {
        ...newTaskState('t1'), status: 'done', attempts: 2, durationS: 100, summary: 'landed',
        logs: [
          { kind: 'task', jsonl: 'a', log: 'a', prompt: 'a', status: 'continue', summary: 'slice', started: '2026-01-01T00:00:00Z', durationS: 50 },
          { kind: 'task', jsonl: 'b', log: 'b', prompt: 'b', status: 'done', summary: 'done', started: '2026-01-01T00:01:00Z', durationS: 50 },
        ],
      },
    },
  };
  const table = buildStatusTable(tasks, state);
  assert.equal(table.summary.done, 1);
  assert.equal(table.summary.total, 2);
  assert.equal(table.taskRow['T01'], 0);
  assert.equal(table.taskRow['T02'], 3); // parent + two child rows before it
  assert.deepEqual(table.rowTask, ['T01', 'T01', 'T01', 'T02']);
});

test('TuiApp.renderLines produces a fixed-size frame with both panels and the metrics bar', () => {
  const tasks = [task('T01', 1), task('T02', 2)];
  const state: State = {
    version: 1,
    tasks: {
      T01: { ...newTaskState('t1'), status: 'done', attempts: 1, durationS: 120, costUsd: 0.5, summary: 'ok' },
      T02: { ...newTaskState('t2'), status: 'running', attempts: 1, durationS: 30, started: new Date().toISOString(), provider: 'opencode', model: 'openrouter/z-ai/glm-5.3' },
    },
  };
  const app = new TuiApp(makeCtx(tasks, state), new AnsiTerminal(() => {}));
  const lines = app.renderLines(100, 24);
  assert.equal(lines.length, 24);
  for (const l of lines) assert.equal(displayWidth(l), 100);
  const text = stripAnsi(lines.join('\n'));
  assert.match(text, /Status/);
  assert.match(text, /Live output/);
  assert.match(text, /pipeline \d\d:\d\d:\d\d/);
  assert.match(text, /task T02 \d\d:\d\d:\d\d/);
  assert.match(text, /1\/2 done/);
  assert.match(text, /q quit/);
});

test('TuiApp renders the pipeline-watch panel above the status table', () => {
  const tasks = [task('T01', 1)];
  const state: State = { version: 1, tasks: { T01: { ...newTaskState('t1'), status: 'running', attempts: 1, durationS: 5, started: new Date().toISOString() } } };
  const ctx = makeCtx(tasks, state);
  ctx.watch = { status: 'waiting', enabled: true, intervalMin: 5, provider: 'opencode', model: 'x', nextAt: Date.now() + 300_000, checks: 0 };
  const app = new TuiApp(ctx, new AnsiTerminal(() => {}));
  const lines = app.renderLines(100, 24);
  assert.equal(lines.length, 24);
  for (const l of lines) assert.equal(displayWidth(l), 100);
  const text = stripAnsi(lines.join('\n'));
  assert.match(text, /Pipeline watch/);
  assert.match(text, /Waiting for updates/);
  // One countdown only, on the right of the title — not repeated in the body.
  assert.match(text, /next in \d+:\d\d/);
  assert.doesNotMatch(text, /first check in/);
  // The watch strip is the first pane; the status table sits directly below it.
  assert.match(stripAnsi(lines[0]), /Pipeline watch/);
  assert.match(stripAnsi(lines[5]), /Status/);

  ctx.watch = { status: 'ready', enabled: true, intervalMin: 5, provider: 'opencode', model: 'x', summary: 'On track: T01 is running normally.', updatedAt: new Date().toISOString(), checks: 2 };
  const ready = stripAnsi(app.renderLines(100, 24).join('\n'));
  assert.match(ready, /On track: T01 is running normally\./);
  assert.match(ready, /2 updates/);

  // A silent check before any summary has landed must not leave the body blank.
  ctx.watch = { status: 'ready', enabled: true, intervalMin: 5, provider: 'opencode', model: 'x', updatedAt: new Date().toISOString(), checks: 1 };
  const silent = stripAnsi(app.renderLines(100, 24).join('\n'));
  assert.match(silent, /1 update ·/);
  assert.match(silent, /No update/, 'a summary-less ready panel shows a placeholder instead of going blank');
});

test('TuiApp scrolls the status table to the running task on start and when the pipeline moves on', () => {
  const tasks = Array.from({ length: 30 }, (_, i) => task(`T${String(i + 1).padStart(2, '0')}`, i + 1));
  const runningState = (id: string): State => ({
    version: 1,
    tasks: { [id]: { ...newTaskState(id), status: 'running', attempts: 1, durationS: 5, started: new Date().toISOString() } },
  });
  const ctx = makeCtx(tasks, runningState('T25'));
  const app = new TuiApp(ctx, new AnsiTerminal(() => {}));
  const priv = app as unknown as {
    start(): void; stop(): void; checkTransitions(): void; tableCache?: unknown;
    statusPanel: { vOffset: number; follow: boolean };
  };

  // Start lands on T25 (far down the table) instead of showing the first rows.
  priv.start();
  priv.stop();
  assert.ok(priv.statusPanel.vOffset > 0, 'start scrolled down to the running task');
  assert.match(stripAnsi(app.renderLines(100, 24).join('\n')), /T25/);

  // When the pipeline moves to a different task the panel recenters on it.
  const before = priv.statusPanel.vOffset;
  ctx.state = runningState('T28');
  priv.tableCache = undefined;
  priv.checkTransitions();
  assert.ok(priv.statusPanel.vOffset > before, 'a task change scrolls further down to the new active task');
  const moved = stripAnsi(app.renderLines(100, 24).join('\n'));
  assert.match(moved, /T28/);
});

test('TuiApp: e expands every status column and panning can reach the full text', () => {
  const tasks = [task('T01', 1)];
  const state: State = {
    version: 1,
    tasks: { T01: { ...newTaskState('t1'), status: 'running', attempts: 1, started: new Date().toISOString(), provider: 'opencode', model: 'some-provider-namespace/claude-sonnet-4-5', summary: 'a deliberately long summary that compact mode truncates' } },
  };
  const app = new TuiApp(makeCtx(tasks, state), new AnsiTerminal(() => {}));
  const priv = app as unknown as { handleKey(k: Key): void; focusMaxWidth(): number };
  const press = (char: string) => priv.handleKey({ type: 'char', char });

  const compactWidth = priv.focusMaxWidth();
  press('e');
  assert.match(stripAnsi(app.renderLines(100, 24).join('\n')), /columns expanded/, 'the toggle announces itself');
  const expandedWidth = priv.focusMaxWidth();
  assert.ok(expandedWidth > compactWidth, 'expanded columns are wider than the compact table');
  assert.ok(stripAnsi(app.renderLines(expandedWidth + 1, 24).join('\n')).includes('claude-sonnet-4-5'), 'the full model is now rendered');

  press('e');
  assert.ok(priv.focusMaxWidth() < expandedWidth, 'toggling back compacts the table again');
});

test('TuiApp: t toggles live-output wrapping, which reflows a long line instead of clipping it', () => {
  const term = new AnsiTerminal(() => {});
  const app = new TuiApp(makeCtx([task('T01', 1)], { version: 1, tasks: {} }), term);
  const priv = app as unknown as { handleKey(k: Key): void; logLineCount(): number; focusMaxWidth(): number };
  const press = (char: string) => priv.handleKey({ type: 'char', char });
  const cols = term.size().cols;
  app.pushOutput(`${'x'.repeat(cols + 10)}\n`);

  assert.equal(priv.logLineCount(), 1, 'one stream line is one display line while wrapping is off');
  press('t');
  assert.match(stripAnsi(app.renderLines(cols, 14).join('\n')), /live output wraps long lines/, 'the toggle announces itself');
  assert.equal(priv.logLineCount(), 2, 'the long line now occupies two wrapped rows');
  assert.equal(priv.focusMaxWidth(), cols, 'a wrapped panel has nothing left to pan to');
  press('t');
  assert.equal(priv.logLineCount(), 1, 'toggling back returns to one clipped row per line');
});

test('TuiApp: P queues a pause before the selected task and highlights it', () => {
  const tasks = [task('T01', 1), task('T02', 2), task('T03', 3)];
  const state: State = {
    version: 1,
    tasks: {
      T01: { ...newTaskState('t1'), status: 'done', attempts: 1, durationS: 10 },
      T02: { ...newTaskState('t2'), status: 'pending' },
    },
  };
  const ctx = makeCtx(tasks, state);
  const app = new TuiApp(ctx, new AnsiTerminal(() => {}));
  const priv = app as unknown as {
    handleKey(k: Key): void;
    selected: number;
    table(): StatusTable;
    metricsLine(t: StatusTable): string;
  };
  const press = (char: string) => priv.handleKey({ type: 'char', char });

  // Select T02 and queue the pause there; the metrics bar names the target.
  priv.selected = 1;
  press('P');
  assert.equal(ctx.pauseAt, 'T02');
  assert.match(stripAnsi(priv.metricsLine(priv.table())), /pause@T02/);
  // Move off the target so its highlight (not the selection inverter) is visible.
  priv.selected = 2;
  const row = app.renderLines(100, 20).find((l) => stripAnsi(l).startsWith('T02'));
  assert.ok(row && row.startsWith('\x1b[33m'), 'the pause-target row is highlighted');

  // Pressing P again on the target clears it.
  priv.selected = 1;
  press('P');
  assert.equal(ctx.pauseAt, undefined);
  assert.doesNotMatch(stripAnsi(priv.metricsLine(priv.table())), /pause@T02/);

  // A done task cannot be a target: P warns instead of queueing.
  priv.selected = 0;
  press('P');
  assert.equal(ctx.pauseAt, undefined, 'no target is queued for a done task');
  assert.match(stripAnsi(app.renderLines(100, 20).join('\n')), /T01 is done; it will not run again/);
});

test('TuiApp: the current task row is forest green while running and red when halted on failure', () => {
  const GREEN = '\x1b[97;48;2;34;139;34m';
  const RED = '\x1b[97;48;2;139;0;0m';
  const tasks = [task('T01', 1), task('T02', 2)];
  const state: State = {
    version: 1,
    tasks: {
      T01: { ...newTaskState('t1'), status: 'running', attempts: 1, durationS: 5, started: new Date().toISOString() },
      // A failure left over from an earlier run: T01 is the one in flight, so T02 must stay plain.
      T02: { ...newTaskState('t2'), status: 'failed', attempts: 1, durationS: 5, summary: 'boom' },
    },
  };
  const running = new TuiApp(makeCtx(tasks, state), new AnsiTerminal(() => {})).renderLines(100, 20);
  assert.ok(running.find((l) => stripAnsi(l).startsWith('T01'))?.startsWith(GREEN), 'the running task row is forest green');
  assert.ok(!running.find((l) => stripAnsi(l).startsWith('T02'))?.startsWith(RED), 'a stale failure that is not current stays plain');

  // The run halts on T02 after it fails: now T02 is the current task and its row turns red.
  const halted: State = {
    version: 1,
    halted: { at: new Date().toISOString(), taskId: 'T02', category: 'fatal', reason: 'boom' },
    tasks: {
      T01: { ...newTaskState('t1'), status: 'done', attempts: 1, durationS: 5, finished: new Date().toISOString() },
      T02: { ...newTaskState('t2'), status: 'failed', attempts: 1, durationS: 5, summary: 'boom' },
    },
  };
  const lines = new TuiApp(makeCtx(tasks, halted), new AnsiTerminal(() => {})).renderLines(100, 20);
  assert.ok(lines.find((l) => stripAnsi(l).startsWith('T02'))?.startsWith(RED), 'the failed current task row is red');
});

test('TuiApp: mouse wheel, tilt-wheel, middle-drag and clicks drive the panels', () => {
  const tasks = [task('T01', 1), task('T02', 2)];
  const term = new AnsiTerminal(() => {});
  const app = new TuiApp(makeCtx(tasks, { version: 1, tasks: {} }), term);
  const priv = app as unknown as {
    handleKey(k: Key): void;
    selected: number;
    focus: string;
    logPanel: { hOffset: number; vOffset: number; follow: boolean };
    focusMaxWidth(): number;
    panelGeometry(): { statusTop: number; statusHeight: number; logTop: number; logHeight: number };
  };
  const mouse = (button: MouseButton, x: number, y: number, extra: Partial<MouseKey> = {}): Key =>
    ({ type: 'mouse', button, x, y, motion: false, release: false, ...extra });
  const cols = term.size().cols;
  const g = priv.panelGeometry();

  // Left click on the second status body row selects T02; a click in the output pane focuses it.
  priv.handleKey(mouse('left', 1, g.statusTop + 4));
  assert.equal(priv.selected, 1);
  assert.equal(priv.focus, 'status');
  priv.handleKey(mouse('left', 1, g.logTop + 1));
  assert.equal(priv.focus, 'log');

  // Long lines give the output pane plenty to pan: tilt-wheel pans, middle-drag pans further.
  for (let i = 0; i < 100; i++) app.pushOutput(`line-${i}-${'x'.repeat(cols * 2)}\n`);
  assert.ok(priv.focusMaxWidth() > cols);
  priv.handleKey(mouse('wheel-right', 1, g.logTop + 1));
  const panned = priv.logPanel.hOffset;
  assert.ok(panned > 0, 'tilt-wheel pans right');
  priv.handleKey(mouse('middle', 40, g.logTop + 1));
  priv.handleKey(mouse('middle', 60, g.logTop + 1, { motion: true }));
  assert.equal(priv.logPanel.hOffset, panned + 20, 'middle-drag pans by the column delta');

  // Wheel up pauses tailing; right-click toggles follow back on.
  priv.logPanel.follow = true;
  priv.handleKey(mouse('wheel-up', 1, g.logTop + 1));
  assert.equal(priv.logPanel.follow, false, 'wheel up pauses tailing');
  priv.handleKey(mouse('right', 1, g.logTop + 1));
  assert.equal(priv.logPanel.follow, true, 'right-click toggles follow back on');
});

test('TuiApp sanitizes the live stream so every frame line is exactly cols wide', () => {
  const app = new TuiApp(makeCtx([task('T01', 1)], { version: 1, tasks: {} }), new AnsiTerminal(() => {}));
  app.pushOutput('hello\tworld\r\nsecond\x07 line\n');
  const lines = app.renderLines(60, 12);
  assert.equal(lines.length, 12);
  for (const l of lines) assert.equal(displayWidth(l), 60);
  const text = stripAnsi(lines.join('\n'));
  assert.match(text, /hello world/);
  assert.doesNotMatch(text, /[\t\x07\r]/);
});

test('TuiApp keeps the key-hints row and shows a toast on the metrics row instead', () => {
  const tasks = [task('T01', 1)];
  const state: State = { version: 1, tasks: { T01: { ...newTaskState('t1'), status: 'running', attempts: 1, durationS: 5, started: new Date().toISOString() } } };
  const app = new TuiApp(makeCtx(tasks, state), new AnsiTerminal(() => {}));
  app.toast('T01 → done');
  const lines = app.renderLines(80, 20);
  const hints = stripAnsi(lines[lines.length - 1]);
  const metrics = stripAnsi(lines[lines.length - 2]);
  assert.match(hints, /q quit/, 'the key-hints row survives a toast');
  assert.match(metrics, /T01 → done/, 'the toast takes the metrics row');
  assert.doesNotMatch(metrics, /pipeline/, 'metrics is hidden only while the toast is active');
});

test('TuiApp tails the live output and honours the panel split', () => {
  const app = new TuiApp(makeCtx([task('T01', 1)], { version: 1, tasks: {} }), new AnsiTerminal(() => {}));
  for (let i = 0; i < 40; i++) app.pushOutput(`line-${i}\n`);
  const both = stripAnsi(app.renderLines(80, 20).join('\n'));
  assert.match(both, /line-39/);
  assert.match(both, /line-32/);
  assert.doesNotMatch(both, /line-31\b/);
});

test('runWithTui enters the alternate screen, captures the run stream, and restores stdout', async () => {
  const written: string[] = [];
  const realWrite = process.stdout.write;
  const spy = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const setRawMode = (process.stdin as { setRawMode?: unknown }).setRawMode;

  process.stdout.write = spy;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  (process.stdin as { setRawMode?: unknown }).setRawMode = () => {};

  try {
    const ctx = makeCtx([task('T01', 1)], { version: 1, tasks: {} });
    const code = await runWithTui(ctx, async () => {
      process.stdout.write('hello from the run\n');
      return 0;
    }, { enabled: true });

    assert.equal(code, 0);
    const all = written.join('');
    assert.ok(all.includes('\x1b[?1049h'), 'enters the alternate screen');
    assert.ok(all.includes('\x1b[?1049l'), 'leaves the alternate screen');
    assert.ok(all.includes('hello from the run'), 'replays captured output on exit');
    assert.equal(process.stdout.write, spy, 'stdout is restored to what it was before the call');
  } finally {
    process.stdout.write = realWrite;
    if (stdoutDesc) Object.defineProperty(process.stdout, 'isTTY', stdoutDesc); else delete (process.stdout as { isTTY?: unknown }).isTTY;
    if (stdinDesc) Object.defineProperty(process.stdin, 'isTTY', stdinDesc); else delete (process.stdin as { isTTY?: unknown }).isTTY;
    if (setRawMode === undefined) delete (process.stdin as { setRawMode?: unknown }).setRawMode;
    else (process.stdin as { setRawMode?: unknown }).setRawMode = setRawMode;
  }
});

test('TuiApp: b asks to split the selected task, refuses finished ones, and stops a running session', () => {
  const tasks = [task('T01', 1), task('T02', 2), task('T03', 3)];
  const state: State = {
    version: 1,
    tasks: {
      T01: { ...newTaskState('t1'), status: 'done', attempts: 1, durationS: 10 },
      T02: { ...newTaskState('t2'), status: 'running', attempts: 1, started: new Date().toISOString() },
      T03: { ...newTaskState('t3'), status: 'failed', attempts: 1 },
    },
  };
  const ctx = makeCtx(tasks, state);
  let killed = 0;
  ctx.active = { kill: () => { killed += 1; } } as unknown as RunContext['active'];
  const app = new TuiApp(ctx, new AnsiTerminal(() => {}));
  const priv = app as unknown as {
    handleKey(k: Key): void;
    handleDialogKey(k: Key): void;
    selected: number;
    dialog?: { confirm(): void };
  };
  const press = (char: string) => priv.handleKey({ type: 'char', char });

  // A finished task cannot be split: a toast, no dialog.
  priv.selected = 0;
  press('b');
  assert.equal(priv.dialog, undefined);
  assert.match(stripAnsi(app.renderLines(100, 20).join('\n')), /T01 is done; nothing to split/);

  // A failed task: confirm queues the split and does not touch a session.
  priv.selected = 2;
  press('b');
  assert.ok(priv.dialog, 'a confirmation dialog opens');
  priv.handleDialogKey({ type: 'char', char: 'y' });
  assert.deepEqual(ctx.splitRequest, { id: 'T03' });
  assert.equal(killed, 0);

  // A second split while one is queued is refused until the first is handled.
  priv.selected = 1;
  press('b');
  assert.equal(priv.dialog, undefined);
  assert.match(stripAnsi(app.renderLines(100, 20).join('\n')), /a split of T03 is already queued/);
  delete ctx.splitRequest;

  // A running task: confirming stops the session first, then queues the split.
  priv.selected = 1;
  press('b');
  priv.handleDialogKey({ type: 'char', char: 'y' });
  assert.deepEqual(ctx.splitRequest, { id: 'T02' });
  assert.equal(killed, 1, 'the running session is interrupted before the split');
});

test('TuiApp: onPlanChanged drops caches and re-clamps the selection after a split', () => {
  const tasks = [task('T01', 1), task('T02', 2)];
  const state: State = { version: 1, tasks: { T01: { ...newTaskState('t1'), status: 'done' } } };
  const ctx = makeCtx(tasks, state);
  const app = new TuiApp(ctx, new AnsiTerminal(() => {}));
  const priv = app as unknown as { selected: number; table(): unknown };
  priv.selected = 1;
  assert.ok(priv.table());
  // The split removed the selected task and added two subtasks.
  ctx.tasks = [task('T01', 1), { ...task('T02a', 2), suffix: 'a' }, { ...task('T02b', 2), suffix: 'b' }];
  app.onPlanChanged();
  assert.equal(priv.selected, 1);
  assert.equal(app.renderLines(80, 20).length, 20);
  assert.match(stripAnsi(app.renderLines(80, 20).join('\n')), /T02a/);
});

test('runWithResume stops the run, splits the task and resumes on the subtasks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-tui-split-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# Roadmap\n\n- [ ] T01 — One\n- [~] T02 — Big → [tasks/02-big.md](tasks/02-big.md) ⟵ failed\n');
  writeFileSync(join(paths.tasksDir, '02-big.md'), '# T02 — Big\n\n## Goal\ntoo big\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  const fixtures = join(dir, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  const newRoadmap = '# Roadmap\n\n- [ ] T01 — One\n- [ ] T02a — Schema → [tasks/02a-schema.md](tasks/02a-schema.md)\n- [ ] T02b — API → [tasks/02b-api.md](tasks/02b-api.md)\n';
  writeFileSync(join(fixtures, 'split-T02.jsonl'), [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'fake_rm', path: 'docs/tasks/02-big.md' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/tasks/02a-schema.md', content: '# T02a — Schema\n' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/tasks/02b-api.md', content: '# T02b — API\n' }),
    JSON.stringify({ type: 'fake_write', path: 'docs/ROADMAP.md', content: newRoadmap }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'SYMPHONY_RESULT\nstatus: done\nsummary: T02 → T02a, T02b\nEND_SYMPHONY_RESULT' }),
  ].join('\n') + '\n');
  process.env.SYMPHONY_FAKE_FIXTURES = fixtures;

  const log: Logger = { info() {}, warn() {}, error() {}, plain() {}, banner() {} };
  const loaded = loadProject(paths, log);
  const flags: RunFlags = { retry: false, continueOnFailure: false, dryRun: false, clearHalt: false };
  const ctx: RunContext = {
    paths, config: { ...DEFAULTS, provider: 'fake' }, cli: {}, flags, log,
    roadmap: loaded.roadmap, tasks: loaded.tasks, state: loaded.state, interrupted: false, abort: new AbortController(),
  };
  const reloaded: string[] = [];
  try {
    let calls = 0;
    const code = await runWithResume(ctx, async () => {
      calls += 1;
      if (calls === 1) { ctx.splitRequest = { id: 'T02' }; return 0; }
      return 0;
    }, {
      awaitHaltAction: async () => 'quit',
      quitRequested: () => false,
      onSplitStart: () => {},
      onSplitFailed: () => {},
      onPlanReloaded: (parentId, childIds) => reloaded.push(`${parentId} → ${childIds.join(', ')}`),
    });

    assert.equal(code, 0);
    assert.equal(calls, 2, 'the run resumes after the split');
    assert.deepEqual(ctx.tasks.map((t) => t.id), ['T01', 'T02a', 'T02b']);
    assert.match(readFileSync(paths.roadmap, 'utf8'), /- \[ \] T02a — Schema/);
    assert.equal(ctx.state.tasks.T02, undefined, 'the parent state row was pruned');
    assert.deepEqual(reloaded, ['T02 → T02a, T02b'], 'the view is told about the new subtasks');
  } finally {
    delete process.env.SYMPHONY_FAKE_FIXTURES;
  }
});

test('runWithResume lets the view clear a halt (with --retry semantics) and retry', async () => {
  const tasks = [task('T01', 1)];
  const state: State = { version: 1, tasks: { T01: { ...newTaskState('t1'), status: 'failed' } } };
  state.halted = { at: 'x', taskId: 'T01', category: 'attempts', reason: 'failed 3 times' };
  const ctx = makeCtx(tasks, state);
  let calls = 0;
  const code = await runWithResume(ctx, async () => {
    calls += 1;
    if (calls === 1) return 3;
    assert.equal(ctx.state.halted, undefined, 'the halt is cleared before the retry');
    assert.equal(ctx.flags.retry, true, 'an attempts halt retries the task');
    assert.deepEqual(ctx.flags.only, ['T01']);
    return 0;
  }, {
    awaitHaltAction: async () => 'clear',
    quitRequested: () => false,
    onSplitStart: () => {},
    onSplitFailed: () => {},
    onPlanReloaded: () => {},
  });
  assert.equal(code, 0);
  assert.equal(calls, 2);
});

test('AnsiTerminal turns autowrap off while drawing and always repaints the bottom bar', () => {
  const out: string[] = [];
  const term = new AnsiTerminal((s) => out.push(s));
  term.enter();
  assert.ok(out.join('').includes('\x1b[?7l'), 'autowrap disabled on entry');
  assert.ok(out.join('').includes('\x1b[?1006h'), 'SGR mouse reporting enabled on entry');

  const frame = ['a', 'b', 'c', 'd', 'e'];
  term.draw(frame);          // first frame primes prev
  out.length = 0;
  term.draw(frame);          // second, identical frame
  const second = out.join('');
  assert.ok(!second.includes('\x1b[3;1H'), 'an unchanged row above the bar is skipped');
  assert.ok(second.includes('\x1b[4;1H'), 'the last-but-one row is always repainted');
  assert.ok(second.includes('\x1b[5;1H'), 'the bottom row is always repainted');

  out.length = 0;
  term.leave();
  assert.ok(out.join('').includes('\x1b[?7h'), 'autowrap restored on leave');
  assert.ok(out.join('').includes('\x1b[?1006l'), 'mouse reporting restored on leave');
});
