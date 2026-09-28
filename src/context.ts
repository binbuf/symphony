import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { rel, type Paths } from './paths.js';
import { atomicWriteSync, capUtf8, squash } from './util.js';

/*
 * Context assembly. Inlining is opt-in: the prompt normally names PROGRESS.md, docs/design/ and
 * docs/INDEX.md and the session reads what it needs, so the prompt stays small as the run grows.
 * - When PROGRESS.md is inlined (maxProgressBytes > 0), the harness maintains a short "Key facts"
 *   digest at the top and inlines that digest plus only the most recent sections.
 * - When design docs are inlined (inlineDesignDocs), only the docs a task names are inlined.
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
  if (!sections.length) return capUtf8(`${DIGEST_HEADING}\n\n_(no progress recorded yet)_`, maxBytes);

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
  return capUtf8(`${head}\n\n${kept.join('\n')}`, maxBytes);
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
  return capUtf8(t || '(empty)', maxBytes, `[… truncated; read ${displayName} for the full history …]\n\n`, true);
}

export interface ProgressContextOptions extends DigestOptions {
  /** Include the generated digest (default true). */
  digest?: boolean;
  /** How many of the newest full sections to inline (default 3). */
  recentSections?: number;
  /** Total byte cap for digest, recent sections and omission notices (default 32768). */
  maxBytes?: number;
}

/**
 * Inline recent sections and a digest of older sections, with no duplicate facts and one total cap.
 * Reserve at most half the budget (up to 8 KB) for the digest so recent hand-offs stay visible.
 */
export function readProgressContext(path: string, displayName = 'PROGRESS.md', opts: ProgressContextOptions = {}): string {
  const maxBytes = opts.maxBytes ?? 32768;
  if (!existsSync(path)) return capUtf8('(PROGRESS.md does not exist yet)', maxBytes);
  const text = readFileSync(path, 'utf8');
  const recentSections = opts.recentSections ?? RECENT_SECTIONS;
  const parts: string[] = [];
  const sections = parseProgressSections(text);
  const recent = recentSections > 0 ? sections.slice(-recentSections) : [];
  const older = sections.slice(0, sections.length - recent.length);
  if (opts.digest !== false && older.length) {
    const history = older.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');
    parts.push(buildProgressDigest(history, {
      linesPerSection: opts.linesPerSection,
      maxBytes: Math.min(Math.floor(maxBytes / 2), DIGEST_MAX_BYTES),
    }));
  }
  if (recent.length) {
    const label = recent.length < sections.length ? `last ${recent.length} of ${sections.length}` : 'all';
    const body = recent.map((s) => `## ${s.heading}\n\n${s.body}`.trim()).join('\n\n');
    const heading = `### Recent progress (${label} sections)\n\n`;
    const used = Buffer.byteLength(parts.join('\n\n'), 'utf8') + (parts.length ? 2 : 0) + Buffer.byteLength(heading, 'utf8');
    parts.push(`${heading}${capTail(body, Math.max(0, maxBytes - used), displayName)}`);
  }
  return capUtf8(parts.join('\n\n') || '(no progress recorded yet)', maxBytes);
}

export interface InlinedDoc { rel: string; content: string }

export interface InlineOptions {
  /** Resolve Markdown links relative to this task file, including nested task directories. */
  taskFile?: string;
  maxDocs?: number;
  maxDocBytes?: number;
  maxBytes?: number;
}

const IN_BACKTICKS = /`([^`\n]+)`/g;
const IN_LINK = /\]\(([^)\n]+)\)/g;

function extractCandidates(text: string): Array<{ raw: string; link: boolean }> {
  const out: Array<{ raw: string; link: boolean; offset: number }> = [];
  for (const re of [IN_BACKTICKS, IN_LINK]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) out.push({ raw: m[1], link: re === IN_LINK, offset: m.index });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

function resolveDoc(paths: Paths, raw: string, taskFile?: string, link = false): string | undefined {
  const cleaned = raw.trim().replace(/^<|>$/g, '').split('#')[0].split(/\s+/)[0];
  if (!cleaned || /^(https?:|mailto:)/i.test(cleaned)) return undefined;
  const local = taskFile ? [resolve(dirname(taskFile), cleaned)] : [];
  const candidates = isAbsolute(cleaned)
    ? [cleaned]
    : [...(link ? local : []), resolve(paths.root, cleaned), resolve(paths.docs, cleaned), resolve(paths.designDir, cleaned), resolve(paths.tasksDir, cleaned), ...(!link ? local : [])];
  return candidates.find((c) => {
    try { return existsSync(c) && statSync(c).isFile() && /\.md$/i.test(c); } catch { return false; }
  });
}

function isDesignDoc(paths: Paths, file: string): boolean {
  const prefix = `${rel(paths.root, paths.designDir)}/`;
  return rel(paths.root, file).startsWith(prefix);
}

function capDoc(text: string, maxBytes: number, displayName: string): string {
  return capUtf8(text.trim(), maxBytes, `\n[… truncated; read ${displayName} for the full document …]`);
}

/** The design docs a task file names (backticked paths or links), deduped and capped. */
export function selectTaskDesignDocs(paths: Paths, taskBody: string | undefined, opts: InlineOptions = {}): InlinedDoc[] {
  if (!taskBody) return [];
  const maxDocs = opts.maxDocs ?? 6;
  const maxDocBytes = opts.maxDocBytes ?? 8192;
  const maxBytes = opts.maxBytes ?? 24576;
  if (maxDocs <= 0 || maxDocBytes <= 0 || maxBytes <= 0) return [];
  const seen = new Set<string>();
  const out: InlinedDoc[] = [];
  let total = 0;
  for (const { raw, link } of extractCandidates(taskBody)) {
    const file = resolveDoc(paths, raw, opts.taskFile, link);
    if (!file || seen.has(file) || !isDesignDoc(paths, file)) continue;
    seen.add(file);
    const content = capDoc(readFileSync(file, 'utf8'), Math.min(maxDocBytes, maxBytes - total), rel(paths.root, file));
    const size = Buffer.byteLength(content, 'utf8');
    out.push({ rel: rel(paths.root, file), content });
    total += size;
    if (out.length >= maxDocs || total >= maxBytes) break;
  }
  return out;
}

/** The prompt section that inlines the docs the task named, or an empty string. */
export function renderInlinedDocs(docs: InlinedDoc[]): string {
  if (!docs.length) return '';
  const body = docs.map((d) => `### ${d.rel}\n\n${d.content}`).join('\n\n');
  return `--- DESIGN DOCS NAMED BY THIS TASK ---\n${body}\n--- END DESIGN DOCS ---\n\n`;
}
