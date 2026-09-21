import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RunSinks } from './logger.js';
import type { ClassifyHints, NormalizedEvent, Provider, ResultEvent, SpawnSpec } from './providers/types.js';
import { renderEvent } from './render.js';

export type KillReason = 'timeout' | 'stall' | 'interrupt';

export interface SessionOpts {
  spec: SpawnSpec;
  provider: Provider;
  cwd: string;
  timeoutMs: number;
  /** 0 disables stall detection. */
  idleTimeoutMs: number;
  sinks: RunSinks;
  liveMaxChars: number;
  logMaxChars: number;
  color: boolean;
  /** Set false to keep stdout quiet (tests). */
  live?: boolean;
}

export interface SessionOutcome {
  result: ResultEvent;
  sessionId?: string;
  model?: string;
  /** All assistant text, in order. The result block is searched here when the result text lacks it. */
  allText: string;
  costUsd?: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stalled: boolean;
  interrupted: boolean;
  spawnError?: string;
  stderrTail: string;
  durationMs: number;
  hints: ClassifyHints;
  sawResult: boolean;
  sawError: boolean;
}

export interface Session {
  pid?: number;
  done: Promise<SessionOutcome>;
  kill(reason: KillReason): void;
}

const STDERR_RING_BYTES = 2048;
const KILL_GRACE_MS = 10_000;

/**
 * Spawn one agent process and stream its NDJSON. stdout and stderr are read on separate pipes so the
 * .jsonl stays pure NDJSON; the child gets its own process group so the whole tree can be killed.
 */
