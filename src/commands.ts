import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, type Config } from './config.js';
import { ADR_TEMPLATE, DESIGN_README, LOGS_README, ROADMAP_TEMPLATE, TASK_TEMPLATE, docsContract } from './contract.js';
import { commitsForTask, commitPrefix, ensureGitignore, git } from './git.js';
import type { Logger } from './logger.js';
import { taskLogPath } from './logs.js';
import { rel, stopIgnoreEntry, stopPresent, type Paths } from './paths.js';
import { PROGRESS_HEADER } from './prompt.js';
import { canonicalId, patchRoadmapFile } from './roadmap.js';
import { DONE_STATES, saveState, type LogRef, type State, type TaskState } from './state.js';
import { updatePipelineStatus } from './status.js';
import type { Task } from './tasks.js';
import { UsageError, ensureDir, fmtCost, fmtDateTime, fmtDuration, nowIso, squash } from './util.js';

function writeIfMissing(path: string, content: string, created: string[]): void {
  if (existsSync(path)) return;
  ensureDir(join(path, '..'));
  writeFileSync(path, content);
  created.push(path);
}

/** Create the docs skeleton (never overwrites). Returns the paths created. */
export function scaffoldDocs(paths: Paths, opts: { roadmap: boolean; config: boolean; design?: boolean }): string[] {
  const created: string[] = [];
  ensureDir(paths.tasksDir);
  ensureDir(paths.symphony);
  if (opts.roadmap) writeIfMissing(paths.roadmap, ROADMAP_TEMPLATE, created);
  writeIfMissing(paths.progress, PROGRESS_HEADER, created);
  writeIfMissing(join(paths.tasksDir, 'TEMPLATE.md'), TASK_TEMPLATE, created);
  ensureDir(paths.logsDir);
  writeIfMissing(join(paths.logsDir, 'README.md'), LOGS_README, created);
  if (opts.design !== false) {
    ensureDir(paths.adrDir);
    writeIfMissing(join(paths.designDir, 'README.md'), DESIGN_README, created);
    writeIfMissing(join(paths.adrDir, '0000-template.md'), ADR_TEMPLATE, created);
  }
  if (opts.config && !existsSync(paths.config)) {
    const example = join(import.meta.dirname, '..', 'symphony.config.example.json');
    const { fake: _fake, ...providers } = DEFAULTS.providers;
    writeFileSync(paths.config, existsSync(example) ? readFileSync(example, 'utf8') : `${JSON.stringify({ ...DEFAULTS, providers }, null, 2)}\n`);
    created.push(paths.config);
  }
  return created;
}

export function initCommand(paths: Paths, log: Logger, opts: { design?: boolean } = {}): number {
  const created = scaffoldDocs(paths, { roadmap: true, config: true, design: opts.design });
  const added = ensureGitignore(paths.root, ['.symphony/', ...(stopIgnoreEntry(paths) ? [stopIgnoreEntry(paths)!] : [])]);
  for (const p of created) log.info(`created ${p}`);
  if (added.length) log.info(`added ${added.join(', ')} to ${join(paths.root, '.gitignore')}`);
  if (!created.length && !added.length) log.info(`nothing to do; ${rel(paths.root, paths.docs)} and .symphony/ already initialised`);
  log.info(`next: describe tasks in ${rel(paths.root, paths.roadmap)} (+ ${rel(paths.root, paths.tasksDir)}/NN-slug.md), then: symphony doctor && symphony run`);
  log.info('have planning docs in another shape already? `symphony lint` shows what differs, `symphony prepare` lets the agent convert them');
  return 0;
}

