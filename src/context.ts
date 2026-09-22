import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { rel, type Paths } from './paths.js';
import { atomicWriteSync, squash } from './util.js';

/*
 * Context assembly: keeps the token cost of every prompt proportional to what the task needs, not to
 * how long the run has been going.
 * - PROGRESS.md is append-only; the harness maintains a short "Key facts" digest at the top and inlines
 *   that digest plus only the most recent sections, instead of a raw byte-capped tail.
 * - Only the design docs a task names in its Context / Design notes are inlined, not every doc.
 */

const DIGEST_START = '<!-- symphony:digest:start -->';
const DIGEST_END = '<!-- symphony:digest:end -->';
const DIGEST_HEADING = '## Key facts (maintained by symphony — do not edit)';
const DIGEST_MAX_BYTES = 8192;
const DIGEST_LINES_PER_SECTION = 2;
const RECENT_SECTIONS = 3;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DIGEST_RE = new RegExp(`${escapeRegExp(DIGEST_START)}[\\s\\S]*?${escapeRegExp(DIGEST_END)}`);

export interface ProgressSection { heading: string; body: string }

/** The append-only notes with the generated digest block removed. */
export function stripProgressDigest(text: string): string {
  return text.replace(DIGEST_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Split PROGRESS.md into its `## <heading>` sections, ignoring the generated digest block. */
export function parseProgressSections(text: string): ProgressSection[] {
  const sections: ProgressSection[] = [];
  let current: ProgressSection | undefined;
  for (const line of stripProgressDigest(text).split(/\r?\n/)) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      if (current) sections.push(current);
      current = { heading: h[1].trim(), body: '' };
    } else if (current) current.body += `${line}\n`;
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ heading: s.heading, body: s.body.trim() }));
}

function factsFor(body: string, maxLines: number): string[] {
  const facts: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line)) continue;
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const fact = bullet ? bullet[1] : facts.length === 0 ? line : '';
    if (!fact) continue;
    facts.push(squash(fact, 200));
    if (facts.length >= maxLines) break;
  }
  return facts;
}

export interface DigestOptions {
  linesPerSection?: number;
  maxBytes?: number;
}

/** A compact "Key facts" block derived from the leading facts of every progress section. */
export function buildProgressDigest(text: string, opts: DigestOptions = {}): string {
  const linesPerSection = opts.linesPerSection ?? DIGEST_LINES_PER_SECTION;
  const maxBytes = opts.maxBytes ?? DIGEST_MAX_BYTES;
  const sections = parseProgressSections(text);
  if (!sections.length) return `${DIGEST_HEADING}\n\n_(no progress recorded yet)_`;

  const items = sections.map((s) => {
    const facts = factsFor(s.body, linesPerSection);
    return facts.length ? `- **${s.heading}**: ${facts.join('; ')}` : `- **${s.heading}**`;
  });
  let kept = items;
  let omitted = 0;
  while (kept.length > 1 && Buffer.byteLength(kept.join('\n'), 'utf8') > maxBytes) {
    kept = kept.slice(1);
    omitted += 1;
  }
  const head = omitted ? `${DIGEST_HEADING}\n\n_(${omitted} earlier section${omitted === 1 ? '' : 's'} omitted)_` : DIGEST_HEADING;
  return `${head}\n\n${kept.join('\n')}`;
}

/** Replace the digest block in place, or insert it after the file's first heading. */
export function upsertProgressDigest(text: string, digest: string): string {
  const block = `${DIGEST_START}\n${digest}\n${DIGEST_END}`;
  if (DIGEST_RE.test(text)) return text.replace(DIGEST_RE, block);
  const m = /^(#[^\n]*\n(?:\s*\n)*)/.exec(text);
  if (m) return `${text.slice(0, m[0].length)}${block}\n\n${text.slice(m[0].length)}`;
  return `${block}\n\n${text}`;
}

/** Rewrite the digest block inside PROGRESS.md. Returns true when the file changed. */
export function writeProgressDigest(path: string, opts: DigestOptions = {}): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  const next = upsertProgressDigest(text, buildProgressDigest(text, opts));
  if (next === text) return false;
  atomicWriteSync(path, next);
  return true;
}

function capTail(text: string, maxBytes: number, displayName: string): string {
  const t = text.trim();
  if (Buffer.byteLength(t, 'utf8') <= maxBytes) return t || '(empty)';
  const buf = Buffer.from(t, 'utf8');
  let start = buf.length - maxBytes;
  const nl = buf.indexOf(0x0a, start);
  if (nl !== -1 && nl < buf.length - 1) start = nl + 1;
  const kb = (n: number): string => `${Math.round(n / 1024)} KB`;
  return `[… truncated: showing the last ${kb(buf.length - start)} of ${kb(buf.length)}; read ${displayName} for the full history …]\n\n${buf.subarray(start).toString('utf8').trim()}`;
}

