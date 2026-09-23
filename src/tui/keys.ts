/**
 * Minimal, dependency-free terminal key decoder. stdin is read as UTF-8 text; a chunk may hold
 * several keys (an arrow is the three bytes `ESC [ A`). Printable input is reported per code point.
 */

export type Key =
  | { type: 'char'; char: string }
  | { type: 'key'; name: NamedKey };

export type NamedKey =
  | 'up' | 'down' | 'left' | 'right'
  | 'pageup' | 'pagedown' | 'home' | 'end'
  | 'tab' | 'shift-tab' | 'enter' | 'escape' | 'backspace' | 'delete'
  | 'ctrl-c';

const CSI_FINAL = /[@-~]/;

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
        if (finalIdx === -1) return false; // incomplete; wait for more bytes
        const params = rest.slice(0, finalIdx);
        const final = rest[finalIdx];
        this.buf = this.buf.slice(2 + finalIdx + 1);
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
