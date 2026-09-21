import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Every user-facing location can be overridden from symphony.config.json (`paths` section). */
export interface PathOverrides {
  /** Planning package directory. Default `docs/` (a legacy `.docs/` is honoured when present). */
  docs?: string;
  roadmap?: string;
  progress?: string;
  tasks?: string;
  design?: string;
  adr?: string;
  /** Graceful-pause sentinel. Default `.stop` in the project root. */
  stop?: string;
  state?: string;
  runs?: string;
  log?: string;
}

export interface Paths {
  root: string;
  docs: string;
  roadmap: string;
  progress: string;
  tasksDir: string;
  designDir: string;
  adrDir: string;
  symphony: string;
  state: string;
  runs: string;
  log: string;
  stop: string;
  /** Legacy sentinel (`.symphony/STOP`) still honoured for backwards compatibility. */
  stopLegacy: string;
  lock: string;
  config: string;
}

/** Docs dir used when none is configured: `docs/`, unless a legacy `.docs/` already exists. */
export function defaultDocsDir(root: string): string {
  return existsSync(join(root, '.docs')) && !existsSync(join(root, 'docs')) ? '.docs' : 'docs';
}

const abs = (root: string, p: string): string => (isAbsolute(p) ? p : resolve(root, p));

/**
 * Project root resolution:
 * 1. --root override.
 * 2. Installed layout: this code lives in <root>/.symphony/dist/… → walk up to the `.symphony` dir.
 * 3. Development: walk up from cwd to the first dir containing `docs`, `.docs`, or `.git`.
 * 4. cwd.
 */
export function resolveRoot(rootOverride?: string): string {
  if (rootOverride) return resolve(rootOverride);
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    if (basename(dir) === '.symphony') return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  let cwd = process.cwd();
  for (;;) {
    if (existsSync(join(cwd, 'docs')) || existsSync(join(cwd, '.docs')) || existsSync(join(cwd, '.git'))) return cwd;
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return process.cwd();
}

export function resolvePaths(rootOverride?: string, overrides: PathOverrides = {}): Paths {
  const root = resolveRoot(rootOverride);
  const symphony = join(root, '.symphony');
  const docs = abs(root, overrides.docs ?? defaultDocsDir(root));
  const tasksDir = abs(root, overrides.tasks ?? join(docs, 'tasks'));
  const designDir = abs(root, overrides.design ?? join(docs, 'design'));
  return {
    root,
    docs,
    roadmap: abs(root, overrides.roadmap ?? join(docs, 'ROADMAP.md')),
    progress: abs(root, overrides.progress ?? join(docs, 'PROGRESS.md')),
    tasksDir,
    designDir,
    adrDir: abs(root, overrides.adr ?? join(designDir, 'adr')),
    symphony,
    state: abs(root, overrides.state ?? join(symphony, 'state.json')),
    runs: abs(root, overrides.runs ?? join(symphony, 'runs')),
    log: abs(root, overrides.log ?? join(symphony, 'symphony.log')),
    stop: abs(root, overrides.stop ?? '.stop'),
    stopLegacy: join(symphony, 'STOP'),
    lock: join(symphony, 'lock'),
    config: join(symphony, 'symphony.config.json'),
  };
}

/** Path relative to the project root, with forward slashes, for display and prompts. */
export function rel(root: string, p: string): string {
  const r = p.startsWith(root) ? p.slice(root.length + 1) : p;
  return r.replace(/\\/g, '/');
}

/** True when either the configured stop sentinel or the legacy `.symphony/STOP` exists. */
export function stopPresent(paths: Paths): boolean {
  return existsSync(paths.stop) || existsSync(paths.stopLegacy);
}

/** The stop sentinel relative to the root, when it lives inside the project (for .gitignore). */
export function stopIgnoreEntry(paths: Paths): string | undefined {
  return paths.stop.startsWith(paths.root) ? rel(paths.root, paths.stop) : undefined;
}