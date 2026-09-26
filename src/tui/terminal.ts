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
/**
 * Mouse reporting: 1000 = button press/release, 1002 = button-event tracking (drag motion while a
 * button is held), 1006 = SGR extended coordinates (so x/y can exceed 223). Wheel and horizontal
 * tilt-wheel events arrive as button codes, decoded in keys.ts.
 */
const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1006l';
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
  private entered = false;
  private left = false;

  constructor(private readonly out: (s: string) => void) {}

  size(): TermSize {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    return { cols: Math.max(20, cols), rows: Math.max(6, rows) };
  }

  /** Write to the terminal, swallowing an EPIPE/closed-stdout error so a dead pipe can't crash a frame. */
  write(s: string): void {
    try { this.out(s); } catch { /* terminal gone; nothing to restore */ }
  }

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.left = false;
    this.write(`${ALT_ON}${WRAP_OFF}${HIDE_CURSOR}${MOUSE_ON}${CLEAR}`);
    this.setRaw(true);
  }

  /**
   * Restore the terminal: show the cursor, re-enable autowrap, turn mouse reporting off and leave the
   * alternate screen. Idempotent and throw-safe, because it is the last line of defence and may run
   * from a signal, an `exit` handler, or both.
   */
  leave(): void {
    if (this.left) return;
    this.left = true;
    this.setRaw(false);
    this.write(`${SHOW_CURSOR}${WRAP_ON}${MOUSE_OFF}${ALT_OFF}`);
    this.prev = [];
  }

  /** Toggle raw mode defensively; a terminal that is already torn down must not throw. */
  private setRaw(on: boolean): void {
    if (!process.stdin.isTTY) return;
    try {
      if (on) {
        process.stdin.setEncoding('utf8');
        process.stdin.setRawMode(true);
        process.stdin.resume();
      } else {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    } catch { /* stream already closed */ }
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
      this.write(CLEAR);
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
    if (buf !== SYNC_ON + SYNC_OFF) this.write(buf);
    this.prev = lines.slice();
  }
}
