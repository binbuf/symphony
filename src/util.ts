import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { TokenUsage } from './providers/types.js';

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Local wall-clock time-of-day: `14:08:10`. Used to timestamp stdout and log entries. */
export function fmtTime(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Filesystem-friendly local timestamp: 20260917T231530 */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Collapse whitespace and truncate to `max` characters. */
export function squash(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

/**
 * Collapse whitespace and, when too long, truncate from the *front* so the tail survives. Used for
 * values like `provider/model#variant` where the end (the specific model) matters more than the
 * leading namespace.
 */
export function squashTail(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `…${t.slice(t.length - Math.max(0, max - 1))}` : t;
}

/** Truncate but keep line breaks (for log files). */
export function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

/** Cap UTF-8 bytes without splitting a code point; an omission notice shares the budget. */
export function capUtf8(text: string, maxBytes: number, notice = '', tail = false): string {
  const buf = Buffer.from(text, 'utf8');
  const limit = Math.max(0, Math.floor(maxBytes));
  if (buf.length <= limit) return text;
  const prefix = (s: string, bytes: number): string => {
    const b = Buffer.from(s, 'utf8');
    let end = Math.min(bytes, b.length);
    while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
    return b.subarray(0, end).toString('utf8');
  };
  const marker = prefix(notice, limit);
  const budget = limit - Buffer.byteLength(marker, 'utf8');
  if (!tail) return `${prefix(text, budget)}${marker}`;
  let start = buf.length - budget;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return `${marker}${buf.subarray(start).toString('utf8')}`;
}

/**
 * Truncate a long document to `max` while keeping both ends: for a task file the `## Goal` and
 * acceptance criteria sit at the top and the hand-off notes at the bottom, and a decision model
 * needs both. Below `max` the text is returned unchanged.
 */
export function headAndTail(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const separator = '\n…\n';
  if (max <= separator.length) return t.slice(0, Math.max(0, max));
  const budget = Math.max(0, max - separator.length);
  const head = Math.ceil(budget * 0.6);
  return `${t.slice(0, head)}${separator}${t.slice(t.length - (budget - head))}`;
}

/**
 * Byte-budgeted head-and-tail truncation. Like `headAndTail`, but the cap is measured in UTF-8
 * bytes (not UTF-16 code units) and neither boundary is allowed to split a code point. Used where the
 * input is an arbitrary diff whose cap must hold against the real byte length.
 */
export function headAndTailBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  const limit = Math.max(0, Math.floor(maxBytes));
  if (buf.length <= limit) return s;
  const sep = Buffer.from('\n…\n', 'utf8');
  if (limit <= sep.length) return buf.subarray(0, limit).toString('utf8');
  const budget = limit - sep.length;
  const headBytes = Math.ceil(budget * 0.6);
  const tailBytes = budget - headBytes;
  let headEnd = Math.min(headBytes, buf.length);
  while (headEnd > 0 && (buf[headEnd] & 0xc0) === 0x80) headEnd--;
  let tailStart = buf.length - tailBytes;
  while (tailStart < buf.length && (buf[tailStart] & 0xc0) === 0x80) tailStart++;
  return `${buf.subarray(0, headEnd).toString('utf8')}${sep.toString('utf8')}${buf.subarray(tailStart).toString('utf8')}`;
}

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
export function atomicWriteSync(path: string, text: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Abortable sleep. Resolves early (not rejects) when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function fmtDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '-';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  return m < 90 ? `${m} min` : `${(seconds / 3600).toFixed(1)} h`;
}

export function fmtCost(usd?: number): string {
  return usd === undefined || usd === null || !Number.isFinite(usd) ? '-' : `$${usd.toFixed(2)}`;
}

/** A token count as `820` / `12.3k` / `1.2M`. */
export function fmtCount(n?: number): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '-';
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(Math.abs(n) < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * A compact usage line (`12.3k in · 4.0k cached · 1.2k out`). Cached and reasoning counts are
 * omitted when zero so a session that simply reports `0` stays terse; undefined when nothing at all
 * was reported.
 */
export function fmtUsage(u?: TokenUsage): string | undefined {
  if (!u) return undefined;
  const parts = [
    u.inputTokens !== undefined ? `${fmtCount(u.inputTokens)} in` : '',
    u.cachedInputTokens !== undefined && u.cachedInputTokens > 0 ? `${fmtCount(u.cachedInputTokens)} cached` : '',
    u.outputTokens !== undefined ? `${fmtCount(u.outputTokens)} out` : '',
    u.reasoningTokens !== undefined && u.reasoningTokens > 0 ? `${fmtCount(u.reasoningTokens)} reasoning` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * How stored timestamps are rendered: the machine's local zone (default), UTC, or a fixed offset
 * from UTC in minutes (east positive, so `+05:30` is 330 and `-08:00` is -480).
 */
export type TimeZone = 'local' | 'utc' | number;

/**
 * Parse a configured `timeZone` value into a {@link TimeZone}: `"local"` (the default), `"utc"`,
 * or a fixed offset such as `"+05:30"`, `"-8"` or `"+0530"`. Returns undefined for anything else.
 */
export function parseTimeZone(value: unknown): TimeZone | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim().toLowerCase();
  if (s === 'local') return 'local';
  if (s === 'utc' || s === 'z') return 'utc';
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(s);
  if (!m) return undefined;
  const hours = Number(m[2]);
  const minutes = Number(m[3] ?? '0');
  if (hours > 23 || minutes > 59) return undefined;
  return (m[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `+05:30` / `-04:00`, the suffix a fixed-offset stamp carries. */
function offsetLabel(minutes: number): string {
  const a = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}

/**
 * A stored ISO timestamp as a readable datetime stamp. Defaults to the machine's local zone
 * (`2026-09-17 19:15:30-04:00`); pass `"utc"` for the old `2026-09-17 23:15:30Z`, or a fixed
 * offset in minutes for another zone.
 */
export function fmtDateTime(iso?: string, tz: TimeZone = 'local'): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  if (tz === 'utc') return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
  const minutes = tz === 'local' ? -d.getTimezoneOffset() : tz;
  // Local uses the Date's own local getters (DST-aware); a fixed offset shifts the instant and reads UTC.
  const shifted = tz === 'local' ? d : new Date(d.getTime() + minutes * 60000);
  const date = tz === 'local'
    ? `${shifted.getFullYear()}-${p2(shifted.getMonth() + 1)}-${p2(shifted.getDate())}`
    : `${shifted.getUTCFullYear()}-${p2(shifted.getUTCMonth() + 1)}-${p2(shifted.getUTCDate())}`;
  const time = tz === 'local'
    ? `${p2(shifted.getHours())}:${p2(shifted.getMinutes())}:${p2(shifted.getSeconds())}`
    : `${p2(shifted.getUTCHours())}:${p2(shifted.getUTCMinutes())}:${p2(shifted.getUTCSeconds())}`;
  return `${date} ${time}${offsetLabel(minutes)}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task';
}

export function fileExists(p: string): boolean {
  return existsSync(p);
}

/**
 * Resolve a command to the absolute path that PATH lookup would use, so preflight can show which
 * binary actually runs when several are installed (e.g. two OpenCode installs). Only bare command
 * names are searched (use `resolveBinary` for paths, which also expands `~` and relative paths); a
 * value that looks like a path is returned as-is when it exists. Returns undefined when nothing
 * matches; this is best-effort only and never decides whether a command can run.
 */
export function resolveExecutable(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin) ? bin : undefined;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const exts = process.platform === 'win32'
    ? (env.PATHEXT ?? env.PathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Whether a configured binary is a path the user chose (absolute, `~`, or containing a separator). */
export function isPathLike(bin: string): boolean {
  return bin.startsWith('~') || isAbsolute(bin) || bin.includes('/') || bin.includes('\\');
}

/** Expand a leading `~` or `~/` to the user's home directory. Other values pass through. */
export function expandHome(p: string): string {
  if (p !== '~' && !p.startsWith('~/') && !p.startsWith('~\\')) return p;
  return p === '~' ? homedir() : join(homedir(), p.slice(2));
}

/**
 * The binary a configured `providers.<name>.bin` names: an explicit path is expanded (`~`) and made
 * absolute against `cwd`, so the user's chosen install wins; a bare command name is looked up on
 * PATH. Falls back to the configured value when a bare name is not found, so the spawn error still
 * names what was asked for.
 */
export function resolveBinary(bin: string, opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): string {
  if (!isPathLike(bin)) return resolveExecutable(bin, opts.env) ?? bin;
  const expanded = expandHome(bin);
  return isAbsolute(expanded) ? expanded : resolve(opts.cwd ?? process.cwd(), expanded);
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}

export function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

export function bool(x: unknown): boolean | undefined {
  return typeof x === 'boolean' ? x : undefined;
}

/** Error class for expected, user-facing failures (usage, config, preflight). */
export class UsageError extends Error {
  constructor(message: string, readonly exitCode = 4) {
    super(message);
    this.name = 'UsageError';
  }
}
