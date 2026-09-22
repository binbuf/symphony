import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { VERSION, main } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { UsageError } from '../src/util.js';

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const stream = process.stdout as unknown as { write(chunk: string | Uint8Array): boolean };
  const original = stream.write.bind(process.stdout);
  stream.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  try {
    const code = await fn();
    return { code, out: chunks.join('') };
  } finally {
    stream.write = original;
  }
}

test('--version prints the package version without touching a project', async () => {
  const { code, out } = await capture(() => main(['--version']));
  assert.equal(code, 0);
  assert.equal(out.trim(), VERSION);
});

test('numeric flags and unknown commands fail with a UsageError before anything runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-cli-'));
  await assert.rejects(main(['run', '--root', dir, '--timeout-min', '0']), (e: unknown) => e instanceof UsageError && /--timeout-min/.test((e as Error).message));
  await assert.rejects(main(['run', '--root', dir, '--max-cost=-1']), (e: unknown) => e instanceof UsageError && /--max-cost/.test((e as Error).message));
  await assert.rejects(main(['run', '--root', dir, '--budget', 'abc']), (e: unknown) => e instanceof UsageError && /--budget/.test((e as Error).message));
  await assert.rejects(main(['frobnicate', '--root', dir]), (e: unknown) => e instanceof UsageError && /unknown command/.test((e as Error).message));
});

test('logs prints a task log, and lists logs when given no id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-cli-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  const paths = resolvePaths(dir);
  mkdirSync(join(paths.docs, 'logs'), { recursive: true });
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(paths.roadmap, '# R\n\n## Phase 1\n\n- [x] T01 — One\n');
  writeFileSync(paths.progress, '# Progress notes\n');
  writeFileSync(join(paths.docs, 'logs', 'T01.md'), '# T01 — One\n\nStatus: done\n');

  const one = await capture(() => main(['logs', 'T01', '--root', dir]));
  assert.equal(one.code, 0);
  assert.match(one.out, /--- docs\/logs\/T01\.md ---/);
  assert.match(one.out, /Status: done/);

  const list = await capture(() => main(['logs', '--root', dir]));
  assert.equal(list.code, 0);
  assert.match(list.out, /docs\/logs\/T01\.md/);

  await assert.rejects(main(['logs', 'T99', '--root', dir]), (e: unknown) => e instanceof UsageError && /no such task/.test((e as Error).message));
});