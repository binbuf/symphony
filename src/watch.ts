import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveWatch, type Config, type SessionSpec } from './config.js';
import { parseProgressSections } from './context.js';
import { openRunSinks } from './logger.js';
import { rel, type Paths } from './paths.js';
import { getProvider, variantSupported } from './providers/index.js';
import type { Provider } from './providers/types.js';
import type { RunContext } from './runner.js';
import { notifyTaskSlack, slackEventEnabled, slackProject } from './slack.js';
import { startSession, type Session, type SessionOutcome } from './session.js';
import { buildStatusTable } from './status.js';
import { DONE_STATES, type State } from './state.js';
import type { Task } from './tasks.js';
import { ensureDir, fmtCost, fmtDateTime, fmtDuration, nowIso, resolveBinary, resolveExecutable, squash, stamp } from './util.js';

/**
 * Pipeline watch: a separate, read-only LLM session the harness runs on a timer while `run` is in
 * flight. It reads a self-contained snapshot of the pipeline (current task, phase progress, task
 * outcomes, PROGRESS.md, counts) and adds the interpretation the TUI's live status table cannot show
 * — what the snapshot means for the run, where it looks fragile, what to expect next — rather than
 * restating the visible status. When it has nothing useful to add it replies `NO_UPDATE` and the
 * panel keeps its previous summary. The latest answer is shown in the TUI's top panel and every
 * check is appended to a dedicated watch log. It is advisory: an unavailable provider or a failed
 * check only updates the panel, never the run.
 */

export type WatchStatus = 'waiting' | 'running' | 'ready' | 'error';

export interface WatchState {
  status: WatchStatus;
  /** Whether the watcher is configured on. */
  enabled: boolean;
  intervalMin: number;
  provider: string;
  model?: string;
  /** Latest summary, shown in the panel. */
  summary?: string;
  /** When the last successful check finished (ISO). */
  updatedAt?: string;
  /** When the next check is due (epoch ms), for the panel countdown. */
  nextAt?: number;
  /** Why the last check failed, or why the watcher is off. */
  error?: string;
  /** Completed checks this run. */
  checks: number;
}

export interface WatchLogEntry {
  at: string;
  check: number;
  provider: string;
  model?: string;
  /** `ready` when the check produced a summary, else `error`. */
  status: 'ready' | 'error';
  /** True when the watcher deliberately had nothing to add (`NO_UPDATE`). */
  silent?: boolean;
  pipeline: string;
  summary?: string;
  error?: string;
  durationS?: number;
  costUsd?: number;
  sessionLog: string;
  sessionJsonl: string;
  sessionPrompt: string;
}

const WATCH_TASK_ID = 'watch';
/** The token the watcher replies with when it has nothing useful to add (keeps the panel quiet). */
const WATCH_NO_UPDATE = 'NO_UPDATE';

/**
 * Conversational openers the watcher sometimes leads with ("I looked into that and…", "Based on the
 * logs…"). They are pure filler in the panel, so they are stripped before the summary is shown or
 * logged. Each tries to consume the whole leading clause (through its sentence punctuation, a
 * comma/colon, or a following "and"/"but") and only fires when something follows.
 */
