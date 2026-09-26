/**
 * Minimal, dependency-free terminal key decoder. stdin is read as UTF-8 text; a chunk may hold
 * several keys (an arrow is the three bytes `ESC [ A`). Printable input is reported per code point.
 */

export type Key =
  | { type: 'char'; char: string }
  | { type: 'key'; name: NamedKey }
  | MouseKey;

export type NamedKey =
  | 'up' | 'down' | 'left' | 'right'
  | 'pageup' | 'pagedown' | 'home' | 'end'
  | 'tab' | 'shift-tab' | 'enter' | 'escape' | 'backspace' | 'delete'
  | 'ctrl-c';

/** A decoded SGR mouse event (`CSI < b ; x ; y M|m`), coordinates 1-based from the top-left. */
export type MouseButton =
  | 'left' | 'middle' | 'right'
  | 'wheel-up' | 'wheel-down' | 'wheel-left' | 'wheel-right'
  | 'none';

export interface MouseKey {
  type: 'mouse';
  button: MouseButton;
  x: number;
  y: number;
  /** True for a drag/motion report (a button is held). */
  motion: boolean;
  /** True for a button-release report. */
  release: boolean;
}

const CSI_FINAL = /[@-~]/;

/**
 * Upper bound on an unterminated escape sequence held between reads. A well-formed key or SGR mouse
 * report is a handful of bytes; anything longer is malformed (or a terminal we did not negotiate a
 * protocol with), so the buffer is dropped rather than allowed to grow without bound.
 */
const MAX_PENDING = 4096;

function decodeSgrMouse(params: string, final: string): MouseKey | undefined {
  const [rawCb, rawX, rawY] = params.split(';');
  const cb = Number(rawCb);
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isFinite(cb) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const motion = (cb & 32) !== 0;
  const release = final === 'm';
  const low = cb & 3;
  let button: MouseButton;
  if (cb & 64) {
    // Wheel events carry the 0x40 flag; the low bits select the axis/direction.
    button = low === 0 ? 'wheel-up' : low === 1 ? 'wheel-down' : low === 2 ? 'wheel-left' : 'wheel-right';
  } else if (release) {
    button = 'none';
  } else {
    button = low === 0 ? 'left' : low === 1 ? 'middle' : low === 2 ? 'right' : 'none';
  }
  return { type: 'mouse', button, x, y, motion, release };
}

function csiKey(params: string, final: string): NamedKey | undefined {
  const p = params.replace(/^[?>!]/, '');
  switch (final) {
    case 'A': return 'up';
    case 'B': return 'down';
    case 'C': return 'right';
    case 'D': return 'left';
    case 'H': return 'home';
    case 'F': return 'end';
    case 'Z': return 'shift-tab';
    case '~':
      if (p === '5') return 'pageup';
      if (p === '6') return 'pagedown';
      if (p === '3') return 'delete';
      if (p === '1' || p === '7') return 'home';
      if (p === '4' || p === '8') return 'end';
      return undefined;
    default:
      return undefined;
  }
}

export class KeyParser {
  private buf = '';

  feed(chunk: string): Key[] {
    this.buf += chunk;
    const out: Key[] = [];
    while (this.buf.length) {
      const consumed = this.next(out);
      if (!consumed) break;
    }
    return out;
  }

  /** True while an incomplete escape sequence is buffered (waiting for the rest of the chunk). */
  get pending(): boolean {
    return this.buf.length > 0;
  }

  private next(out: Key[]): boolean {
    const ch = this.buf[0];
    if (ch === '\x1b') {
      // Application cursor keys (SS3): ESC O A..D / H / F.
      if (this.buf[1] === 'O' && this.buf.length >= 3) {
        const name = csiKey('', this.buf[2]);
        this.buf = this.buf.slice(3);
        if (name) out.push({ type: 'key', name });
        return true;
      }
      if (this.buf[1] === '[') {
        const rest = this.buf.slice(2);
        const finalIdx = rest.search(CSI_FINAL);
        if (finalIdx === -1) {
          // Incomplete; wait for more bytes, but never hold an unbounded malformed sequence.
          if (this.buf.length > MAX_PENDING) { this.buf = ''; return true; }
          return false;
        }
        const params = rest.slice(0, finalIdx);
        const final = rest[finalIdx];
        this.buf = this.buf.slice(2 + finalIdx + 1);
        if (params.startsWith('<')) {
          const mouse = decodeSgrMouse(params.slice(1), final);
          if (mouse) out.push(mouse);
          return true;
        }
        const name = csiKey(params, final);
        if (name) out.push({ type: 'key', name });
        return true;
      }
      // A lone ESC (or an unrecognised escape): report Escape and move on.
      this.buf = this.buf.slice(1);
      out.push({ type: 'key', name: 'escape' });
      return true;
    }
    if (ch === '\x03') { this.buf = this.buf.slice(1); out.push({ type: 'key', name: 'ctrl-c' }); return true; }
    if (ch === '\t') { this.buf = this.buf.slice(1); out.push({ type: 'key', name: 'tab' }); return true; }
    if (ch === '\r' || ch === '\n') { this.buf = this.buf.slice(1); out.push({ type: 'key', name: 'enter' }); return true; }
    if (ch === '\x7f') { this.buf = this.buf.slice(1); out.push({ type: 'key', name: 'backspace' }); return true; }
    const cp = this.buf.codePointAt(0)!;
    const width = cp > 0xffff ? 2 : 1;
    if (cp < 0x20) { this.buf = this.buf.slice(width); return true; } // ignore other control chars
    const char = this.buf.slice(0, width);
    this.buf = this.buf.slice(width);
    out.push({ type: 'char', char });
    return true;
  }
}
