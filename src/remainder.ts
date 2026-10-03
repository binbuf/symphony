import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { findDuplicateTask, splitDepth, type AcceptanceItem } from './graph.js';
import { childIdsFor, insertRoadmapBulletAfter } from './roadmap.js';
import { rel, type Paths } from './paths.js';
import type { Task } from './tasks.js';
import { ensureDir, slugify } from './util.js';

/**
 * Turning a task's deferred acceptance into a real ticket.
 *
 * When a task's blocking acceptance has landed and only deferrable items remain, the harness accepts
 * the green subset and must not simply drop the remainder: it creates one child ticket (`T107a`)
 * carrying those items, placed immediately after its parent so it runs before the parent's
 * dependents. The child's items are blocking — re-tagging them deferrable would let the child
 * auto-accept an empty subset and spawn another child forever. Depth and free-id bounds are honoured;
 * when no child id is available the remainder is only recorded on the parent's state.
 */

export interface RemainderTask {
  id: string;
  title: string;
  taskFile: string;
  taskFileRel: string;
  /** Resolved task ids this remainder waits on (a named capability that maps to an existing task). */
  dependsOn: string[];
  /** Named capabilities the deferred items are gated on, recorded even when no ticket provides them. */
  gatedOn: string[];
  /** Existing dependents of the parent whose task files now depend on this remainder. */
  dependentsPatched: string[];
}

/** Resolve a named capability to an existing task, matching on the normalised title. Conservative. */
function resolveCapability(capability: string, tasks: Task[]): string | undefined {
  return findDuplicateTask({ title: capability }, tasks)?.id;
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Add `depId` to a task file's `dependsOn` front matter (creating the block when absent), so the
 * remainder is a hard prerequisite of the tasks that depended on its parent. Idempotent and
 * body-preserving.
 */
function ensureDependency(file: string, depId: string): boolean {
  const text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const fm = FRONT_MATTER_RE.exec(text);
  if (!fm) {
    writeFileSync(file, `---${eol}dependsOn: ${depId}${eol}---${eol}${eol}${text}`, 'utf8');
    return true;
  }
  const lines = fm[1].split(/\r?\n/);
  const existing = lines.findIndex((l) => /^\s*(dependsOn|depends|blockedBy|blocked-by)\s*:/i.test(l));
  if (existing === -1) {
    lines.push(`dependsOn: ${depId}`);
  } else {
    const current = lines[existing].split(':').slice(1).join(':').split(/[\s,;]+/).filter(Boolean);
    if (current.includes(depId)) return false;
    lines[existing] = `${lines[existing].split(':')[0]}: ${[...current, depId].join(', ')}`;
  }
  const rebuilt = `---${eol}${lines.join(eol)}${eol}---${eol}${eol}${text.slice(fm[0].length)}`;
  writeFileSync(file, rebuilt, 'utf8');
  return true;
}

function renderBody(id: string, title: string, parent: Task, deferred: AcceptanceItem[], gatedOn: string[], dependsOn: string[]): string {
  const frontMatter = dependsOn.length ? `---\ndependsOn: ${dependsOn.join(', ')}\n---\n\n` : '';
  const scope = deferred.map((a) => `- ${a.text}${a.capability ? ` (needs ${a.capability})` : ''}`).join('\n');
  const done = deferred.map((a) => `- [ ] ${a.text}`).join('\n');
  const gate = gatedOn.length
    ? `\nThis work was gated on: ${gatedOn.join(', ')}. Confirm the capability exists before implementing; if it still does not, record exactly what is missing in Hand-off and report blocked.\n`
    : '';
  return `${frontMatter}# ${id} — ${title}

## Goal
Finish the acceptance items that ${parent.id} landed green but deferred: its blocking criteria are met, and these optional items were dependency-gated at the time.

## Scope
${scope}
${gate}
## Done when
${done}

## Hand-off
(not started)
`;
}

/**
 * Create the remainder ticket for a deferred acceptance subset. Returns undefined when the parent
 * has no free child id or the child would exceed `ceiling.maxSplitDepth`, leaving the remainder
 * recorded on the parent's state only.
 */
export function createRemainderTask(
  paths: Paths,
  parent: Task,
  deferred: AcceptanceItem[],
  tasks: Task[],
  config: Config,
  dependents: Task[] = [],
): RemainderTask | undefined {
  if (!deferred.length) return undefined;
  const id = childIdsFor(parent.id, tasks.map((t) => t.id))[0];
  if (!id) return undefined;
  if (config.ceiling.maxSplitDepth > 0 && splitDepth(id) > config.ceiling.maxSplitDepth) return undefined;

  const gatedOn = [...new Set(deferred.map((d) => d.capability).filter((c): c is string => !!c))];
  const dependsOn = [...new Set(gatedOn.map((c) => resolveCapability(c, tasks)).filter((v): v is string => !!v && v !== id))];
  const title = `${parent.title} — remainder`;
  const suffix = id.replace(/^T\d+/, '');
  const fileName = `${String(parent.num).padStart(2, '0')}${suffix}-${slugify(title)}.md`;
  const taskFile = join(paths.tasksDir, fileName);
  ensureDir(paths.tasksDir);
  writeFileSync(taskFile, renderBody(id, title, parent, deferred, gatedOn, dependsOn), 'utf8');
  insertRoadmapBulletAfter(paths.roadmap, parent.id, id, title, `tasks/${fileName}`);
  // Any task that depended on the parent now depends on the remainder too, so the remainder is
  // ordered before them even when they appear earlier in the roadmap.
  const dependentsPatched: string[] = [];
  for (const dep of dependents) {
    if (dep.id === parent.id || dep.id === id || !dep.taskFile) continue;
    try {
      if (ensureDependency(dep.taskFile, id)) dependentsPatched.push(dep.id);
    } catch { /* a dependent we cannot read must not lose the remainder ticket */ }
  }
  return { id, title, taskFile, taskFileRel: rel(paths.root, taskFile), dependsOn, gatedOn, dependentsPatched };
}