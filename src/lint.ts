import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PROVIDER_NAMES } from './config.js';
import { gitToplevel } from './git.js';
import type { Paths } from './paths.js';
import { parseRoadmap, type Roadmap } from './roadmap.js';
import { discoverTasks, parseFrontMatter } from './tasks.js';
import { squash } from './util.js';

export type LintLevel = 'error' | 'warn' | 'info';
export interface Finding { level: LintLevel; code: string; message: string; path?: string }
export interface LintReport {
  findings: Finding[];
  /** Planning-looking documents outside .docs/ (relative to root). */
  candidates: string[];
  roadmap?: Roadmap;
  taskCount: number;
  /** No error-level findings. */
  ok: boolean;
}

const REQUIRED_SECTIONS: Array<[string, RegExp]> = [
  ['Goal', /^##\s+goal\b/im],
  ['Scope', /^##\s+scope\b/im],
  ['Done when', /^##\s+(done[\s-]*when|acceptance)/im],
  ['Hand-off', /^##\s+hand[\s-]*off/im],
];
const CANDIDATE_FILE = /^(roadmap|plan(s|ning)?|tasks?|todo|backlog|progress|milestones?|architecture|design|specs?|prd|adrs?|decisions?|rfc)([-_ .a-z0-9]*)\.md$/i;
const CANDIDATE_DIRS = new Set(['docs', 'doc', 'tasks', 'task', 'planning', 'plans', 'plan', 'specs', 'spec', 'design', 'designs', 'adr', 'adrs', 'architecture', 'rfcs', '.harness', 'notes', 'roadmap']);
const SKIP_DIRS = new Set(['.git', '.symphony', '.docs', 'node_modules', 'dist', 'build', 'vendor', 'target', '.next', '.venv', 'venv']);
const TASK_FILE_RE = /^T?\d{1,3}(?:[-_. ].*)?\.md$/i;
/** A line that was probably meant to be a task but did not parse as one. */
const TASKISH_LINE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX~]\]\s*)?(?:\*\*|__)?\s*(?:T-?\d{1,3}\b|task\s*#?\d+\b|\d{1,3}\s*[—–:.)-])/i;
const TASKISH_HEADING = /^#{1,6}\s+(?:\*\*)?\s*(?:T-?\d{1,3}\b|task\s*#?\d+\b)/i;
const FENCE_RE = /^[ \t]*(```|~~~)/;

function listMd(dir: string, depth: number, out: string[], root: string): void {
  if (!existsSync(dir) || out.length > 60) return;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (depth > 0 && !SKIP_DIRS.has(name)) listMd(p, depth - 1, out, root); }
    else if (/\.md$/i.test(name)) out.push(relative(root, p));
  }
}

/** Planning documents living outside .docs/: root-level *.md with telling names and known planning dirs. */
export function scanCandidates(paths: Paths): string[] {
  const out: string[] = [];
  if (!existsSync(paths.root)) return out;
  for (const name of readdirSync(paths.root).sort()) {
    const p = join(paths.root, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isFile() && CANDIDATE_FILE.test(name)) out.push(name);
    else if (st.isDirectory() && !SKIP_DIRS.has(name) && CANDIDATE_DIRS.has(name.toLowerCase())) listMd(p, 2, out, paths.root);
  }
  return out;
}

export function docsTree(paths: Paths): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir) || depth < 0) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      let st; try { st = statSync(p); } catch { continue; }
      out.push(`${relative(paths.root, p)}${st.isDirectory() ? '/' : ` (${st.size} B)`}`);
      if (st.isDirectory()) walk(p, depth - 1);
    }
  };
  walk(paths.docs, 3);
  return out;
}

export function lintDocs(paths: Paths): LintReport {
  const f: Finding[] = [];
  const add = (level: LintLevel, code: string, message: string, path?: string) => f.push({ level, code, message, path });
  const candidates = scanCandidates(paths);
  let roadmap: Roadmap | undefined;
  let taskCount = 0;

  if (!gitToplevel(paths.root)) add('error', 'git', 'project is not a git repository (run: git init); the harness commits after every task');
  const gi = join(paths.root, '.gitignore');
  if (!existsSync(gi) || !readFileSync(gi, 'utf8').split(/\r?\n/).some((l) => l.trim() === '.symphony/')) add('warn', 'gitignore', '.gitignore does not list .symphony/', '.gitignore');

  if (!existsSync(paths.docs)) {
    add('error', 'docs-missing', candidates.length
      ? `.docs/ does not exist; planning documents found elsewhere: ${candidates.slice(0, 8).join(', ')}${candidates.length > 8 ? ', …' : ''}`
      : '.docs/ does not exist and no planning documents were found (write .docs/ROADMAP.md, or use `symphony brief`)');
    return { findings: f, candidates, taskCount, ok: false };
  }

  for (const name of readdirSync(paths.docs)) {
    const lower = name.toLowerCase();
    if (lower === 'roadmap.md' && name !== 'ROADMAP.md') add('error', 'roadmap-case', `found .docs/${name}; the harness reads .docs/ROADMAP.md (exact case)`, `.docs/${name}`);
    if (lower === 'progress.md' && name !== 'PROGRESS.md') add('warn', 'progress-case', `found .docs/${name}; the harness writes .docs/PROGRESS.md (exact case)`, `.docs/${name}`);
    if (lower === 'adr' || lower === 'adrs' || lower === 'decisions') add('error', 'adr-location', `.docs/${name}/ should be .docs/design/adr/`, `.docs/${name}`);
    if (lower === 'tasks.md' || lower === 'todo.md' || lower === 'plan.md') add('error', 'docs-stray', `.docs/${name}: tasks must be bullets in ROADMAP.md with one file each under .docs/tasks/`, `.docs/${name}`);
  }

  if (!existsSync(paths.roadmap)) {
    add('error', 'roadmap-missing', candidates.length ? `.docs/ROADMAP.md is missing; convert from: ${candidates.slice(0, 8).join(', ')}` : '.docs/ROADMAP.md is missing (write one, or use `symphony brief`)', '.docs/ROADMAP.md');
  } else {
    const text = readFileSync(paths.roadmap, 'utf8');
    try { roadmap = parseRoadmap(text); } catch (e) { add('error', 'roadmap-parse', (e as Error).message, '.docs/ROADMAP.md'); }
    if (roadmap) {
      taskCount = roadmap.bullets.length;
      if (taskCount === 0) add('error', 'roadmap-empty', 'ROADMAP.md has no task bullets of the form "- [ ] T01 — Title"', '.docs/ROADMAP.md');
      const parsed = new Set(roadmap.bullets.map((b) => b.lineIndex));
      let inFence = false;
      roadmap.lines.forEach((line, i) => {
        if (FENCE_RE.test(line)) { inFence = !inFence; return; }
        if (inFence || parsed.has(i)) return;
        if (TASKISH_HEADING.test(line)) add('error', 'roadmap-unparsed', `line ${i + 1} looks like a task written as a heading; tasks must be top-level bullets: ${squash(line, 80)}`, '.docs/ROADMAP.md');
        else if (TASKISH_LINE.test(line)) {
          const nested = /^\s+/.test(line);
          add('error', 'roadmap-unparsed', `line ${i + 1} looks like a task but does not parse${nested ? ' (nested bullets are ignored; make it top-level)' : ' (expected "- [ ] T01 — Title")'}: ${squash(line, 80)}`, '.docs/ROADMAP.md');
        }
      });
      for (let i = 1; i < roadmap.bullets.length; i++) {
        if (roadmap.bullets[i].num <= roadmap.bullets[i - 1].num) {
          add('warn', 'roadmap-order', `task ids are not ascending in file order (${roadmap.bullets[i - 1].id} then ${roadmap.bullets[i].id}); execution follows file order, so renumber to avoid confusion`, '.docs/ROADMAP.md');
          break;
        }
      }
      if (taskCount > 0 && roadmap.bullets.every((b) => b.phase === '(no phase)')) add('info', 'roadmap-phases', 'no "## Phase" headings; every task will show phase "(no phase)"', '.docs/ROADMAP.md');
      if (taskCount > 0 && roadmap.bullets.every((b) => b.check === 'x')) add('info', 'roadmap-all-done', 'every task is already marked [x]; nothing would run');

      try {
        const { tasks, warnings } = discoverTasks(paths, roadmap);
        for (const w of warnings) {
          if (/linked task file .* not found/.test(w)) add('error', 'task-link-broken', w, '.docs/ROADMAP.md');
          else if (/no task file/.test(w)) add('warn', 'task-file-missing', w);
          else if (/has no bullet/.test(w)) add('warn', 'task-orphan', w);
          else add('warn', 'tasks', w);
        }
        for (const t of tasks) {
          if (!t.taskFile) continue;
          const { meta, body } = parseFrontMatter(readFileSync(t.taskFile, 'utf8'));
          const missing = REQUIRED_SECTIONS.filter(([, re]) => !re.test(body)).map(([n]) => n);
          if (!/\S/.test(body)) add('warn', 'task-empty', `${t.taskFileRel} is empty`, t.taskFileRel);
          else if (missing.length) add('warn', 'task-sections', `${t.taskFileRel}: missing section${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`, t.taskFileRel);
          if (meta.provider && !(PROVIDER_NAMES as string[]).includes(meta.provider)) add('error', 'task-frontmatter', `${t.taskFileRel}: front matter provider "${meta.provider}" is not one of ${PROVIDER_NAMES.join(', ')}`, t.taskFileRel);
        }
      } catch (e) {
        add('error', 'tasks-dir', (e as Error).message, '.docs/tasks');
      }
    }
  }

  if (existsSync(paths.tasksDir)) {
    for (const name of readdirSync(paths.tasksDir)) {
      if (!/\.md$/i.test(name) || TASK_FILE_RE.test(name) || /^(template|readme)\.md$/i.test(name)) continue;
      add('warn', 'task-filename', `.docs/tasks/${name} does not follow NN-slug.md and will not be matched to a task`, `.docs/tasks/${name}`);
    }
  } else add('warn', 'tasks-dir-missing', '.docs/tasks/ does not exist; every task should have a detail file there');

  if (!existsSync(paths.designDir)) add('warn', 'design-missing', '.docs/design/ does not exist; architecture docs live there');
  else if (!readdirSync(paths.designDir).some((n) => /\.md$/i.test(n))) add('info', 'design-empty', '.docs/design/ has no architecture docs yet');
  if (!existsSync(paths.adrDir)) add('info', 'adr-missing', '.docs/design/adr/ does not exist; it is created on init/prepare');
  if (!existsSync(paths.progress)) add('info', 'progress-missing', '.docs/PROGRESS.md does not exist; it is created on the first run');
  if (candidates.length) add('info', 'candidates', `planning documents outside .docs/: ${candidates.slice(0, 10).join(', ')}${candidates.length > 10 ? `, … (${candidates.length})` : ''}`);

  return { findings: f, candidates, roadmap, taskCount, ok: !f.some((x) => x.level === 'error') };
}

export function formatLint(r: LintReport): string[] {
  const mark = { error: '✗', warn: '!', info: '·' } as const;
  const lines = r.findings.map((x) => `${mark[x.level]} ${x.code.padEnd(18)} ${x.message}`);
  const errors = r.findings.filter((x) => x.level === 'error').length;
  const warns = r.findings.filter((x) => x.level === 'warn').length;
  lines.push(r.ok
    ? `lint: ok (${r.taskCount} task${r.taskCount === 1 ? '' : 's'}${warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : ''})`
    : `lint: ${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`);
  return lines;
}
