import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { rel, type Paths } from './paths.js';
import { formatTaskId, type Bullet, type Roadmap } from './roadmap.js';

export interface Task {
  id: string;
  num: number;
  /** Split suffix ('' for a base task, `a`/`b`/… for a subtask); absent on hand-built task lists. */
  suffix?: string;
  title: string;
  phase: string;
  /** Position in ROADMAP.md (0-based). Execution order. */
  order: number;
  taskFile?: string;
  taskFileRel?: string;
  /** Front matter from the task file (provider, model, timeoutMin). */
  meta: Record<string, string>;
}

/** `01-slug.md`, `10a-slug.md`, `T10a1-slug.md` — the id's numeric base plus optional split suffix. */
export const TASK_FILE_RE = /^T?(\d{1,3})([a-z]\d*)?(?:[-_. ].*)?\.md$/i;
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontMatter(md: string): { meta: Record<string, string>; body: string } {
  const m = FRONT_MATTER_RE.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: md.slice(m[0].length) };
}

function resolveLink(paths: Paths, link: string): string | undefined {
  const candidates = isAbsolute(link)
    ? [link]
    : [resolve(paths.docs, link), resolve(paths.root, link), resolve(paths.tasksDir, link)];
  return candidates.find((c) => existsSync(c));
}

/** Join roadmap bullets with .docs/tasks/*.md. Link wins; the id's filename prefix is the fallback. */
export function discoverTasks(paths: Paths, roadmap: Roadmap): { tasks: Task[]; warnings: string[] } {
  const warnings: string[] = [];
  const byId = new Map<string, string>();
  if (existsSync(paths.tasksDir)) {
    for (const name of readdirSync(paths.tasksDir).sort()) {
      const m = TASK_FILE_RE.exec(name);
      if (!m) continue;
      const id = formatTaskId(Number(m[1]), (m[2] ?? '').toLowerCase());
      const prev = byId.get(id);
      if (prev) throw new Error(`${rel(paths.root, paths.tasksDir)}: ${prev} and ${name} both claim task ${id}. One file per task.`);
      byId.set(id, name);
    }
  }

  const claimed = new Set<string>();
  const tasks: Task[] = roadmap.bullets.map((b: Bullet, order) => {
    let file: string | undefined;
    if (b.link) {
      file = resolveLink(paths, b.link);
      if (!file) warnings.push(`${b.id}: linked task file "${b.link}" not found; falling back to filename prefix`);
    }
    if (!file) {
      const name = byId.get(b.id);
      if (name) file = join(paths.tasksDir, name);
    }
    let meta: Record<string, string> = {};
    if (file) {
      claimed.add(file);
      meta = parseFrontMatter(readFileSync(file, 'utf8')).meta;
    } else {
      warnings.push(`${b.id}: no task file in ${rel(paths.root, paths.tasksDir)}/ (the roadmap bullet will be the whole spec)`);
    }
    return {
      id: b.id,
      num: b.num,
      suffix: b.suffix,
      title: b.title,
      phase: b.phase,
      order,
      taskFile: file,
      taskFileRel: file ? rel(paths.root, file) : undefined,
      meta,
    };
  });

  for (const [id, name] of byId) {
    const p = join(paths.tasksDir, name);
    if (!claimed.has(p)) warnings.push(`${rel(paths.root, p)}: task ${id} has no bullet in ROADMAP.md; it will not run`);
  }
  return { tasks, warnings };
}
