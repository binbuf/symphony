import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GitResult { code: number; stdout: string; stderr: string }

export function git(root: string, args: string[]): GitResult {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 120_000 });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? r.error?.message ?? '').trim() };
}

export function gitAvailable(): boolean {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

export function gitToplevel(root: string): string | undefined {
  const r = git(root, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.stdout : undefined;
}

/** Current branch name; works on an unborn branch (before the first commit) and reports detached HEAD. */
export function currentBranch(root: string): string {
  const sym = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (sym.code === 0 && sym.stdout) return sym.stdout;
  const r = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.code === 0 ? r.stdout : '(no branch)';
}

export function dirtyFiles(root: string): string[] {
  const r = git(root, ['status', '--porcelain']);
  return r.code === 0 && r.stdout ? r.stdout.split('\n').filter(Boolean) : [];
}

/** Untracked files that are not already ignored (relative to `root`, forward slashes). */
export function untrackedFiles(root: string): string[] {
  const r = git(root, ['ls-files', '--others', '--exclude-standard']);
  return r.code === 0 && r.stdout ? r.stdout.split('\n').filter(Boolean).map((f) => f.replace(/\\/g, '/')) : [];
}

/** Directory names that are never worth committing. */
const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'target', 'coverage', '.next', '.nuxt', '.cache',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.turbo', '.parcel-cache', '.symphony',
  '.gradle', '.idea', '.vscode',
]);

/** File basename patterns that are ephemeral or secret; maps to the ignore pattern to add. */
const IGNORE_FILES: Array<[RegExp, string]> = [
  [/^\.env/i, '.env*'],
  [/\.log$/i, '*.log'],
  [/\.tmp$/i, '*.tmp'],
  [/\.temp$/i, '*.temp'],
  [/\.swp$/i, '*.swp'],
  [/\.swo$/i, '*.swo'],
  [/~$/, '*~'],
  [/^\.ds_store$/i, '.DS_Store'],
  [/^thumbs\.db$/i, 'Thumbs.db'],
  [/\.py[co]$/i, '*.pyc'],
  [/\.class$/i, '*.class'],
  [/\.o$/, '*.o'],
  [/\.obj$/i, '*.obj'],
  [/\.tsbuildinfo$/i, '*.tsbuildinfo'],
  [/\.pid$/i, '*.pid'],
  [/\.orig$/i, '*.orig'],
  [/\.rej$/i, '*.rej'],
  [/\.pem$/i, '*.pem'],
  [/\.key$/i, '*.key'],
  [/\.p12$/i, '*.p12'],
  [/^id_rsa/i, 'id_rsa*'],
  [/^id_ed25519/i, 'id_ed25519*'],
  [/^\.npmrc$/i, '.npmrc'],
  [/^\.netrc$/i, '.netrc'],
  [/^credentials(\.(json|ya?ml|txt|ini))?$/i, 'credentials*'],
  [/\.sqlite$/i, '*.sqlite'],
];

function patternFor(relPath: string, extra: string[]): string | undefined {
  const segs = relPath.split('/');
  for (const seg of segs) if (IGNORE_DIRS.has(seg)) return `${seg}/`;
  const base = segs[segs.length - 1];
  for (const [re, pattern] of IGNORE_FILES) if (re.test(base)) return pattern;
  for (const e of extra) {
    const pat = e.trim();
    if (!pat) continue;
    if (pat.endsWith('/') ? segs.includes(pat.slice(0, -1)) : globMatch(pat, base) || globMatch(pat, relPath)) return pat;
  }
  return undefined;
}

/** Minimal glob: `*` matches within a path segment, `?` one char. */
function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
  return re.test(value);
}

export interface GitignoreGuard {
  /** Ignore patterns appended to .gitignore. */
  added: string[];
  /** Untracked files now covered by an ignore pattern (excluded from the commit). */
  ignored: string[];
  /** Untracked files that look like normal work and will be committed. */
  committed: string[];
}

/**
 * Before `git add -A`, keep obviously ephemeral or secret untracked files out of the commit by adding
 * their patterns to .gitignore. Anything that is not recognised as ephemeral is treated as real work
 * and committed (agent-created source files must still land). Never throws.
 */
