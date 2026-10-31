import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { parseAcceptance, splitDepth } from './graph.js';
import { childIdsFor, insertRoadmapBulletAfter } from './roadmap.js';
import { rel, type Paths } from './paths.js';
import type { Task } from './tasks.js';
import { ensureDir, slugify } from './util.js';

/**
 * Deterministic decomposition. Unlike `symphony split` (one agent session rewrites the plan), this
 * takes the items already written in a task — its `## Scope` bullets, or its unchecked acceptance
 * items when it has no scope list — and turns each into a child ticket. It is an explicit command:
 * `symphony decompose T05` shows the plan and only `--apply` touches the repository.
 */

export interface DecompositionChild {
  id: string;
  title: string;
  item: string;
}

export interface DecompositionPlan {
  parentId: string;
  parentTitle: string;
  source: 'scope' | 'acceptance';
  children: DecompositionChild[];
}

function section(body: string, names: string[]): string | undefined {
  let capturing = false;
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) {
      if (capturing) break;
      const title = line.replace(/^##\s+/, '').trim().toLowerCase();
      capturing = names.some((n) => title === n || title.startsWith(`${n} `));
      continue;
    }
    if (capturing) out.push(line);
  }
  return capturing ? out.join('\n') : undefined;
}

function bullets(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line);
    if (!m) continue;
    const item = m[1].replace(/\s*\[(?:blocking|deferrable)(?::[^\]]*)?\]\s*$/i, '').trim();
    if (item) out.push(item);
  }
  return out;
}

function cleanItem(item: string): string {
  return item.replace(/\s+/g, ' ').trim();
}

function shortTitle(item: string): string {
  const text = cleanItem(item);
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}

/** Plan children from scope first, then unchecked acceptance. Undefined when there is too little to split. */
export function planDecomposition(parent: Task, body: string | undefined, tasks: Task[], config: Config): DecompositionPlan | undefined {
  if (!body) return undefined;
  let source: DecompositionPlan['source'] = 'scope';
  let items = bullets(section(body, ['scope', 'work', 'tasks', 'steps']));
  if (items.length < config.decomposition.minItems) {
    source = 'acceptance';
    items = parseAcceptance(body).filter((a) => !a.checked).map((a) => a.text);
  }
  items = [...new Set(items.map(cleanItem).filter(Boolean))];
  if (items.length < config.decomposition.minItems) return undefined;

  const ids = childIdsFor(parent.id, tasks.map((t) => t.id))
    .filter((id) => config.ceiling.maxSplitDepth <= 0 || splitDepth(id) <= config.ceiling.maxSplitDepth);
  const count = Math.min(items.length, config.decomposition.maxChildren, ids.length);
  if (count < config.decomposition.minItems) return undefined;

  const chosen = items.slice(0, count);
  const children = chosen.map((item, i) => ({
    id: ids[i],
    title: shortTitle(item),
    item,
  }));
  return { parentId: parent.id, parentTitle: parent.title, source, children };
}

function renderChild(parent: Task, child: DecompositionChild): string {
  return `# ${child.id} — ${child.title}

## Goal
Implement one slice of ${parent.id} — ${parent.title}: ${child.item}

## Scope
- ${child.item}

## Done when
- [ ] ${child.item}
- [ ] the project's verify command passes
- [ ] the change is scoped to this item (the other decomposed slices stay out)

## Hand-off
(not started; decomposed deterministically from ${parent.id})
`;
}

export interface AppliedDecomposition {
  childFiles: string[];
  childFileRels: string[];
  roadmapOk: boolean;
}

/** Write child task files and place their bullets immediately after the parent. */
export function applyDecomposition(paths: Paths, parent: Task, plan: DecompositionPlan): AppliedDecomposition {
  ensureDir(paths.tasksDir);
  const childFiles: string[] = [];
  const childFileRels: string[] = [];
  for (const child of plan.children) {
    const suffix = child.id.replace(/^T\d+/, '');
    const file = join(paths.tasksDir, `${String(parent.num).padStart(2, '0')}${suffix}-${slugify(child.title)}.md`);
    writeFileSync(file, renderChild(parent, child), 'utf8');
    childFiles.push(file);
    childFileRels.push(rel(paths.root, file));
  }

  // Insert in reverse so the roadmap ends up child1, child2, … directly after the parent.
  let roadmapOk = true;
  for (const child of [...plan.children].reverse()) {
    const fileRel = rel(paths.root, join(paths.tasksDir, `${String(parent.num).padStart(2, '0')}${child.id.replace(/^T\d+/, '')}-${slugify(child.title)}.md`));
    if (!insertRoadmapBulletAfter(paths.roadmap, parent.id, child.id, child.title, fileRel)) roadmapOk = false;
  }
  return { childFiles, childFileRels, roadmapOk };
}
