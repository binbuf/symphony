import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
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
