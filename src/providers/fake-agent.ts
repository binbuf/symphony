/* Standalone script spawned by the fake provider. No imports from the rest of the harness. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const fixture = process.argv[2];
if (!fixture || !existsSync(fixture)) {
  process.stderr.write(`fake-agent: fixture not found: ${fixture}\n`);
  process.exit(2);
}
// Drain stdin (the prompt) like a real CLI would.
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let exitCode = 0;
for (const line of readFileSync(fixture, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let ev: Record<string, unknown> | undefined;
  try { ev = JSON.parse(line) as Record<string, unknown>; } catch { /* not JSON: echo */ }
  if (ev && typeof ev.type === 'string' && ev.type.startsWith('fake_')) {
    if (ev.type === 'fake_write' && typeof ev.path === 'string') {
      const p = join(process.cwd(), ev.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, String(ev.content ?? ''));
    } else if (ev.type === 'fake_rm' && typeof ev.path === 'string') {
      rmSync(join(process.cwd(), ev.path), { recursive: true, force: true });
    } else if (ev.type === 'fake_stderr') {
      process.stderr.write(`${String(ev.text ?? '')}\n`);
    } else if (ev.type === 'fake_sleep') {
      await wait(Number(ev.ms ?? 0));
    } else if (ev.type === 'fake_run') {
      // Run a shell command in the project (used by tests to simulate e.g. an agent switching branches).
      const r = spawnSync(String(ev.command ?? ''), { shell: true, cwd: process.cwd(), encoding: 'utf8' });
      if (r.stdout) process.stdout.write(String(r.stdout));
      if (r.stderr) process.stderr.write(String(r.stderr));
      if (r.status !== 0) exitCode = r.status ?? 1;
    } else if (ev.type === 'fake_exit') {
      exitCode = Number(ev.code ?? 0);
    }
    continue;
  }
  process.stdout.write(`${line}\n`);
  await wait(5);
}
process.exit(exitCode);
