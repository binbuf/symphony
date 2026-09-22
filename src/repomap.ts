import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { rel, type Paths } from './paths.js';
import { atomicWriteSync, clip, squash } from './util.js';

/*
 * A cheap, deterministic repo map: one-line summaries of the design docs plus a source-file list with
 * top-level symbols. It is regenerated before each task, written to `docs/INDEX.md`, committed with the
 * task, and inlined into the prompt so the agent does not spend turns discovering files.
 *
 * Regex-based on purpose: no language servers, no dependencies, provider-agnostic. A file that yields no
 * symbols is still listed by path.
 */

const SKIP_DIRS = new Set([
  '.git', '.symphony', '.docs', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.venv', 'venv', '__pycache__', 'coverage', '.turbo', '.cache', '.idea', '.vscode', 'tmp', 'temp',
]);

const TS_JS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PY = new Set(['.py']);
const GO = new Set(['.go']);
const RUST = new Set(['.rs']);
const JVM = new Set(['.java', '.kt', '.kts', '.scala', '.cs']);
const RUBY = new Set(['.rb']);
const C_FAMILY = new Set(['.c', '.h', '.cpp', '.cc', '.hpp']);

const SOURCE_EXTS = new Set([...TS_JS, ...PY, ...GO, ...RUST, ...JVM, ...RUBY, ...C_FAMILY]);

const SYMBOL_RES: Array<{ exts: Set<string>; re: RegExp }> = [
  { exts: TS_JS, re: /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm },
  { exts: TS_JS, re: /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm },
  { exts: TS_JS, re: /^class\s+([A-Za-z_$][\w$]*)/gm },
  { exts: PY, re: /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm },
  { exts: GO, re: /^(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm },
  { exts: RUST, re: /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|mod|const|static)\s+([A-Za-z_]\w*)/gm },
  { exts: JVM, re: /^\s*(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial|\s)*(?:class|interface|enum|record|struct|object|fun)\s+([A-Za-z_]\w*)/gm },
  { exts: RUBY, re: /^\s*(?:def|class|module)\s+([A-Za-z_]\w*[!?]?)/gm },
];

const MAX_SYMBOLS_PER_FILE = 24;
const MAX_SYMBOL_FILE_BYTES = 512 * 1024;

export interface RepoMapOptions {
  maxFiles?: number;
  maxDepth?: number;
  maxBytes?: number;
}

function symbolsFor(file: string, text: string): string[] {
  const ext = extname(file).toLowerCase();
  const names = new Set<string>();
  for (const { exts, re } of SYMBOL_RES) {
    if (!exts.has(ext)) continue;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) names.add(m[1]);
  }
  return [...names].slice(0, MAX_SYMBOLS_PER_FILE);
}

function fileSymbols(file: string): string[] {
  try {
    if (statSync(file).size > MAX_SYMBOL_FILE_BYTES) return [];
    return symbolsFor(file, readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function collectSources(root: string, paths: Paths, opts: { maxFiles: number; maxDepth: number }): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (truncated || depth < 0) return;
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const name of entries) {
      if (truncated) return;
      if (name.startsWith('.')) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || p === paths.docs) continue;
        walk(p, depth - 1);
      } else if (SOURCE_EXTS.has(extname(name).toLowerCase())) {
        if (files.length >= opts.maxFiles) { truncated = true; return; }
        files.push(rel(root, p));
      }
    }
  };
  walk(root, opts.maxDepth);
  return { files, truncated };
}

function groupByDir(files: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of files) {
    const i = f.indexOf('/');
    const dir = i === -1 ? '(root)' : f.slice(0, i);
    const group = map.get(dir);
    if (group) group.push(f);
    else map.set(dir, [f]);
  }
  return map;
}

function listMarkdown(dir: string, out: string[] = [], depth = 2): string[] {
  if (!existsSync(dir) || depth < 0) return out;
  let entries: string[];
  try { entries = readdirSync(dir).sort(); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) listMarkdown(p, out, depth - 1);
    else if (/\.md$/i.test(name)) out.push(p);
  }
  return out;
}

function docSummary(file: string): string {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return ''; }
  const lines = text.split(/\r?\n/);
  const h1 = lines.find((l) => /^#\s+/.test(l));
  if (h1) return squash(h1.replace(/^#\s+/, ''), 120);
  const para = lines.map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return para ? squash(para, 120) : '';
}

/** The full generated index markdown. Deterministic: identical tree → identical bytes. */
export function generateIndex(paths: Paths, opts: RepoMapOptions = {}): string {
  const maxFiles = opts.maxFiles ?? 400;
  const maxDepth = opts.maxDepth ?? 4;
  const maxBytes = opts.maxBytes ?? 24576;
  const lines: string[] = [
    '# Project index',
    '',
    '_Generated by symphony from the working tree. Do not edit by hand; it is rewritten before each task and committed._',
    '',
    '## Design documents',
  ];
  const docs = listMarkdown(paths.designDir);
  for (const f of docs) {
    const summary = docSummary(f);
    lines.push(`- \`${rel(paths.root, f)}\`${summary ? ` — ${summary}` : ''}`);
  }
  if (!docs.length) lines.push('- (none yet)');

  lines.push('', '## Source map');
  const { files, truncated } = collectSources(paths.root, paths, { maxFiles, maxDepth });
  if (!files.length) lines.push('- (no source files found)');
  else {
    for (const [dir, group] of groupByDir(files)) {
      lines.push('', `### \`${dir}/\``);
      for (const f of group) {
        const syms = fileSymbols(join(paths.root, f));
        lines.push(`- \`${f}\`${syms.length ? ` — ${syms.join(', ')}` : ''}`);
      }
    }
  }
  if (truncated) lines.push('', `_… more files omitted (maxFiles=${maxFiles})._`);
  return `${clip(lines.join('\n'), maxBytes)}\n`;
}

/** Write docs/INDEX.md. Returns whether the bytes changed. */
export function writeIndex(paths: Paths, opts: RepoMapOptions = {}): { changed: boolean; bytes: number } {
  const text = generateIndex(paths, opts);
  const bytes = Buffer.byteLength(text, 'utf8');
  try {
    if (existsSync(paths.index) && readFileSync(paths.index, 'utf8') === text) return { changed: false, bytes };
  } catch { /* rewrite below */ }
  atomicWriteSync(paths.index, text);
  return { changed: true, bytes };
}

/** Inline the index, capped, with a pointer to the full file. */
export function readIndexCapped(path: string, maxBytes: number, displayName: string): string {
  if (!existsSync(path)) return '(not generated yet; the harness writes it before the first task)';
  const text = readFileSync(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text.trim();
  const buf = Buffer.from(text, 'utf8');
  let start = buf.length - maxBytes;
  const nl = buf.indexOf(0x0a, start);
  if (nl !== -1 && nl < buf.length - 1) start = nl + 1;
  const kb = (n: number): string => `${Math.round(n / 1024)} KB`;
  return `[… index truncated: showing the last ${kb(buf.length - start)} of ${kb(buf.length)}; read ${displayName} for the rest …]\n\n${buf.subarray(start).toString('utf8').trim()}`;
}