export function startSession(o: SessionOpts): Session {
  const t0 = Date.now();
  const parser = o.provider.createParser();
  const detached = process.platform !== 'win32';
  const flags = { timedOut: false, stalled: false, interrupted: false };
  let spawnError: string | undefined;
  let sessionId: string | undefined;
  let model: string | undefined;
  let costUsd: number | undefined;
  let result: ResultEvent | undefined;
  let sawError = false;
  const texts: string[] = [];
  let stderrTail = '';

  let child: ChildProcess;
  try {
    child = spawn(o.spec.bin, o.spec.args, {
      cwd: o.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached,
      env: { ...process.env, ...(o.spec.env ?? {}) },
    });
  } catch (e) {
    // Some launch failures (notably ENAMETOOLONG on Windows) are thrown synchronously by spawn()
    // instead of emitting 'error'. Contain them so one bad launch cannot abort the whole run.
    const spawnError = e instanceof Error ? e.message : String(e);
    const result: ResultEvent = { kind: 'result', ok: false, text: '', errorSubtype: 'spawn_error', synthesized: true };
    const outcome: SessionOutcome = {
      result, allText: '', costUsd: undefined, exitCode: null, signal: null,
      timedOut: false, stalled: false, interrupted: false, spawnError, stderrTail: '',
      durationMs: Date.now() - t0, hints: parser.hints(), sawResult: false, sawError: false,
    };
    const line = `[error] could not start provider: ${spawnError}`;
    if (o.live !== false) process.stdout.write(`${line}\n`);
    o.sinks.log.write(`${line}\n`);
    return { done: Promise.resolve(outcome), kill: () => {} };
  }
  const pid = child.pid;

  const signalTree = (sig: NodeJS.Signals) => {
    if (process.platform === 'win32') {
      // Windows has no process groups; taskkill /T walks the child tree.
      try {
        if (sig === 'SIGKILL') spawn('taskkill', ['/pid', String(pid ?? 0), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
        else child.kill();
      } catch {
        try { child.kill(); } catch { /* already gone */ }
      }
      return;
    }
    try {
      if (detached && pid) process.kill(-pid, sig);
      else child.kill(sig);
    } catch {
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };

  let killTimer: NodeJS.Timeout | undefined;
  const kill = (reason: KillReason) => {
    if (reason === 'timeout') flags.timedOut = true;
    else if (reason === 'stall') flags.stalled = true;
    else flags.interrupted = true;
    signalTree('SIGTERM');
    if (!killTimer) {
      killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) signalTree('SIGKILL'); }, KILL_GRACE_MS);
    }
  };

  const wall = setTimeout(() => kill('timeout'), o.timeoutMs);
  let idle: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    if (idle) clearTimeout(idle);
    if (o.idleTimeoutMs > 0) idle = setTimeout(() => kill('stall'), o.idleTimeoutMs);
  };
  resetIdle();

  const emit = (ev: NormalizedEvent) => {
    switch (ev.kind) {
      case 'init': sessionId = ev.sessionId || sessionId; model = ev.model ?? model; break;
      case 'text': texts.push(ev.text); break;
      case 'error': sawError = true; break;
      case 'result':
        result = ev;
        sessionId = ev.sessionId ?? sessionId;
        if (ev.costUsd !== undefined) costUsd = ev.costUsd;
        break;
      default: break;
    }
    if (o.live !== false) {
      const live = renderEvent(ev, { maxChars: o.liveMaxChars, color: o.color });
      if (live) process.stdout.write(`${live}\n`);
    }
    const full = renderEvent(ev, { maxChars: o.logMaxChars, color: false, multiline: true });
    if (full) o.sinks.log.write(`${full}\n`);
  };

  child.stdin?.on('error', () => { /* EPIPE when the child does not read stdin */ });
  child.stdin?.end(o.spec.stdinPayload ?? '');

  // Interfaces are created up front so a spawn failure can close them; a readline iterator over a
  // destroyed stream would otherwise never finish and the session promise would hang.
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  const rlOut = child.stdout ? createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false }) : undefined;
  const rlErr = child.stderr ? createInterface({ input: child.stderr, crlfDelay: Infinity, terminal: false }) : undefined;

  const readStdout = async () => {
    if (!rlOut) return;
    for await (const line of rlOut) {
      resetIdle();
      o.sinks.jsonl.write(`${line}\n`);
      if (!line.trim()) continue;
      const events = line.trimStart().startsWith('{') ? parser.parse(line) : [{ kind: 'raw', text: line, stream: 'stdout' } satisfies NormalizedEvent];
      for (const ev of events) emit(ev);
    }
  };

  const readStderr = async () => {
    if (!rlErr) return;
    for await (const line of rlErr) {
      resetIdle();
      if (!line.trim()) continue;
      stderrTail = `${stderrTail}${line}\n`;
      if (stderrTail.length > STDERR_RING_BYTES) stderrTail = stderrTail.slice(-STDERR_RING_BYTES);
      emit({ kind: 'raw', text: line, stream: 'stderr' });
    }
  };

  const closed = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    child.once('close', finish);
    child.once('error', (e) => {
      spawnError = e.message;
      rlOut?.close();
      rlErr?.close();
      child.stdout?.destroy();
      child.stderr?.destroy();
      // 'close' does not always follow a spawn failure. (Not unref'd: it may be the only thing keeping the loop alive.)
      setTimeout(finish, 50);
    });
  });

  const done = (async (): Promise<SessionOutcome> => {
    await Promise.all([readStdout().catch(() => {}), readStderr().catch(() => {}), closed]);
    clearTimeout(wall);
    if (idle) clearTimeout(idle);
    if (killTimer) clearTimeout(killTimer);
    const exitCode = child.exitCode;
    const signal = child.signalCode;
    const hints = parser.hints();
    if (costUsd === undefined && hints.costUsd !== undefined) costUsd = hints.costUsd;
    const sawResult = result !== undefined;
    if (!result) {
      result = {
        kind: 'result',
        ok: exitCode === 0 && !sawError && !flags.timedOut && !flags.stalled && !flags.interrupted && !spawnError,
        text: texts.join('\n'),
        sessionId,
        costUsd,
        errorSubtype: spawnError ? 'spawn_error' : flags.timedOut ? 'timeout' : flags.stalled ? 'stall' : flags.interrupted ? 'interrupted' : exitCode ? `exit_${exitCode}` : signal ?? undefined,
        synthesized: true,
      };
      emit(result);
    }
    return {
      result,
      sessionId,
      model,
      allText: texts.join('\n'),
      costUsd,
      exitCode,
      signal,
      timedOut: flags.timedOut,
      stalled: flags.stalled,
      interrupted: flags.interrupted,
      spawnError,
      stderrTail: stderrTail.trim(),
      durationMs: Date.now() - t0,
      hints,
      sawResult,
      sawError,
    };
  })();

  return { pid, done, kill };
}
