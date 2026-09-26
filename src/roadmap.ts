import { readFileSync } from 'node:fs';
import { atomicWriteSync } from './util.js';

export type Tag = 'running' | 'blocked' | 'failed' | 'accepted';
export type RoadmapStatus = 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'accepted';

export interface Bullet {
  /** Canonical id: T + zero-padded number (T01, T12, T100), plus an optional split suffix (T10a, T10a1). */
  id: string;
  num: number;
  /** Split suffix: '' for a base task, a letter or letter+digits for a subtask of `symphony split`. */
  suffix: string;
  title: string;
  phase: string;
  lineIndex: number;
  /** [x] done · [~] unfinished (running/blocked/failed) · [ ] pending. */
  check: 'x' | '~' | ' ' | null;
  tag: Tag | null;
  /** Link target as written (relative to .docs/), if the bullet links a task file. */
  link?: string;
  /** Original bytes before the checkbox: bullet char + whitespace. */
  pre: string;
  /** Original bytes from the id through the title (excluding tag), trailing space trimmed. */
  body: string;
}

export interface Roadmap {
  bullets: Bullet[];
  lines: string[];
  eol: '\n' | '\r\n';
}

/**
 * Top-level bullet with optional checkbox, task id, separator, title, optional harness tag.
 *   - [ ] T01 — Title → [tasks/01-title.md](tasks/01-title.md)
 *   - [x] T02 — Title ⟵ accepted
 *   - [~] T03 — Title ⟵ failed
 *   - 04. Title
 * A bare number (no `T`) needs a punctuation separator so prose like "- 2 servers" is not a task.
 * Ids may carry a split suffix (`T10a`, `T10b`, …) for the children of a task broken down by
 * `symphony split`; the suffix is a lowercase letter with optional digits (T10a1).
 */
const BULLET_RE =
  /^(?<pre>[-*+][ \t]+)(?:\[(?<check>[ xX~])\][ \t]+)?(?<body>(?<id>T\d{1,3}(?:[a-z]\d*)?|\d{1,3}(?:[a-z]\d*)?)(?<sep>[ \t]*[—–:.)-]+[ \t]*|[ \t]+)(?<rest>.*?))(?:[ \t]*⟵[ \t]*(?<tag>running|blocked|failed|accepted))?[ \t]*$/u;
const HEADING_RE = /^##(?!#)[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^[ \t]*(```|~~~)/;
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

export interface TaskId {
  /** Canonical id. */
  id: string;
  /** Numeric base, e.g. 10 for T10a. */
  num: number;
  /** '' for a base task, otherwise the lowercase suffix (`a`, `b`, `a1`). */
  suffix: string;
}

/** Parse a user- or roadmap-supplied task id (`T10`, `10`, `t10a`, `T10A1`). */
export function parseTaskId(input: string): TaskId | undefined {
  const m = /^\s*T?(\d{1,3})([a-z]\d*)?\s*$/i.exec(input);
  if (!m) return undefined;
  const num = Number(m[1]);
  const suffix = (m[2] ?? '').toLowerCase();
  return { id: formatTaskId(num, suffix), num, suffix };
}

export function formatTaskId(num: number, suffix = ''): string {
  return `T${String(num).padStart(2, '0')}${suffix}`;
}

export function canonicalId(input: string): string | undefined {
  return parseTaskId(input)?.id;
}

export function idFromNum(n: number): string {
  return formatTaskId(n);
}

