import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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
  lock: string;
  config: string;
}

/**
 * Project root resolution:
 * 1. --root override.
 * 2. Installed layout: this code lives in <root>/.symphony/dist/… → walk up to the `.symphony` dir.
 * 3. Development: walk up from cwd to the first dir containing `.docs` or `.git`.
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
    if (existsSync(join(cwd, '.docs')) || existsSync(join(cwd, '.git'))) return cwd;
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return process.cwd();
}

export function resolvePaths(rootOverride?: string): Paths {
  const root = resolveRoot(rootOverride);
  const docs = join(root, '.docs');
  const symphony = join(root, '.symphony');
  return {
    root,
    docs,
    roadmap: join(docs, 'ROADMAP.md'),
    progress: join(docs, 'PROGRESS.md'),
    tasksDir: join(docs, 'tasks'),
    designDir: join(docs, 'design'),
    adrDir: join(docs, 'design', 'adr'),
    symphony,
    state: join(symphony, 'state.json'),
    runs: join(symphony, 'runs'),
    log: join(symphony, 'symphony.log'),
    stop: join(symphony, 'STOP'),
    lock: join(symphony, 'lock'),
    config: join(symphony, 'symphony.config.json'),
  };
}
