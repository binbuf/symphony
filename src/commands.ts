import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, type Config } from './config.js';
import { ADR_TEMPLATE, DESIGN_README, ROADMAP_TEMPLATE, TASK_TEMPLATE, docsContract } from './contract.js';
import { ensureGitignore } from './git.js';
import type { Logger } from './logger.js';
import type { Paths } from './paths.js';
import { PROGRESS_HEADER } from './prompt.js';
import { canonicalId, patchRoadmapFile } from './roadmap.js';
import { DONE_STATES, saveState, type State } from './state.js';
import type { Task } from './tasks.js';
import { UsageError, ensureDir, fmtCost, fmtDuration, nowIso, squash } from './util.js';

function writeIfMissing(path: string, content: string, created: string[]): void {
  if (existsSync(path)) return;
  ensureDir(join(path, '..'));
  writeFileSync(path, content);
  created.push(path);
}

/** Create the .docs/ skeleton (never overwrites). Returns the paths created. */
export function scaffoldDocs(paths: Paths, opts: { roadmap: boolean; config: boolean }): string[] {
  const created: string[] = [];
  ensureDir(paths.tasksDir);
  ensureDir(paths.adrDir);
  ensureDir(paths.symphony);
  if (opts.roadmap) writeIfMissing(paths.roadmap, ROADMAP_TEMPLATE, created);
  writeIfMissing(paths.progress, PROGRESS_HEADER, created);
  writeIfMissing(join(paths.tasksDir, 'TEMPLATE.md'), TASK_TEMPLATE, created);
  writeIfMissing(join(paths.designDir, 'README.md'), DESIGN_README, created);
  writeIfMissing(join(paths.adrDir, '0000-template.md'), ADR_TEMPLATE, created);
  if (opts.config && !existsSync(paths.config)) {
    const example = join(import.meta.dirname, '..', 'symphony.config.example.json');
    const { fake: _fake, ...providers } = DEFAULTS.providers;
    writeFileSync(paths.config, existsSync(example) ? readFileSync(example, 'utf8') : `${JSON.stringify({ ...DEFAULTS, providers }, null, 2)}\n`);
    created.push(paths.config);
  }
  return created;
}

export function initCommand(paths: Paths, log: Logger): number {
  const created = scaffoldDocs(paths, { roadmap: true, config: true });
  const added = ensureGitignore(paths.root, ['.symphony/']);
  for (const p of created) log.info(`created ${p}`);
  if (added.length) log.info(`added ${added.join(', ')} to ${join(paths.root, '.gitignore')}`);
  if (!created.length && !added.length) log.info('nothing to do; .docs/ and .symphony/ already initialised');
  log.info('next: describe tasks in .docs/ROADMAP.md (+ .docs/tasks/NN-slug.md), then: symphony doctor && symphony run');
  log.info('have planning docs in another shape already? `symphony lint` shows what differs, `symphony prepare` lets the agent convert them');
  return 0;
}

export function statusCommand(paths: Paths, config: Config, state: State, tasks: Task[], log: Logger, json: boolean): number {
  if (json) {
    log.plain(JSON.stringify({ root: paths.root, provider: config.provider, halted: state.halted ?? null, tasks: tasks.map((t) => ({ ...t, state: state.tasks[t.id] ?? null })) }, null, 2));
    return 0;
  }
  if (state.halted) log.banner('HALTED', [`${state.halted.taskId ? `${state.halted.taskId} · ` : ''}${state.halted.category}: ${state.halted.reason}`, `at ${state.halted.at}`, 'symphony clear-halt to resume']);

  const rows = tasks.map((t) => {
    const s = state.tasks[t.id];
    const status = s?.status ?? 'pending';
    const shown = status === 'running' && s?.pid && !pidAlive(s.pid) ? 'running?' : status;
    return [t.id, squash(t.phase, 18), squash(t.title, 42), shown, String(s?.attempts ?? 0), fmtDuration(s?.durationS || undefined), fmtCost(s?.costUsd), s?.provider ?? '', squash(s?.summary ?? '', 60)];
  });
  const head = ['id', 'phase', 'title', 'status', 'att', 'time', 'cost', 'provider', 'summary'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === head.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
  log.plain(fmt(head));
  log.plain(widths.map((w) => '-'.repeat(w)).join('  '));
  rows.forEach((r) => log.plain(fmt(r)));

  const done = tasks.filter((t) => DONE_STATES.includes(state.tasks[t.id]?.status ?? 'pending')).length;
  const cost = tasks.reduce((a, t) => a + (state.tasks[t.id]?.costUsd ?? 0), 0);
  const time = tasks.reduce((a, t) => a + (state.tasks[t.id]?.durationS ?? 0), 0);
  const blocked = tasks.filter((t) => state.tasks[t.id]?.status === 'blocked').map((t) => t.id);
  log.plain(`\n${done}/${tasks.length} done · ${fmtDuration(time || undefined)} · ${fmtCost(cost || undefined)} · default provider ${config.provider}${blocked.length ? ` · awaiting a human: ${blocked.join(' ')}` : ''}${existsSync(paths.stop) ? ' · STOP present' : ''}`);
  return 0;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
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
 * Paste-ready brief for an LLM client: given an idea, produce the .docs/ package symphony consumes.
 * Printed to stdout so it can be piped: `symphony brief > brief.md` or `symphony brief | pbcopy`.
 */
export function briefCommand(log: Logger): number {
  log.plain(`Turn the idea at the bottom into a planning package for an autonomous coding harness called symphony. Output ONLY the files listed below, each as a separate Markdown file at the exact path given (write the path as a heading or fenced-file marker so I can save them). Write for an autonomous agent that cannot ask questions: be concrete, name real paths, commands, and acceptance checks.

${docsContract()}

Do not produce code or other files: the harness will drive an agent through the tasks later. If the idea is ambiguous, choose the simplest reasonable option and record it as an ADR instead of asking.

Here is the idea:
<paste your idea here>
`);
  return 0;
}