/** Roadmap order: by numeric base, then by suffix ('' before 'a' before 'a1' before 'b'). */
export function taskIdOrder(a: { num: number; suffix?: string }, b: { num: number; suffix?: string }): number {
  if (a.num !== b.num) return a.num - b.num;
  const as = a.suffix ?? '';
  const bs = b.suffix ?? '';
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function cleanTitle(rest: string): { title: string; link?: string } {
  let link: string | undefined;
  let title = rest.replace(LINK_RE, (_m, label: string, href: string) => {
    if (!link && /\.md$/i.test(href)) {
      link = href;
      return /\.md$/i.test(label) || label === href ? '' : label;
    }
    return label;
  });
  title = title
    .replace(/\(\s*\)/g, '')
    .replace(/[\s→⟶➜>\-—–:]+$/u, '')
    .replace(/^[\s\-—–:]+/u, '')
    .trim();
  return { title, link };
}

export function parseRoadmap(text: string): Roadmap {
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  // Split on both endings: a single CRLF among LF lines must not collapse the file into one line.
  const lines = text.split(/\r\n|\n/);
  const bullets: Bullet[] = [];
  const seen = new Map<string, number>();
  let phase = '(no phase)';
  let inFence = false;

  lines.forEach((line, lineIndex) => {
    if (FENCE_RE.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const h = HEADING_RE.exec(line);
    if (h) { phase = h[1].trim(); return; }
    const m = BULLET_RE.exec(line);
    if (!m?.groups) return;
    const g = m.groups;
    const rawId = g.id;
    if (!rawId.startsWith('T') && !/[—–:.)-]/.test(g.sep)) return; // bare number without separator = prose
    const parsed = parseTaskId(rawId);
    if (!parsed) return;
    const { id, num, suffix } = parsed;
    const prev = seen.get(id);
    if (prev !== undefined) {
      throw new Error(`ROADMAP.md: task ${id} appears twice (lines ${prev + 1} and ${lineIndex + 1}). One bullet per task id.`);
    }
    seen.set(id, lineIndex);
    const { title, link } = cleanTitle(g.rest);
    bullets.push({
      id,
      num,
      suffix,
      title: title || id,
      phase,
      lineIndex,
      check: g.check === undefined ? null : g.check.toLowerCase() === 'x' ? 'x' : g.check === '~' ? '~' : ' ',
      tag: (g.tag as Tag | undefined) ?? null,
      link,
      pre: g.pre,
      body: g.body.trimEnd(),
    });
  });

  return { bullets, lines, eol };
}

/**
 * Harness-owned markers: [x] done, [x] ⟵ accepted, [ ] pending,
 * [~] ⟵ running|blocked|failed = more work needed (interrupted, blocked on a human, or needs a rerun).
 */
export function markerFor(status: RoadmapStatus): { check: 'x' | '~' | ' '; tag: Tag | null } {
  switch (status) {
    case 'done': return { check: 'x', tag: null };
    case 'accepted': return { check: 'x', tag: 'accepted' };
    case 'pending': return { check: ' ', tag: null };
    case 'running':
    case 'blocked':
    case 'failed':
      return { check: '~', tag: status };
  }
}

export function renderBulletLine(b: Bullet, status: RoadmapStatus): string {
  const { check, tag } = markerFor(status);
  return `${b.pre}[${check}] ${b.body}${tag ? ` ⟵ ${tag}` : ''}`;
}

/** Status implied by the roadmap markers alone (used to rebuild state on a fresh clone). */
export function statusFromMarkers(b: Bullet): RoadmapStatus {
  if (b.tag === 'accepted') return 'accepted';
  if (b.check === 'x') return 'done';
  if (b.tag) return b.tag;
  if (b.check === '~') return 'failed'; // unfinished, needs a rerun
  return 'pending';
}

/**
 * Re-read, re-parse and rewrite exactly one bullet line. Every other byte is preserved.
 * Returns 'patched' | 'unchanged' | 'missing'.
 */
export function patchRoadmapFile(path: string, id: string, status: RoadmapStatus): 'patched' | 'unchanged' | 'missing' {
  const text = readFileSync(path, 'utf8');
  const rm = parseRoadmap(text);
  const b = rm.bullets.find((x) => x.id === id);
  if (!b) return 'missing';
  const next = renderBulletLine(b, status);
  if (rm.lines[b.lineIndex] === next) return 'unchanged';
  rm.lines[b.lineIndex] = next;
  atomicWriteSync(path, rm.lines.join(rm.eol));
  return 'patched';
}

export const STATUS_START = '<!-- symphony:status -->';
export const STATUS_END = '<!-- /symphony:status -->';

/**
 * Insert or replace the harness-owned pipeline status block delimited by the STATUS_START/STATUS_END
 * comments. Task bullets and every other byte are left alone.
 */
export function patchRoadmapStatus(path: string, block: string): void {
  const text = readFileSync(path, 'utf8');
  const rm = parseRoadmap(text);
  const lines = rm.lines.slice();
  const body = block.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  let start = lines.findIndex((l) => l.trim() === STATUS_START);
  let end = lines.findIndex((l) => l.trim() === STATUS_END);
  if (start !== -1 && end !== -1 && end > start) {
    lines.splice(start, end - start + 1, STATUS_START, ...body, STATUS_END);
  } else {
    if (start !== -1) lines.splice(start, 1);
    end = lines.findIndex((l) => l.trim() === STATUS_END);
    if (end !== -1) lines.splice(end, 1);
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', STATUS_START, ...body, STATUS_END, '');
  }
  atomicWriteSync(path, lines.join(rm.eol));
}