export interface ProgressContextOptions extends DigestOptions {
  /** Include the generated digest (default true). */
  digest?: boolean;
  /** How many of the newest full sections to inline (default 3). */
  recentSections?: number;
  /** Byte cap for the inlined recent sections (default 32768). */
  maxBytes?: number;
}

/**
 * What the prompt sees for PROGRESS.md: the generated digest plus the most recent sections, capped.
 * The digest is always kept; only the recent-section block is byte-capped.
 */
export function readProgressContext(path: string, displayName = 'PROGRESS.md', opts: ProgressContextOptions = {}): string {
  if (!existsSync(path)) return '(PROGRESS.md does not exist yet)';
  const text = readFileSync(path, 'utf8');
  const maxBytes = opts.maxBytes ?? 32768;
  const recentSections = opts.recentSections ?? RECENT_SECTIONS;
  const parts: string[] = [];
  if (opts.digest !== false) {
    parts.push(buildProgressDigest(text, { linesPerSection: opts.linesPerSection, maxBytes: Math.min(opts.maxBytes ?? DIGEST_MAX_BYTES, DIGEST_MAX_BYTES) }));
  }
  const sections = parseProgressSections(text);
  if (sections.length) {
    const recent = sections.slice(-recentSections);
    const label = recent.length < sections.length ? `last ${recent.length} of ${sections.length}` : 'all';
    const body = recent.map((s) => `## ${s.heading}\n\n${s.body}`.trim()).join('\n\n');
    parts.push(`### Recent progress (${label} sections)\n\n${capTail(body, maxBytes, displayName)}`);
  }
  return parts.join('\n\n');
}

export interface InlinedDoc { rel: string; content: string }

export interface InlineOptions {
  maxDocs?: number;
  maxDocBytes?: number;
  maxBytes?: number;
}

const IN_BACKTICKS = /`([^`\n]+)`/g;
const IN_LINK = /\]\(([^)\n]+)\)/g;

function extractCandidates(text: string): string[] {
  const out: string[] = [];
  for (const re of [IN_BACKTICKS, IN_LINK]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1]);
  }
  return out;
}

function resolveDoc(paths: Paths, raw: string): string | undefined {
  const cleaned = raw.trim().replace(/^<|>$/g, '').split('#')[0].split(/\s+/)[0];
  if (!cleaned || /^(https?:|mailto:)/i.test(cleaned)) return undefined;
  const candidates = isAbsolute(cleaned)
    ? [cleaned]
    : [resolve(paths.root, cleaned), resolve(paths.docs, cleaned), resolve(paths.designDir, cleaned), resolve(paths.tasksDir, cleaned)];
  return candidates.find((c) => {
    try { return existsSync(c) && statSync(c).isFile() && /\.md$/i.test(c); } catch { return false; }
  });
}

function isDesignDoc(paths: Paths, file: string): boolean {
  const prefix = `${rel(paths.root, paths.designDir)}/`;
  return rel(paths.root, file).startsWith(prefix);
}

function capDoc(text: string, maxBytes: number): string {
  const t = text.trim();
  if (Buffer.byteLength(t, 'utf8') <= maxBytes) return t;
  return `${Buffer.from(t, 'utf8').subarray(0, maxBytes).toString('utf8')}…`;
}

/** The design docs a task file names (backticked paths or links), deduped and capped. */
export function selectTaskDesignDocs(paths: Paths, taskBody: string | undefined, opts: InlineOptions = {}): InlinedDoc[] {
  if (!taskBody) return [];
  const maxDocs = opts.maxDocs ?? 6;
  const maxDocBytes = opts.maxDocBytes ?? 8192;
  const maxBytes = opts.maxBytes ?? 24576;
  const seen = new Set<string>();
  const out: InlinedDoc[] = [];
  let total = 0;
  for (const raw of extractCandidates(taskBody)) {
    const file = resolveDoc(paths, raw);
    if (!file || seen.has(file) || !isDesignDoc(paths, file)) continue;
    seen.add(file);
    const content = capDoc(readFileSync(file, 'utf8'), maxDocBytes);
    const size = Buffer.byteLength(content, 'utf8');
    if (out.length && total + size > maxBytes) break;
    out.push({ rel: rel(paths.root, file), content });
    total += size;
    if (out.length >= maxDocs) break;
  }
  return out;
}

/** The prompt section that inlines the docs the task named, or an empty string. */
export function renderInlinedDocs(docs: InlinedDoc[]): string {
  if (!docs.length) return '';
  const body = docs.map((d) => `### ${d.rel}\n\n${d.content}`).join('\n\n');
  return `--- DESIGN DOCS NAMED BY THIS TASK ---\n${body}\n--- END DESIGN DOCS ---\n\n`;
}
