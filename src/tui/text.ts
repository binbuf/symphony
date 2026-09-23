/**
 * Terminal text helpers for the hand-rolled TUI. Everything here is pure and I/O-free so the layout
 * can be unit-tested without a real terminal. Widths are best-effort display columns: combining marks
 * count 0, East-Asian wide characters and emoji count 2, everything else counts 1.
 */

// CSI, OSC and simple two-character escape sequences.
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function isZeroWidth(cp: number): boolean {
  return (
    cp === 0 ||
    cp < 32 ||
    (cp >= 0x7f && cp < 0xa0) ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0xfeff
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Display columns one code point occupies (0, 1 or 2). */
export function charWidth(cp: number): number {
  if (isZeroWidth(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Visible display width of a string, ignoring ANSI escapes. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Pad with spaces to `width` visible columns; never truncates. */
export function padTo(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/**
 * The substring covering display columns [start, start+width). A wide character straddling either
 * boundary is replaced by a space so the result never overflows. ANSI escapes are stripped first.
 */
export function sliceColumns(s: string, start: number, width: number): string {
  const plain = stripAnsi(s);
  if (width <= 0) return '';
  let col = 0;
  let out = '';
  for (const ch of plain) {
    const w = charWidth(ch.codePointAt(0)!);
    if (w === 0) {
      if (col >= start && out) out += ch;
      continue;
    }
    const c0 = col;
    const c1 = col + w;
    col = c1;
    if (c1 <= start) continue;
    if (c0 >= start + width) break;
    if (c0 < start) {
      out += ' '.repeat(Math.min(c1, start + width) - start);
      continue;
    }
    if (c1 > start + width) {
      out += ' '.repeat(start + width - c0);
      break;
    }
    out += ch;
  }
  return out;
}

/** Fit a string to exactly `width` columns: pad when short, ellipsize when long. */
export function fit(s: string, width: number): string {
  if (width <= 0) return '';
  const w = displayWidth(s);
  if (w <= width) return padTo(s, width);
  if (width === 1) return '…';
  return `${sliceColumns(s, 0, width - 1)}…`;
}

/** Overlay `box` lines onto a full-width frame line, replacing columns [left, left+boxWidth). */
export function splice(frameLine: string, boxLine: string, left: number, cols: number): string {
  const plain = stripAnsi(frameLine);
  const boxWidth = displayWidth(boxLine);
  const before = sliceColumns(plain, 0, left);
  const after = sliceColumns(plain, left + boxWidth, Math.max(0, cols - left - boxWidth));
  return padTo(before + boxLine + after, cols);
}
