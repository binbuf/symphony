import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

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

/** A stored ISO timestamp as a readable UTC datetime stamp: `2026-09-17 23:15:30Z`. */
export function fmtDateTime(iso?: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
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
 * binary actually runs when several are installed (e.g. OpenCode 1.x and 2.x). Only bare command
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

/** Error class for expected, user-facing failures (usage, config, preflight). */
export class UsageError extends Error {
  constructor(message: string, readonly exitCode = 4) {
    super(message);
    this.name = 'UsageError';
  }
}