export function statusCommand(paths: Paths, config: Config, state: State, tasks: Task[], log: Logger, json: boolean): number {
  if (json) {
    log.plain(JSON.stringify({ root: paths.root, provider: config.provider, halted: state.halted ?? null, tasks: tasks.map((t) => ({ ...t, state: state.tasks[t.id] ?? null })) }, null, 2));
    return 0;
  }
  if (state.halted) log.banner('HALTED', [`${state.halted.taskId ? `${state.halted.taskId} · ` : ''}${state.halted.category}: ${state.halted.reason}`, `at ${state.halted.at}`, 'symphony clear-halt to resume']);

  const rows: string[][] = [];
  for (const t of tasks) {
    const s = state.tasks[t.id];
    const status = s?.status ?? 'pending';
    const running = status === 'running';
    const shown = running && s?.pid && !pidAlive(s.pid) ? 'running?' : status;
    const time = running ? `${fmtDuration(runningSeconds(s))} (running)` : fmtDuration(s?.durationS || undefined);
    // The parent line spans the whole task: the first session's start through the finish, with the
    // accumulated duration and the final summary.
    const start = s?.logs?.[0]?.started ?? s?.started;
    rows.push([t.id, squash(t.phase, 18), squash(t.title, 42), shown, String(s?.attempts ?? 0), time, fmtDateTime(start), fmtDateTime(s?.finished), fmtCost(s?.costUsd), s?.provider ?? '', squash(s?.summary ?? '', 60)]);
    // A task split across sessions or retried (att >= 2) gets one child line per session, so each
    // round reports its own start/end, duration and summary instead of only the task's running total.
    if ((s?.attempts ?? 0) >= 2 && s?.logs?.length) {
      s.logs.forEach((l, i) => {
        const run = runTiming(l, running);
        const label = `run ${i + 1} · ${l.kind}`;
        rows.push(['  ↳', '', squash(label, 42), l.status ?? '', '', run.duration, run.start, run.end, fmtCost(l.costUsd), '', squash(l.summary ?? '', 60)]);
      });
    }
  }
  const head = ['id', 'phase', 'title', 'status', 'att', 'duration', 'start', 'end', 'cost', 'provider', 'summary'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === head.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
  log.plain(fmt(head));
  log.plain(widths.map((w) => '-'.repeat(w)).join('  '));
  rows.forEach((r) => log.plain(fmt(r)));

  const done = tasks.filter((t) => DONE_STATES.includes(state.tasks[t.id]?.status ?? 'pending')).length;
  const cost = tasks.reduce((a, t) => a + (state.tasks[t.id]?.costUsd ?? 0), 0);
  const time = tasks.reduce((a, t) => {
    const s = state.tasks[t.id];
    return a + (s?.status === 'running' ? runningSeconds(s) : s?.durationS ?? 0);
  }, 0);
  const blocked = tasks.filter((t) => state.tasks[t.id]?.status === 'blocked').map((t) => t.id);
  log.plain(`\n${done}/${tasks.length} done · ${fmtDuration(time || undefined)} · ${fmtCost(cost || undefined)} · default provider ${config.provider}${blocked.length ? ` · awaiting a human: ${blocked.join(' ')}` : ''}${stopPresent(paths) ? ` · STOP present (${rel(paths.root, paths.stop)})` : ''}`);
  return 0;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Time a still-running task has spent so far: its finished sessions plus the one in flight. */
function runningSeconds(s: TaskState | undefined): number {
  const base = s?.durationS ?? 0;
  if (!s?.started) return base;
  const started = Date.parse(s.started);
  if (!Number.isFinite(started)) return base;
  return base + Math.max(0, Math.round((Date.now() - started) / 1000));
}

/** The start stamp, computed end stamp and duration of one recorded session run (in flight included). */
function runTiming(l: LogRef, running: boolean): { start: string; end: string; duration: string } {
  const started = l.started ? Date.parse(l.started) : NaN;
  const seconds = l.durationS ?? (running && Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : undefined);
  const end = Number.isFinite(started) && seconds !== undefined ? new Date(started + seconds * 1000).toISOString() : undefined;
  return { start: fmtDateTime(l.started), end: fmtDateTime(end), duration: fmtDuration(seconds) };
}

/** Print a task's per-run log (docs/logs/TNN.md), or list the log files when no id is given. */
export function logsCommand(paths: Paths, tasks: Task[], rawId: string | undefined, log: Logger): number {
  if (!rawId) {
    if (!existsSync(paths.logsDir)) { log.info(`no logs yet (${rel(paths.root, paths.logsDir)}/ does not exist)`); return 0; }
    const files = readdirSync(paths.logsDir).filter((f) => /^T\d+\.md$/i.test(f)).sort();
    log.plain(files.length ? files.map((f) => rel(paths.root, join(paths.logsDir, f))).join('\n') : '(no per-task logs yet)');
    return 0;
  }
  const id = canonicalId(rawId);
  const task = id ? tasks.find((t) => t.id === id) : undefined;
  if (!task) throw new UsageError(`logs ${rawId}: no such task in ROADMAP.md`);
  const file = taskLogPath(paths, task.id);
  if (!existsSync(file)) throw new UsageError(`logs ${task.id}: no log yet (${rel(paths.root, file)}); it is written after the first session`);
  log.plain(`--- ${rel(paths.root, file)} ---`);
  process.stdout.write(readFileSync(file, 'utf8'));
  return 0;
}

export function acceptCommand(paths: Paths, state: State, tasks: Task[], rawIds: string[], note: string | undefined, log: Logger): number {
  for (const raw of rawIds) {
    const id = canonicalId(raw);
    const task = id ? tasks.find((t) => t.id === id) : undefined;
    if (!task) throw new UsageError(`accept ${raw}: no such task in ROADMAP.md`);
    const st = state.tasks[task.id];
    if (!st) throw new UsageError(`accept ${task.id}: it has never run; only blocked/failed tasks can be accepted`);
    if (DONE_STATES.includes(st.status)) { log.info(`${task.id} already ${st.status}; nothing to accept`); continue; }
    if (st.status !== 'blocked' && st.status !== 'failed') throw new UsageError(`accept ${task.id}: status is ${st.status}; only blocked/failed tasks can be accepted`);
    const from = st.status;
    st.status = 'accepted';
    st.accepted = { at: nowIso(), from, note };
    st.summary = `accepted by human${note ? ` — ${note}` : ''} | was ${from}: ${st.summary ?? ''}`;
    log.info(`${task.id}: ${from} -> accepted${note ? ` (${note})` : ''}`);
    saveState(paths, state);
    try { patchRoadmapFile(paths.roadmap, task.id, 'accepted'); } catch (e) { log.warn(`${task.id}: could not patch ROADMAP.md: ${(e as Error).message}`); }
  }
  saveState(paths, state);
  return 0;
}

export function clearHaltCommand(paths: Paths, state: State, log: Logger): number {
  if (!state.halted) { log.info('not halted'); return 0; }
  log.info(`cleared halt from ${state.halted.at} (${state.halted.category}: ${state.halted.reason})`);
  delete state.halted;
  saveState(paths, state);
  return 0;
}

/**
 * Clear a task's recorded state so `run` picks it up again. With `--revert`, also undo the commits the
 * task produced (newest first) so the work starts from a clean slate. With `--all`, clear every task's
 * state and the halt, so a replaced or rewritten roadmap starts clean.
 */
export function resetCommand(paths: Paths, state: State, tasks: Task[], rawId: string | undefined, opts: { revert: boolean; all?: boolean; log: Logger; commitTemplate?: string }): number {
  const { revert, log } = opts;

  if (opts.all) {
    if (revert) throw new UsageError('reset --all cannot be combined with --revert (which targets one task)');
    const count = Object.keys(state.tasks).length;
    state.tasks = {};
    delete state.halted;
    saveState(paths, state);
    for (const t of tasks) {
      try { patchRoadmapFile(paths.roadmap, t.id, 'pending'); } catch (e) { log.warn(`${t.id}: could not patch ROADMAP.md: ${(e as Error).message}`); }
    }
    updatePipelineStatus(paths, tasks, state, log);
    log.info(`all task state cleared (${count} task${count === 1 ? '' : 's'}); every task in ${rel(paths.root, paths.roadmap)} will run from the start`);
    return 0;
  }

  if (!rawId) throw new UsageError('reset: give a task id (e.g. symphony reset T05), or --all to clear everything');
  const id = canonicalId(rawId);
  const task = id ? tasks.find((t) => t.id === id) : undefined;
  if (!task) throw new UsageError(`reset ${rawId}: no such task in ROADMAP.md`);

  if (revert) {
    const template = opts.commitTemplate ?? '{id}: {title} [{status}]';
    const prefix = commitPrefix(template, task.id);
    if (prefix === undefined) {
      throw new UsageError(`reset --revert: commitMessageTemplate "${template}" does not contain {id}, so this task's commits cannot be identified; revert them by hand, or drop --revert`);
    }
    const shas = commitsForTask(paths.root, task.id, prefix);
    if (!shas.length) log.info(`${task.id}: no commits with subject "${prefix}…" to revert`);
    for (const sha of shas) {
      const r = git(paths.root, ['revert', '--no-edit', sha]);
      if (r.code !== 0) {
        log.error(`${task.id}: git revert ${sha.slice(0, 8)} failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
        log.warn('resolve the conflict (or run `git revert --abort`), then re-run `symphony reset`');
        return 1;
      }
      log.info(`${task.id}: reverted ${sha.slice(0, 8)}`);
    }
  }

  delete state.tasks[task.id];
  if (state.halted?.taskId === task.id) {
    delete state.halted;
    log.info(`${task.id}: cleared the halt on this task`);
  }
  saveState(paths, state);
  try { patchRoadmapFile(paths.roadmap, task.id, 'pending'); } catch (e) { log.warn(`${task.id}: could not patch ROADMAP.md: ${(e as Error).message}`); }
  updatePipelineStatus(paths, tasks, state, log);
  log.info(`${task.id}: state cleared; it will run again from the start${revert ? ' (commits reverted)' : ''}`);
  return 0;
}

/**
 * Paste-ready brief for an LLM client: given an idea, produce the .docs/ package symphony consumes.
 * Printed to stdout so it can be piped: `symphony brief > brief.md` or `symphony brief | pbcopy`.
 */
export function briefCommand(paths: Paths, log: Logger, opts: { design?: boolean } = {}): number {
  log.plain(`Turn the idea at the bottom into a planning package for an autonomous coding harness called symphony. Output ONLY the files listed below, each as a separate Markdown file at the exact path given (write the path as a heading or fenced-file marker so I can save them). Write for an autonomous agent that cannot ask questions: be concrete, name real paths, commands, and acceptance checks.

${docsContract(paths, opts)}

Do not produce code or other files: the harness will drive an agent through the tasks later. If the idea is ambiguous, choose the simplest reasonable option and record it as an ADR instead of asking.

Here is the idea:
<paste your idea here>
`);
  return 0;
}
