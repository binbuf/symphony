import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import type { RunContext } from '../src/runner.js';
import { newTaskState, type State } from '../src/state.js';
import { buildStatusTable } from '../src/status.js';
import type { Task } from '../src/tasks.js';
import { TuiApp } from '../src/tui/app.js';
import { runWithTui } from '../src/tui/index.js';
import { KeyParser } from '../src/tui/keys.js';
import { AnsiTerminal } from '../src/tui/terminal.js';
import { displayWidth, fit, padTo, sliceColumns, splice, stripAnsi, wrapText } from '../src/tui/text.js';

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
});

test('text: wrapText wraps on spaces, hard-slices long words, and ellipsizes the overflow', () => {
  assert.deepEqual(wrapText('one two three four', 7, 2).map((s) => s.trimEnd()), ['one two', 'three…']);
  assert.deepEqual(wrapText('short', 10, 2).map((s) => s.trimEnd()), ['short']);
  assert.deepEqual(wrapText('abcdefghij', 4, 3).map((s) => s.trimEnd()), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapText('   ', 5, 2), []);
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
      T02: { ...newTaskState('t2'), status: 'running', attempts: 1, durationS: 30, started: new Date().toISOString(), provider: 'opencode', model: 'z-ai/glm-5.3' },
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
  // The watch strip is the first pane; the status table sits directly below it.
  assert.match(stripAnsi(lines[0]), /Pipeline watch/);
  assert.match(stripAnsi(lines[3]), /Status/);

  ctx.watch = { status: 'ready', enabled: true, intervalMin: 5, provider: 'opencode', model: 'x', summary: 'On track: T01 is running normally.', updatedAt: new Date().toISOString(), checks: 2 };
  const ready = stripAnsi(app.renderLines(100, 24).join('\n'));
  assert.match(ready, /On track: T01 is running normally\./);
  assert.match(ready, /2 updates/);
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
