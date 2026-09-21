import { spawnSync } from 'node:child_process';
import type { Config } from './config.js';

export type HookName = 'afterTask' | 'onHalt' | 'onBlocked' | 'onRunEnd';

const HOOK_TIMEOUT_MS = 120_000;

/**
 * Run a configured lifecycle hook as a shell command. Hooks are fire-and-forget from the pipeline's
 * point of view: a missing command, a non-zero exit or a throw only warns, never fails the run.
 * The event is passed through the environment so hooks stay integration-agnostic.
 */
export function fireHook(config: Config, name: HookName, vars: Record<string, string>, warn: (m: string) => void): void {
  const command = config.hooks?.[name];
  if (!command) return;
  try {
    const r = spawnSync(command, {
      cwd: vars.SYMPHONY_ROOT,
      shell: true,
      encoding: 'utf8',
      timeout: HOOK_TIMEOUT_MS,
      env: { ...process.env, ...vars },
    });
    if (r.error) warn(`hook ${name} could not run: ${r.error.message}`);
    else if (r.status !== 0) warn(`hook ${name} exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
  } catch (e) {
    warn(`hook ${name} threw: ${(e as Error).message}`);
  }
}
