import type { Key } from './keys.js';
import { KeyParser } from './keys.js';

export interface TermSize { cols: number; rows: number }

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
/** Disable/enable the terminal's own line wrap: we pre-wrap, so an over-wide line must clip, not scroll the frame. */
const WRAP_OFF = '\x1b[?7l';
const WRAP_ON = '\x1b[?7h';
const CLEAR = '\x1b[2J\x1b[H';
const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';

/**
 * Thin ANSI terminal wrapper: alternate screen, raw mode, resize/key events, and a line-diffing
 * `draw`. It never decides what to render — the app hands it full-width lines and only changed rows
 * are rewritten, which keeps a live log tail from flickering.
 */
export class AnsiTerminal {
  private prev: string[] = [];
  private prevCols = 0;
  private readonly parser = new KeyParser();
  private keyListener?: (chunk: string) => void;
  private resizeListener?: () => void;

  constructor(private readonly out: (s: string) => void) {}

  size(): TermSize {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    return { cols: Math.max(20, cols), rows: Math.max(6, rows) };
  }

  write(s: string): void {
    this.out(s);
  }

  enter(): void {
    this.out(`${ALT_ON}${WRAP_OFF}${HIDE_CURSOR}${CLEAR}`);
    if (process.stdin.isTTY) {
      process.stdin.setEncoding('utf8');
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
  }

  leave(): void {
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* already gone */ }
      process.stdin.pause();
    }
    this.out(`${SHOW_CURSOR}${WRAP_ON}${ALT_OFF}`);
    this.prev = [];
  }

  onKey(cb: (k: Key) => void): void {
    this.keyListener = (chunk: string) => {
      for (const k of this.parser.feed(chunk)) cb(k);
    };
    process.stdin.on('data', this.keyListener);
  }

  onResize(cb: () => void): void {
    this.resizeListener = cb;
    process.stdout.on('resize', this.resizeListener);
  }

  dispose(): void {
    if (this.keyListener) process.stdin.off('data', this.keyListener);
    if (this.resizeListener) process.stdout.off('resize', this.resizeListener);
    this.keyListener = undefined;
    this.resizeListener = undefined;
  }

  /**
 * Rewrite only the rows that changed since the last frame. The bottom two rows (the metrics + key
 * bar) are always repainted: a transient terminal glitch must never be able to leave the toolbar
 * blank, since an unchanged row would otherwise never be rewritten.
 */
  draw(lines: string[]): void {
    const { cols } = this.size();
    const full = cols !== this.prevCols || lines.length !== this.prev.length;
    if (full) {
      this.out(CLEAR);
      this.prev = [];
      this.prevCols = cols;
    }
    let buf = SYNC_ON;
    for (let i = 0; i < lines.length; i++) {
      const alwaysRepaint = i >= lines.length - 2;
      if (!full && !alwaysRepaint && lines[i] === this.prev[i]) continue;
      buf += `\x1b[${i + 1};1H\x1b[2K${lines[i]}`;
    }
    buf += SYNC_OFF;
    if (buf !== SYNC_ON + SYNC_OFF) this.out(buf);
    this.prev = lines.slice();
  }
}
