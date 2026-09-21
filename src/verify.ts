import { spawnSync } from 'node:child_process';

export interface VerifyResult {
  ok: boolean;
  code: number | null;
  output: string;
}

/**
 * Run the task's verify command in the project root. This is the harness's own acceptance check,
 * independent of what the agent claimed: a non-zero exit (or a timeout) means the task is not done.
 */
export function runVerify(root: string, command: string, timeoutMs: number): VerifyResult {
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: timeoutMs, env: process.env });
  } catch (e) {
    return { ok: false, code: null, output: `could not run verify command: ${(e as Error).message}` };
  }
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const timedOut = r.error !== undefined && String((r.error as NodeJS.ErrnoException).code ?? '').includes('ETIMEDOUT');
  if (timedOut) return { ok: false, code: null, output: `${output}\n[verify timed out after ${Math.round(timeoutMs / 60_000)} min]`.trim() };
  if (r.error) return { ok: false, code: null, output: `${output}\n[verify could not run: ${r.error.message}]`.trim() };
  return { ok: r.status === 0, code: r.status, output };
}