export function guardGitignore(root: string, opts: { enabled?: boolean; extra?: string[] } = {}): GitignoreGuard {
  const out: GitignoreGuard = { added: [], ignored: [], committed: [] };
  if (opts.enabled === false) return out;
  let untracked: string[];
  try { untracked = untrackedFiles(root); } catch { return out; }
  if (!untracked.length) return out;

  const extra = opts.extra ?? [];
  const patterns = new Set<string>();
  for (const f of untracked) {
    const p = patternFor(f, extra);
    if (p) { patterns.add(p); out.ignored.push(f); }
    else out.committed.push(f);
  }
  if (!patterns.size) return out;

  const path = join(root, '.gitignore');
  const list = [...patterns].sort();
  try {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const missing = list.filter((p) => !have.has(p));
    if (missing.length) {
      const prefix = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
      appendFileSync(path, `${prefix}# added by symphony (ephemeral/secret files)\n${missing.join('\n')}\n`);
      out.added = missing;
    }
  } catch {
    return { added: [], ignored: [], committed: untracked };
  }
  return out;
}

export type CommitOutcome =
  | { status: 'clean' }
  | { status: 'committed'; sha: string; files: number }
  | { status: 'failed'; detail: string };

/**
 * The literal subject prefix a task's commits start with, derived from the configured commit message
 * template: `{id}: {title} [{status}]` → `T05: `. Used to find a task's commits for `reset --revert`
 * even when the template has been customised. Undefined when the template does not contain `{id}`.
 */
export function commitPrefix(template: string, id: string): string | undefined {
  const i = template.indexOf('{id}');
  if (i === -1) return undefined;
  const before = template.slice(0, i);
  // A placeholder before {id} means the subject has no literal prefix to match on.
  if (before.includes('{')) return undefined;
  const after = template.slice(i + 4);
  const next = after.indexOf('{');
  return `${before}${id}${next === -1 ? after : after.slice(0, next)}`;
}

/** `git add -A && git commit` when the tree is dirty. Never pushes. */
export function commitAll(root: string, message: string, log?: (m: string) => void, opts: { autoIgnoreUntracked?: boolean; extraIgnore?: string[]; expectedBranch?: string } = {}): CommitOutcome {
  if (opts.expectedBranch !== undefined) {
    const branch = currentBranch(root);
    if (branch !== opts.expectedBranch) {
      return { status: 'failed', detail: `branch changed from ${opts.expectedBranch} to ${branch}; refusing to commit (an agent session switched branches)` };
    }
  }
  const guard = guardGitignore(root, { enabled: opts.autoIgnoreUntracked, extra: opts.extraIgnore });
  if (guard.added.length && log) log(`auto-ignored ephemeral/secret files via .gitignore: ${guard.added.join(', ')}`);
  if (guard.committed.length && log) log(`committing ${guard.committed.length} untracked file(s): ${guard.committed.slice(0, 8).join(', ')}${guard.committed.length > 8 ? ', …' : ''}`);

  const files = dirtyFiles(root);
  if (files.length === 0) return { status: 'clean' };
  const add = git(root, ['add', '-A']);
  if (add.code !== 0) return { status: 'failed', detail: `git add: ${add.stderr.slice(0, 300)}` };
  const commit = git(root, ['commit', '-q', '-m', message]);
  if (commit.code !== 0) return { status: 'failed', detail: `git commit: ${(commit.stderr || commit.stdout).slice(0, 300)}` };
  const sha = git(root, ['rev-parse', '--short', 'HEAD']).stdout;
  return { status: 'committed', sha, files: files.length };
}

/** Full commit hashes whose subject starts with `prefix` (default `<id>:`), newest first. Used by `reset --revert`. */
export function commitsForTask(root: string, id: string, prefix = `${id}:`): string[] {
  const r = git(root, ['log', '--format=%H%x09%s']);
  if (r.code !== 0 || !r.stdout) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([, subject]) => subject?.startsWith(prefix))
    .map(([sha]) => sha);
}

export function describeCommit(c: CommitOutcome): string {
  switch (c.status) {
    case 'clean': return 'clean (nothing to commit)';
    case 'committed': return `committed ${c.sha} (${c.files} file${c.files === 1 ? '' : 's'})`;
    case 'failed': return `commit failed: ${c.detail}`;
  }
}

/** Append missing entries to <root>/.gitignore. Returns the entries added. */
export function ensureGitignore(root: string, entries: string[], comment = 'symphony harness (local tool, not tracked)'): string[] {
  const path = join(root, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !have.has(e));
  if (missing.length === 0) return [];
  const prefix = existing.length && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(path, `${prefix}${existing.length ? '\n' : ''}# ${comment}\n${missing.join('\n')}\n`);
  return missing;
}