const WATCH_PREAMBLE_PATTERNS = [
  /^(?:sure|okay|ok|alright|certainly|got it|understood|of course)[\s,!.]+/i,
  /^i(?:'ve| have)?\s+(?:looked|checked|reviewed|examined|scanned|dug|went through|took a look)\b[^.!?]{0,200}?(?:[.!?]|[;,:]\s*(?:and\s+|but\s+)?|\s+(?:and|but)\s+)/i,
  /^(?:looking|based on|after (?:reviewing|checking|looking)|reviewing|examining|checking|here(?:'s| is))\b[^.!?]{0,200}?(?:[.!?]|[;,:]\s*(?:and\s+|but\s+)?|\s+(?:and|but)\s+)/i,
  /^(?:it|this)\s+(?:looks|seems|appears)\s+(?:like|that)\s+/i,
];

/** Strip a conversational preamble from a watcher answer, falling back to the original if it empties it. */
export function cleanWatchSummary(text: string): string {
  const original = text.trim();
  let out = original;
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const re of WATCH_PREAMBLE_PATTERNS) {
      const next = out.replace(re, '').trim();
      if (next && next !== out) { out = next; changed = true; break; }
    }
    if (!changed) break;
  }
  return out || original;
}

/** The dedicated append-only log beside the harness log (`.symphony/watch.log`, or the set's dir). */
export function watchLogPath(paths: Paths): string {
  return join(dirname(paths.log), 'watch.log');
}

function statusOf(state: State, t: Task): string {
  return state.tasks[t.id]?.status ?? 'pending';
}

/** A one-line pipeline snapshot for the log and the prompt header. */
export function pipelineSnapshot(ctx: RunContext): string {
  const { tasks, state } = ctx;
  const table = buildStatusTable(tasks, state, { timeZone: ctx.config.timeZone });
  const s = table.summary;
  const ids = (pick: (st: string) => boolean): string => tasks.filter((t) => pick(statusOf(state, t))).map((t) => t.id).join(',') || 'none';
  const bits = [
    `${s.done}/${s.total} done`,
    `running ${ids((st) => st === 'running')}`,
    `blocked ${ids((st) => st === 'blocked')}`,
    `failed ${ids((st) => st === 'failed')}`,
    `${fmtCost(s.costUsd)} · ${fmtDuration(s.durationS)}`,
  ];
  if (state.halted) bits.push(`HALTED ${state.halted.category}${state.halted.taskId ? ` on ${state.halted.taskId}` : ''}`);
  return bits.join(' · ');
}

/** How many PROGRESS.md sections the first check inlines before switching to pure deltas. */
const WATCH_BOOTSTRAP_SECTIONS = 3;
/** Byte cap for the inlined new progress notes. */
const WATCH_PROGRESS_BYTES = 5000;
/** Cap on task outcomes inlined for one window. */
const WATCH_MAX_OUTCOMES = 12;

/**
 * The delta window for one watch check: only work that landed since the previous check is inlined, so
 * the prompt's size tracks the interval, not the length of the run. `sinceMs` bounds task outcomes;
 * `progressFrom` is the PROGRESS.md section index to resume from (earlier sections were already
 * summarised and are omitted). Omit either to fall back to the newest interval / newest few sections.
 */
export interface WatchWindow {
  /** Epoch ms: tasks that finished after this are inlined. Defaults to one watch interval ago. */
  sinceMs?: number;
  /** First PROGRESS.md section (0-based) to inline; earlier ones are treated as already summarised. */
  progressFrom?: number;
}

/** Number of PROGRESS.md sections, used to resume the next check's progress delta. */
export function progressSectionCount(path: string): number {
  try {
    return existsSync(path) ? parseProgressSections(readFileSync(path, 'utf8')).length : 0;
  } catch {
    return 0;
  }
}

/** Keep the newest `maxBytes` of an append-only text (the tail), so a long window stays bounded. */
function capTailBytes(text: string, maxBytes: number): string {
  const t = text.trim();
  if (Buffer.byteLength(t, 'utf8') <= maxBytes) return t;
  const buf = Buffer.from(t, 'utf8');
  return buf.subarray(buf.length - maxBytes).toString('utf8').trim();
}

/**
 * The watcher prompt: a compact current-status header plus what changed since the previous check —
 * the tasks that finished in that window, the progress notes written in it, and the relative path of
 * the latest task's own session log, which the watcher is asked to read (its one permitted action) —
 * so a check costs about the same whether the run is five minutes or five hours old. The instructions
 * frame the header as context the operator can already see and ask only for a read the status table
 * cannot give: is the task in flight healthy or struggling, is the current phase/gate on track, and is
 * the run as a whole likely to finish as anticipated.
 */
export function buildWatchPrompt(ctx: RunContext, window: WatchWindow = {}): string {
  const { paths, tasks, state } = ctx;
  const intervalMs = Math.max(1, ctx.config.watch.intervalMin) * 60_000;
  const sinceMs = window.sinceMs ?? Date.now() - intervalMs;
  const sinceLabel = fmtDateTime(new Date(sinceMs).toISOString(), ctx.config.timeZone);

  const finished = tasks
    .filter((t) => state.tasks[t.id]?.finished)
    .sort((a, b) => (Date.parse(state.tasks[b.id]?.finished ?? '') || 0) - (Date.parse(state.tasks[a.id]?.finished ?? '') || 0));

  // Status only, no summaries: summaries are the logs, and older ones were already reported by an
  // earlier check, so repeating them would grow the prompt with the length of the run.
  const taskLines = tasks.slice(0, 40).map((t) => {
    const st = state.tasks[t.id];
    return `- ${t.id} [${st?.status ?? 'pending'}] ${squash(t.title, 60)}`;
  });

  // Only outcomes that finished inside this window are inlined; the rest were already summarised.
  const recent = finished.filter((t) => (Date.parse(state.tasks[t.id]?.finished ?? '') || 0) > sinceMs).slice(0, WATCH_MAX_OUTCOMES);
  const outcomeLines = recent.map((t) => {
    const st = state.tasks[t.id];
    return `- ${t.id} [${st?.status ?? '?'}] ${squash(t.title, 80)}${st?.summary ? ` — ${squash(st.summary, 240)}` : ''}`;
  });

  // The ticket in flight, or the one that just finished when nothing is running.
  const currentTask = tasks.find((t) => statusOf(state, t) === 'running') ?? recent[0];
  const currentLine = (() => {
    if (!currentTask) return undefined;
    const st = state.tasks[currentTask.id];
    const status = st?.status ?? 'pending';
    const bits: string[] = [status];
    if (status === 'running') {
      const started = st?.started ? Date.parse(st.started) : NaN;
      const elapsedS = Number.isFinite(started) ? Math.max(0, (Date.now() - started) / 1000) : undefined;
      if (elapsedS !== undefined) bits.push(`running ${fmtDuration(elapsedS)}`);
      if (st?.attempts && st.attempts > 1) bits.push(`attempt ${st.attempts}`);
    } else if (st?.durationS) {
      bits.push(`took ${fmtDuration(st.durationS)}`);
    }
    if (st?.summary) bits.push(squash(st.summary, 300));
    if (st?.transientRetries) bits.push(`transient retries ${st.transientRetries}`);
    if (st?.lastError) bits.push(`last error ${st.lastError.category}${st.lastError.transient ? ' (transient)' : ''}: ${squash(st.lastError.message, 140)}`);
    if (st?.verify && !st.verify.ok) bits.push(`verify FAILED (${st.verify.command})`);
    return `- ${currentTask.id} — ${squash(currentTask.title, 100)} · phase: ${currentTask.phase} · ${bits.join(' · ')}`;
  })();

  // The relative path of the latest session log (the running task's, or the most recently finished
// one's). The watcher is asked to read that one file rather than have its contents inlined, which
// keeps the prompt small no matter how long the session runs.
  const latestLogTask = tasks.find((t) => statusOf(state, t) === 'running') ?? finished[0];
  const refs = latestLogTask ? state.tasks[latestLogTask.id]?.logs ?? [] : [];
  const latestRef = refs[refs.length - 1];
  const latestLogPath = latestLogTask && latestRef?.log ? latestRef.log : undefined;
  const latestLogLabel = latestLogPath
    ? `${latestLogTask!.id}'s latest session`
    : 'no task session yet';

  // Per-phase progress, with the current phase flagged, so the model can judge the gate we are in.
  const phaseStats = new Map<string, { done: number; total: number; remaining: string[] }>();
  for (const t of tasks) {
    const s = phaseStats.get(t.phase) ?? { done: 0, total: 0, remaining: [] };
    s.total += 1;
    if ((DONE_STATES as string[]).includes(state.tasks[t.id]?.status ?? 'pending')) s.done += 1;
    else s.remaining.push(t.id);
    phaseStats.set(t.phase, s);
  }
  const phaseLines = [...phaseStats.entries()].map(([name, s]) => {
    const mark = name === currentTask?.phase ? '▶ ' : '  ';
    return `${mark}${name}: ${s.done}/${s.total} done${s.remaining.length ? ` · remaining ${s.remaining.join(', ')}` : ' · complete'}`;
  });

  // Only PROGRESS.md sections written since the last check; the first check seeds the newest few.
  const sections = parseProgressSections(existsSync(paths.progress) ? readFileSync(paths.progress, 'utf8') : '');
  const from = window.progressFrom ?? Math.max(0, sections.length - WATCH_BOOTSTRAP_SECTIONS);
  const fresh = sections.slice(Math.max(0, from));
  const progress = fresh.length
    ? capTailBytes(fresh.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n'), WATCH_PROGRESS_BYTES)
    : '(no new progress notes since the last check)';

  return [
    'You are a read-only analyst of a live autonomous coding pipeline ("symphony"). The harness runs',
    'one fresh AI session per task in ROADMAP.md and commits after each. The operator is watching the',
    'run in a terminal that already shows, updating live: the task in flight and its elapsed time, the',
    'current phase and its progress, the done/total counts, the cost, and the full task list. Your',
    'answer is rendered verbatim in a small strip above that table.',
    '',
    'Each check gives you what changed since your last check — the tasks that finished in that window,',
    "the progress notes written in it, a compact current-status header, and the path of the latest task's",
    'session log. You may read that one file to see what the work is actually doing; it is the only file',
    'you are permitted to open. Judge the delta against the header; do not re-read old work or repeat',
    'what an earlier check already said.',
    '',
    'Your value is interpretation, not narration. Restating what the operator can already see — that a',
    'task is running, how long it has been running, which phase we are in, how many tasks are done —',
    'adds nothing. What the operator needs is a read on how it is actually going:',
    '',
    '- Is the task in flight healthy, or struggling? Read its log: is it working one thread to',
    '  completion, or looping, erroring, retrying, or fighting the same failing command? Say which, and',
    '  what it means for the outcome.',
    '- Is the current phase or milestone on track? Are the tasks inside it landing as expected, or is',
    '  one stubborn and likely to hold the gate open? Name what still stands between here and closing it.',
    '- Summarize the latest task log only as far as it supports that read — what the session is actually',
    '  doing, in plain terms, not a transcript and not a reworded version of its reported summary.',
    '- Is the run as a whole likely to finish as anticipated? If the pace, the retries, or the outcomes',
    '  point to a different end than planned, say so and why.',
    '',
    'Which of those matters most changes from check to check, so do not march through a checklist or',
    'answer all of them every time: pick the two or three things that are true and consequential right',
    'now, and skip the rest. When a task is struggling, a phase is at risk, or completion no longer',
    'looks likely, that is exactly what must lead.',
    '',
    'Hard rules:',
    '- Never narrate raw status or timing ("task N is running", "X minutes in", "just started", "N of M',
    '  done", "still early") — the operator already has that line. Characterizing the task itself is',
    '  wanted: what it is doing and whether that is normal.',
    '- Never say it is too early to tell, that there is not enough information, or otherwise hedge',
    '  about what you can know.',
    '- Never pad to fill the panel and never manufacture concern. Do not treat silence as the safe',
    '  default: a genuine observation is nearly always available. Reply with exactly NO_UPDATE and',
    '  nothing else only at the very start of a run — the first task is still in flight and nothing has',
    '  finished yet, so there is truly nothing to interpret. Once any task has finished, always give',
    '  your read rather than going quiet.',
    '- Begin directly with the observation. Do not open with a preamble or acknowledgement ("I looked',
    '  into…", "Looking at the snapshot…", "Based on the logs…", "It looks like…", "Sure,").',
    '- Ground every claim in the snapshot and in the task log you read; invent nothing. Your only',
    '  permitted action is reading the file named under LATEST TASK LOG — do not run commands, edit, or',
    '  read anything else. If that file cannot be read, base your read on the snapshot instead of',
    '  guessing at the log.',
    '',
    'Your update: 2 to 4 short sentences of plain prose. No headings, no bullet lists, no code fences.',
    '',
    '=== CURRENTLY RUNNING (or, if idle, most recently finished) — already visible to the operator ===',
    currentLine ?? '- (nothing running and nothing finished yet)',
    '',
    `=== LATEST TASK LOG (${latestLogLabel}) ===`,
    latestLogPath
      ? `Read this file (relative to the project root): ${latestLogPath}`
      : '- (no session log yet — nothing to read)',
    '',
    '=== PHASES / GATES (▶ marks the phase of the current task) ===',
    phaseLines.join('\n') || '- (no tasks)',
    '',
    `=== RECENT TASK OUTCOMES (finished since ${sinceLabel} — earlier work was already reported) ===`,
    outcomeLines.join('\n') || '- (no task finished in this window)',
    '',
    `=== NEW PROGRESS NOTES (${rel(paths.root, paths.progress)}, since ${sinceLabel}) ===`,
    progress,
    '',
    '=== PIPELINE SNAPSHOT (overall) ===',
    pipelineSnapshot(ctx),
    '',
    '=== TASK LIST (status only) ===',
    taskLines.join('\n') || '- (no tasks)',
    '=== END OF SNAPSHOT ===',
  ].join('\n');
}

/** Append one check's result to the dedicated watch log. Never throws at the caller. */
export function appendWatchLog(paths: Paths, entry: WatchLogEntry): void {
  const file = watchLogPath(paths);
  try {
    ensureDir(dirname(file));
    const lines: string[] = [];
    if (!existsSync(file)) {
      lines.push('# Pipeline watch log', '', '_Periodic read-only summaries written by the symphony pipeline watcher. One section per check._', '');
    }
    lines.push(`## ${entry.at} · check #${entry.check}`);
    lines.push('');
    lines.push(`- provider: ${entry.provider}${entry.model ? ` · ${entry.model}` : ''}`);
    lines.push(`- pipeline: ${entry.pipeline}`);
    lines.push(`- result: ${entry.status}${entry.silent ? ' (no update)' : ''}${entry.durationS !== undefined ? ` · ${fmtDuration(entry.durationS)}` : ''}${entry.costUsd !== undefined ? ` · ${fmtCost(entry.costUsd)}` : ''}`);
    if (entry.error) lines.push(`- error: ${entry.error}`);
    lines.push(`- session: ${entry.sessionLog} · raw: ${entry.sessionJsonl} · prompt: ${entry.sessionPrompt}`);
    lines.push('');
    lines.push(entry.silent ? '_(no update — nothing worth adding)_' : entry.summary?.trim() || '_(no summary produced)_');
    lines.push('');
    appendFileSync(file, `${lines.join('\n')}\n`);
  } catch {
    /* the watch log is advisory; a write failure must never affect the run */
  }
}

interface CheckResult {
  status: 'ready' | 'error';
  /** True when the watcher had nothing useful to add (`NO_UPDATE`). */
  silent?: boolean;
  summary?: string;
  error?: string;
  costUsd?: number;
  durationS?: number;
  sessionLog: string;
  sessionJsonl: string;
  sessionPrompt: string;
}

/** Run one read-only watcher session and capture its answer. */
async function oneCheck(ctx: RunContext, spec: SessionSpec, provider: Provider, window: WatchWindow): Promise<CheckResult> {
  ensureDir(ctx.paths.runs);
  const sinks = openRunSinks(ctx.paths.runs, `${WATCH_TASK_ID}-${stamp()}`);
  const prompt = buildWatchPrompt(ctx, window);
  writeFileSync(sinks.promptPath, prompt);
  const paths = {
    sessionLog: rel(ctx.paths.root, sinks.logPath),
    sessionJsonl: rel(ctx.paths.root, sinks.jsonlPath),
    sessionPrompt: rel(ctx.paths.root, sinks.promptPath),
  };
  const cmd = provider.buildCommand({
    bin: spec.bin, prompt, promptFile: sinks.promptPath, taskId: WATCH_TASK_ID, attempt: 1, kind: 'task',
    model: spec.model, variant: spec.variant, autoApprove: spec.autoApprove, readOnly: spec.readOnly, extraArgs: spec.extraArgs, cwd: ctx.paths.root,
  });
  const session = startSession({
    spec: cmd, provider, cwd: ctx.paths.root,
    timeoutMs: spec.timeoutMin * 60_000,
    idleTimeoutMs: spec.idleTimeoutMin ? spec.idleTimeoutMin * 60_000 : 0,
    sinks, liveMaxChars: 200, logMaxChars: 4000, color: false,
    // The watcher's own stream stays out of the live output panel: its result goes to the panel and log.
    live: false,
  });
  let outcome: SessionOutcome;
  try {
    outcome = await session.done;
  } finally {
    await sinks.close();
  }
  const durationS = Math.round(outcome.durationMs / 1000);
  const raw = (outcome.result.text || outcome.allText).trim();
  // Drop conversational openers ("I looked into…") before the answer is judged, shown or logged.
  const cleaned = cleanWatchSummary(raw);
  const failed = !outcome.result.ok || outcome.interrupted || outcome.timedOut || outcome.stalled || !!outcome.spawnError;
  // A deliberate, successful "nothing to add" keeps the panel quiet. Only an answer that is *exactly*
  // the token counts: if the model appends anything useful, it is kept as a summary instead of dropped.
  const silent = !failed && new RegExp(`^${WATCH_NO_UPDATE}[\\s.!]*$`, 'i').test(cleaned);
  if (silent) return { status: 'ready', silent: true, durationS, costUsd: outcome.costUsd, ...paths };
  if (!raw) {
    const error = failed
      ? outcome.spawnError ?? outcome.result.errorSubtype ?? (outcome.timedOut ? 'timeout' : outcome.stalled ? 'stalled' : 'no answer')
      : 'session produced no answer';
    return { status: 'error', error, durationS, costUsd: outcome.costUsd, ...paths };
  }
  // Room for the requested 2–4 sentences; the panel and log both cap their own display.
  return { status: 'ready', summary: squash(cleaned, 1200), durationS, costUsd: outcome.costUsd, ...paths };
}

/**
 * Owns the watcher timer and the in-flight session. `start()` arms the first check one interval out;
 * each check chains the next so a slow check never overlaps itself. `stop()` clears the timer and
 * interrupts a running check.
 */
export class PipelineWatcher {
  private timer?: NodeJS.Timeout;
  private session?: Session;
  private inFlight = false;
  private stopped = false;
  private checks = 0;
  /** Start of the current delta window: when the previous prompt was built. */
  private windowFromMs = Date.now();
  /** PROGRESS.md sections present at the previous summarised check, to resume the progress delta. */
  private progressSections?: number;

  constructor(private readonly ctx: RunContext, private readonly spec: SessionSpec, private readonly provider: Provider) {}

  private get intervalMs(): number {
    return Math.max(1, this.ctx.config.watch.intervalMin) * 60_000;
  }

  start(): void {
    this.ctx.abort.signal.addEventListener('abort', () => this.stop(), { once: true });
    this.arm(this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.session?.kill('interrupt');
  }

  /** Run a check now (the TUI's manual refresh) and re-arm the timer afterwards. */
  async checkNow(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.fire();
  }

  private arm(delayMs: number): void {
    if (this.stopped) return;
    const w = this.ctx.watch;
    if (w) w.nextAt = Date.now() + delayMs;
    this.timer = setTimeout(() => void this.fire(), delayMs);
    this.timer.unref?.();
  }

  private async fire(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.timer = undefined;
    this.inFlight = true;
    this.checks += 1;
    const w = this.ctx.watch;
    if (w) { w.status = 'running'; w.nextAt = undefined; }
    // Snapshot the window before the check: the previous start for what to inline, and the current
    // progress-section count so the next check resumes exactly here. Read synchronously so the count
    // matches what the prompt inlines in the same tick.
    const firedAt = Date.now();
    const sectionsAtBuild = progressSectionCount(this.ctx.paths.progress);
    let result: CheckResult;
    try {
      result = await oneCheck(this.ctx, this.spec, this.provider, { sinceMs: this.windowFromMs, progressFrom: this.progressSections });
    } catch (e) {
      result = { status: 'error', error: (e as Error).message, sessionLog: '-', sessionJsonl: '-', sessionPrompt: '-' };
    } finally {
      this.inFlight = false;
    }
    // Advance the window only after a check we actually summarised, so a failed check's window is
    // retried next time instead of being silently dropped.
    if (result.status === 'ready') {
      this.windowFromMs = firedAt;
      this.progressSections = sectionsAtBuild;
    }
    const state = this.ctx.watch;
    const entry: WatchLogEntry = {
      at: nowIso(), check: this.checks, provider: this.spec.providerName, model: this.spec.model,
      status: result.status, silent: result.silent, pipeline: pipelineSnapshot(this.ctx), summary: result.summary, error: result.error,
      durationS: result.durationS, costUsd: result.costUsd,
      sessionLog: result.sessionLog, sessionJsonl: result.sessionJsonl, sessionPrompt: result.sessionPrompt,
    };
    appendWatchLog(this.ctx.paths, entry);
    if (state && !this.stopped) {
      state.checks = this.checks;
      if (result.status === 'ready') {
        state.status = 'ready';
        // A silent check keeps the previous summary; the timestamp marks the refresh so the operator
        // can tell the watcher looked and had nothing new to add.
        if (result.summary) state.summary = result.summary;
        state.updatedAt = entry.at;
        delete state.error;
      } else {
        state.status = 'error';
        state.error = result.error ?? 'check failed';
        // Keep the last good summary visible alongside the error.
      }
    }
    // An in-progress Slack update for the task in flight, threaded under that task's taskStart
    // message. Feature-flagged (`slack.events.watch`, off by default) and only on a real summary, so
    // a NO_UPDATE reply or an idle pipeline stays quiet. Fire-and-forget: Slack must never delay the
    // next watch check.
    if (!this.stopped && result.status === 'ready' && result.summary && slackEventEnabled(this.ctx.config.slack, 'watch')) {
      const running = this.ctx.tasks.find((t) => (this.ctx.state.tasks[t.id]?.status ?? 'pending') === 'running');
      if (running) {
        void notifyTaskSlack(
          this.ctx.config.slack,
          (this.ctx.slackThreads ??= new Map()),
          {
            event: 'watch',
            project: slackProject(this.ctx.config.slack, this.ctx.paths.root),
            taskId: running.id,
            title: `${running.id} in progress — ${running.title}`,
            lines: [
              `watch #${this.checks} · ${this.spec.providerName}${this.spec.model ? ` · ${this.spec.model}` : ''}`,
              result.summary,
              entry.pipeline,
            ],
          },
          { fetchImpl: this.ctx.fetchImpl, signal: this.ctx.abort.signal },
          (m) => this.ctx.log.warn(m),
        );
      }
    }
    this.ctx.log.info(`watch #${this.checks}: ${result.status}${result.silent ? ' · no update' : result.summary ? ` · ${squash(result.summary, 160)}` : result.error ? ` · ${result.error}` : ''}`);
    if (!this.stopped) this.arm(this.intervalMs);
  }
}

/**
 * Start the watcher for this run, or return undefined when it is off or cannot run. Fail-soft: a
 * missing watcher binary disables it with a warning (and an error panel) instead of halting the run.
 */
export function startPipelineWatch(ctx: RunContext): PipelineWatcher | undefined {
  const w: Config['watch'] = ctx.config.watch;
  if (!w?.enabled) return undefined;
  const provider = getProvider(w.provider);
  const { spec, warnings } = resolveWatch(ctx.config, variantSupported);
  warnings.forEach((m) => ctx.log.warn(`watch: ${m}`));
  const binary = resolveBinary(spec.bin, { env: process.env, cwd: ctx.paths.root });
  if (!existsSync(binary) && !resolveExecutable(spec.bin, process.env)) {
    const error = `watch provider binary not found (${spec.bin}); pipeline watch disabled`;
    ctx.watch = { status: 'error', enabled: true, intervalMin: w.intervalMin, provider: spec.providerName, model: spec.model, error, checks: 0 };
    ctx.log.warn(`watch: ${error}`);
    return undefined;
  }
  const watcher = new PipelineWatcher(ctx, spec, provider);
  ctx.watch = { status: 'waiting', enabled: true, intervalMin: w.intervalMin, provider: spec.providerName, model: spec.model, nextAt: Date.now() + w.intervalMin * 60_000, checks: 0 };
  ctx.watchRefresh = () => void watcher.checkNow();
  watcher.start();
  ctx.log.info(`watch: pipeline watch on · ${spec.providerName}${spec.model ? ` · ${spec.model}` : ''} every ${w.intervalMin} min → ${rel(ctx.paths.root, watchLogPath(ctx.paths))}`);
  return watcher;
}