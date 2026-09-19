import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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

export function currentBranch(root: string): string {
  const r = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.code === 0 ? r.stdout : '(no commits)';
}

export function dirtyFiles(root: string): string[] {
  const r = git(root, ['status', '--porcelain']);
  return r.code === 0 && r.stdout ? r.stdout.split('\n').filter(Boolean) : [];
}

export type CommitOutcome =
  | { status: 'clean' }
  | { status: 'committed'; sha: string; files: number }
  | { status: 'failed'; detail: string };

/** `git add -A && git commit` when the tree is dirty. Never pushes. */
export function commitAll(root: string, message: string): CommitOutcome {
  const files = dirtyFiles(root);
  if (files.length === 0) return { status: 'clean' };
  const add = git(root, ['add', '-A']);
  if (add.code !== 0) return { status: 'failed', detail: `git add: ${add.stderr.slice(0, 300)}` };
  const commit = git(root, ['commit', '-q', '-m', message]);
  if (commit.code !== 0) return { status: 'failed', detail: `git commit: ${(commit.stderr || commit.stdout).slice(0, 300)}` };
  const sha = git(root, ['rev-parse', '--short', 'HEAD']).stdout;
  return { status: 'committed', sha, files: files.length };
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
