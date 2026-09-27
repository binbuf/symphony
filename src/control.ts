import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Paths } from './paths.js';
import { atomicWriteSync, ensureDir, nowIso, sleep } from './util.js';

/**
 * The file-based control channel a detached harness exposes to clients (`symphony attach`, `stop`).
 * A client drops a `req-<id>.json` into `.symphony/control/`; the daemon polls that directory at safe
 * points, applies the command to the live run context, and writes a matching `res-<id>.json`. Files
 * are the transport on purpose: they work identically on every platform, need no ports or sockets, and
 * inherit the project's permissions.
 */

export type ControlAction = 'pause' | 'resume' | 'pause-at' | 'wrap-up' | 'accept' | 'split' | 'clear-halt' | 'watch' | 'stop';

export interface ControlRequest {
  id: string;
  action: ControlAction;
  args?: Record<string, unknown>;
  at: string;
}

export interface ControlResponse {
  id: string;
  ok: boolean;
  code?: number;
  message?: string;
  at: string;
}

export function controlDir(paths: Paths): string {
  return join(paths.symphony, 'control');
}

const reqPath = (paths: Paths, id: string): string => join(controlDir(paths), `req-${id}.json`);
const resPath = (paths: Paths, id: string): string => join(controlDir(paths), `res-${id}.json`);

let seq = 0;

/** Write a request and return its id. Fire-and-forget callers can ignore the response. */
export function submitControl(paths: Paths, action: ControlAction, args?: Record<string, unknown>): string {
  ensureDir(controlDir(paths));
  const id = `${process.pid}-${Date.now().toString(36)}-${++seq}`;
  atomicWriteSync(reqPath(paths, id), `${JSON.stringify({ id, action, args, at: nowIso() } satisfies ControlRequest)}\n`);
  return id;
}

/** Wait for a request's response, consuming it. Returns undefined on timeout. */
export async function awaitControl(paths: Paths, id: string, timeoutMs = 5000, signal?: AbortSignal): Promise<ControlResponse | undefined> {
  const file = resPath(paths, id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        const res = JSON.parse(readFileSync(file, 'utf8')) as ControlResponse;
        try { unlinkSync(file); } catch { /* already consumed */ }
        return res;
      } catch {
        /* a partial write races the rename; try again next tick */
      }
    }
    if (signal?.aborted) break;
    await sleep(80, signal);
  }
  // The daemon never answered; drop the request so it is not replayed on the next poll.
  try { unlinkSync(reqPath(paths, id)); } catch { /* never queued or already handled */ }
  return undefined;
}

/** Send a command and wait for its acknowledgement (used by the CLI, not the TUI hot path). */
export async function sendControl(paths: Paths, action: ControlAction, args?: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ControlResponse | undefined> {
  const id = submitControl(paths, action, args);
  return awaitControl(paths, id, opts.timeoutMs, opts.signal);
}

/** Fire a command without waiting for the answer; the response is consumed in the background. */
export function dispatchControl(paths: Paths, action: ControlAction, args?: Record<string, unknown>): void {
  const id = submitControl(paths, action, args);
  void awaitControl(paths, id, 10_000).catch(() => { /* advisory */ });
}

/** The daemon side of the channel: poll, apply, acknowledge. */
export class ControlServer {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly busy = new Set<string>();

  constructor(private readonly paths: Paths, private readonly handler: (req: ControlRequest) => Promise<ControlResponse>) {}

  start(pollMs = 250): void {
    ensureDir(controlDir(this.paths));
    // Requests left over from a previous run can never be answered; clear them so a client that
    // emailed a dead daemon does not have its command replayed against this one.
    this.clearStale();
    this.timer = setInterval(() => void this.poll(), pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clearStale();
  }

  private clearStale(): void {
    const dir = controlDir(this.paths);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith('req-') || name.startsWith('res-')) {
        try { unlinkSync(join(dir, name)); } catch { /* ignore */ }
      }
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    const dir = controlDir(this.paths);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (this.stopped) return;
      if (!name.startsWith('req-') || !name.endsWith('.json')) continue;
      const id = name.slice(4, -5);
      if (this.busy.has(id)) continue;
      const file = join(dir, name);
      let req: ControlRequest;
      try {
        req = JSON.parse(readFileSync(file, 'utf8')) as ControlRequest;
        if (!req || typeof req.action !== 'string') throw new Error('bad request');
      } catch {
        try { unlinkSync(file); } catch { /* ignore */ }
        continue;
      }
      this.busy.add(id);
      let res: ControlResponse;
      try {
        res = await this.handler({ ...req, id });
      } catch (e) {
        res = { id, ok: false, code: 1, message: (e as Error).message, at: nowIso() };
      }
      try { atomicWriteSync(resPath(this.paths, id), `${JSON.stringify(res)}\n`); } catch { /* client gave up */ }
      try { unlinkSync(file); } catch { /* ignore */ }
      this.busy.delete(id);
    }
  }
}