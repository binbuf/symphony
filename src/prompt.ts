import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readProgressContext, renderInlinedDocs, selectTaskDesignDocs } from './context.js';
import { rel, type Paths } from './paths.js';
import { capIndexBody, readIndexCapped } from './repomap.js';
import { DONE_STATES, type State } from './state.js';
import { parseFrontMatter, type Task } from './tasks.js';
import { renderPrompt } from './templates.js';
import { capUtf8, ensureDir, slugify } from './util.js';

export interface PromptCtx {
  paths: Paths;
  task: Task;
  tasks: Task[];
  state: State;
  attempt: number;
  /** How many fresh sessions this task has already used for subtask continuation. */
  continuation: number;
  providerName: string;
  model?: string;
  /** Effective reasoning-effort / variant, or undefined when the model has none. */
  variant?: string;
  /** Byte cap for PROGRESS.md content inlined into a prompt; 0 points to the file (default 0). */
  maxProgressBytes: number;
  /** When false, design/ and adr/ are not part of the contract. */
  designDocs: boolean;
  /** Message of the failure that ended the previous attempt, if any. */
  lastError?: string;
  /** Maintain and inline the generated progress digest (only inlined when maxProgressBytes > 0). */
  progressDigest?: boolean;
  /** Inline the design docs the task names, not just point to docs/design (default false). */
  inlineDesignDocs?: boolean;
  /** Byte cap for the inlined project index; 0 points to docs/INDEX.md (default 0). */
  maxIndexBytes?: number;
  /** Byte cap for the inlined task file body (default: uncapped). */
  maxTaskBytes?: number;
  /** Pre-generated repo map to inline instead of reading `paths.index` (used by `--dry-run`). */
  indexBody?: string;
  /** Image-analysis capability note, when enabled; omitted otherwise. */
  visionNote?: string;
  /** MCP capability note for a session with servers selected; omitted otherwise. */
  mcpNote?: string;
}

export const PROGRESS_HEADER = `# Progress notes

Shared notebook for the symphony run. Each task session appends a "## Txx — title" section with what
later tasks need to know: real paths, commands that work, contract deviations, gotchas. Facts, not
narrative. The harness keeps a generated "Key facts" digest at the top (between the symphony:digest
markers); sessions are pointed at this file and read it themselves.
`;

export function ensureProgressFile(paths: Paths): boolean {
  if (existsSync(paths.progress)) return false;
  ensureDir(paths.docs);
  writeFileSync(paths.progress, PROGRESS_HEADER);
  return true;
}

export function nextAdrNumber(adrDir: string): string {
  let max = 0;
  if (existsSync(adrDir)) {
    for (const f of readdirSync(adrDir)) {
      const m = /^(\d{3,5})[-_]/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return String(max + 1).padStart(4, '0');
}

/** Keep the head of a long task file (Goal/Scope matter most) and say where the full file is. */
function capTaskBody(text: string, maxBytes: number | undefined, displayName: string): string {
  if (!maxBytes || Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  return capUtf8(text, maxBytes, `\n\n[… task file truncated: showing the first part; read ${displayName} for the full text before implementing …]`);
}

export function taskFileBody(task: Task, maxBytes?: number): string | undefined {
  // The file can disappear under the task (a split rewrote the plan, a human moved it): treat it as
  // "no task file" rather than crashing the run with an ENOENT mid-finalisation.
  if (!task.taskFile || !existsSync(task.taskFile)) return undefined;
  const body = parseFrontMatter(readFileSync(task.taskFile, 'utf8')).body.trim();
  return capTaskBody(body, maxBytes, task.taskFileRel ?? task.taskFile);
}

function countTasks(ctx: PromptCtx, pick: (status: string) => boolean): number {
  return ctx.tasks.filter((t) => pick(ctx.state.tasks[t.id]?.status ?? 'pending')).length;
}

function docPaths(paths: Paths) {
  return {
    roadmap: rel(paths.root, paths.roadmap),
    progress: rel(paths.root, paths.progress),
    tasks: rel(paths.root, paths.tasksDir),
    design: rel(paths.root, paths.designDir),
    adr: rel(paths.root, paths.adrDir),
    logs: rel(paths.root, paths.logsDir),
    index: rel(paths.root, paths.index),
  };
}

function defaultTaskFileRel(paths: Paths, task: Task): string {
  return `${rel(paths.root, paths.tasksDir)}/${String(task.num).padStart(2, '0')}${task.suffix ?? ''}-${slugify(task.title)}.md`;
}

export function buildTaskPrompt(ctx: PromptCtx): string {
  return buildExecutionPrompt(ctx, false);
}

/** Fresh continuations keep the execution contract but read their task and hand-off from disk. */
function buildExecutionPrompt(ctx: PromptCtx, continuing: boolean): string {
  const { paths, task } = ctx;
  const d = docPaths(paths);
  const body = continuing ? undefined : taskFileBody(task, ctx.maxTaskBytes);
  const taskFileRel = task.taskFileRel ?? defaultTaskFileRel(paths, task);
  const noTaskFileNote = !task.taskFile && !continuing
    ? `- No task file exists for this task. The roadmap bullet is the entire specification. Before implementing, create ${taskFileRel} with Goal, Scope, Done when, and Hand-off sections, and put your understanding of the task there.\n`
    : '';
  const retryNote = ctx.lastError
    ? `\nPrevious attempt failed: ${ctx.lastError}. Inspect \`git status\` and \`git log -3\`; build on partial work.\n`
    : '';
  const continuationNote = continuing || ctx.continuation > 0
    ? `\nContinuation ${ctx.continuation} of ${task.id}: read ${taskFileRel} (especially Hand-off) and the "## ${task.id}" notes in ${d.progress}. Inspect \`git status\` and \`git log -5\`. Finish only the remaining scope; do not redo completed work.\n`
    : '';

  const steps: string[] = [
    `Implement only this task's Scope. Read its Context${ctx.designDocs ? ' and referenced design docs' : ''} as needed. Put out-of-scope discoveries in Follow-ups. If the inlined task is truncated, read the full file before implementing.`,
    'Run the acceptance checks and relevant tests in the foreground; record actual commands and results in Hand-off. Add meaningful regression coverage for changed behavior. Report done only when acceptance criteria are met and checks pass.',
  ];
  if (ctx.designDocs) {
    steps.push(`Update affected docs in ${d.design}/. Record decisions that constrain later tasks in ${d.adr}/NNNN-title.md (next free number; Status, Context, Decision, Consequences; one page max). List changed docs in Hand-off.`);
  }
  steps.push(
    `Before finishing, fill "## Hand-off" in ${taskFileRel}: changes, deviations, check results, and exact remaining work or blockers. Append "## ${task.id} — ${task.title}" to ${d.progress} with reusable facts (paths, commands, gotchas). Preserve other sections; replace hand-off placeholders. Put follow-up tasks under "## Follow-ups" in ${d.progress}.`,
    `Git: the harness stages and commits task changes. You may commit with a "${task.id}:" prefix. Never push, switch branches, or amend/rebase commits you did not create.`,
    'Finish in this non-interactive session; nobody can answer questions. Ending your final turn exits the process; background work cannot notify you afterward. Run commands in the foreground, raise tool timeouts or split long commands into chunks, and write notes and the result before ending.',
  );
  const howTo = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const inlinedContext = continuing ? '' : inlineContextBlocks(ctx, paths, body, d);
  const taskContext = continuing ? '' : `--- TASK FILE (${task.taskFileRel ?? 'none'}) ---\n${body ?? `(no task file — the roadmap bullet is the whole task: "${task.id} — ${task.title}")`}\n--- END TASK FILE ---\n`;

  const vars: Record<string, string | number> = {
    projectName: basename(paths.root),
    mcpNote: ctx.mcpNote ? `${ctx.mcpNote}\n\n` : '',
    visionNote: ctx.visionNote ? `${ctx.visionNote}\n\n` : '',
    retryNote,
    continuationNote,
    root: paths.root,
    taskId: task.id,
    taskTitle: task.title,
    taskPhase: task.phase,
    taskOrder: task.order + 1,
    taskCount: ctx.tasks.length,
    roadmap: d.roadmap,
    taskFile: task.taskFileRel ?? '(none)',
    attempt: ctx.attempt,
    continuation: ctx.continuation,
    progress: d.progress,
    logs: d.logs,
    index: d.index,
    noTaskFileNote,
    designPaths: ctx.designDocs ? `- ${d.design}/ and ${d.adr}/ — architecture and decisions.\n` : '',
    doneCount: countTasks(ctx, (s) => (DONE_STATES as string[]).includes(s)),
    blockedCount: countTasks(ctx, (s) => s === 'blocked' || s === 'failed'),
    howTo,
    inlinedContext,
    taskContext,
  };
  return renderPrompt('task.md', vars);
}

/**
 * The optional inlined context blocks, each wrapped in its own delimiters, or an empty string. By
 * default nothing is inlined: the prompt names the files and the session reads what it needs, which
 * keeps the prompt small no matter how large PROGRESS.md, the design docs or the tree grow.
 */
function inlineContextBlocks(ctx: PromptCtx, paths: Paths, body: string | undefined, d: ReturnType<typeof docPaths>): string {
  const blocks: string[] = [];
  if (ctx.maxProgressBytes > 0) {
    const progress = readProgressContext(paths.progress, d.progress, {
      digest: ctx.progressDigest !== false,
      maxBytes: ctx.maxProgressBytes,
    });
    blocks.push(`--- PROGRESS (${d.progress}) ---\n${progress}\n--- END PROGRESS ---`);
  }
  if (ctx.designDocs && ctx.inlineDesignDocs === true) {
    const inlined = renderInlinedDocs(selectTaskDesignDocs(paths, body, { taskFile: ctx.task.taskFile })).trim();
    if (inlined) blocks.push(inlined);
  }
  if ((ctx.maxIndexBytes ?? 0) > 0) {
    const map = ctx.indexBody === undefined
      ? readIndexCapped(paths.index, ctx.maxIndexBytes as number, d.index)
      : capIndexBody(ctx.indexBody, ctx.maxIndexBytes as number, d.index);
    blocks.push(`--- PROJECT INDEX (${d.index}) ---\n${map}\n--- END PROJECT INDEX ---`);
  }
  return blocks.length ? `\n${blocks.join('\n\n')}\n` : '';
}

function readProgress(ctx: PromptCtx, paths: Paths): string {
  const display = rel(paths.root, paths.progress);
  if (ctx.maxProgressBytes <= 0) {
    return `(read ${display} for what earlier tasks recorded, and append your "## ${ctx.task.id}" section there before finishing)`;
  }
  return readProgressContext(paths.progress, display, {
    digest: ctx.progressDigest !== false,
    maxBytes: ctx.maxProgressBytes,
  });
}

/** Place the capability notes after the opening paragraph, before the final result instructions. */
function withNotes(text: string, ctx: PromptCtx): string {
  const note = [ctx.mcpNote, ctx.visionNote].filter(Boolean).join('\n\n');
  if (!note) return text;
  const firstBreak = text.indexOf('\n\n');
  if (firstBreak < 0) return `${text}\n\n${note}\n`;
  return `${text.slice(0, firstBreak)}\n\n${note}${text.slice(firstBreak)}`;
}

export function buildContinuePrompt(ctx: PromptCtx): string {
  return buildExecutionPrompt(ctx, true);
}

export function buildNudgePrompt(ctx: PromptCtx, extraNote?: string): string {
  const { task, paths } = ctx;
  const d = docPaths(paths);
  const rel0 = task.taskFileRel ?? defaultTaskFileRel(paths, task);
  return withNotes(`Your previous turn ended without the required SYMPHONY_RESULT block, so the harness could not record ${task.id} — ${task.title}. This is a one-shot session: ending a turn exits the process, and any background job you were waiting on was killed at that moment; no notification will ever arrive.

${extraNote ? `Also note:\n${extraNote}\n\n` : ''}You have been resumed with your full context. Close ${task.id} out now, in this single turn:
1. Finish only what can be finished cheaply, running every command in the foreground. Anything else: drop it and list it under "## Hand-off" in ${rel0} as remaining work.
2. Make sure ${rel0} has a complete "## Hand-off" with no placeholder text, and that ${d.progress} has your "## ${task.id}" section.
3. Do not start new work. Do not push. If the harness already committed your files, leave that commit alone.
4. End this message with the block below, as plain text, no code fence, nothing after it:

SYMPHONY_RESULT
status: <exactly one word: done, continue, blocked, or failed>
summary: <one line>
END_SYMPHONY_RESULT
`, ctx);
}

/**
 * The close-out prompt for a "pause as soon as possible": the operator asked the pipeline to stop
 * now, so the session stops new work, makes the tree build cleanly, records the hand-off and reports
 * — the harness then commits the slice and pauses, resuming the task on the next run. When the
 * running session can be resumed this is a short note; when it cannot (a provider without resume) it
 * is self-contained: it inlines the task file and points at (or inlines) the progress notebook like a
 * task prompt.
 */
export function buildWrapUpPrompt(ctx: PromptCtx, opts: { resumed: boolean; verify?: { command: string } }): string {
  const { paths, task } = ctx;
  const d = docPaths(paths);
  const rel0 = task.taskFileRel ?? defaultTaskFileRel(paths, task);
  const resumedPreamble = opts.resumed
    ? 'You have been resumed with the full context of the turn that was just stopped, so continue from exactly where it left off.'
    : 'This is a fresh session: read the context at the end of this prompt before you touch anything.';
  const buildStep = opts.verify?.command
    ? `\`${opts.verify.command}\``
    : 'the project\'s build/test command in the foreground (for example `npm run build` or `npm test`)';
  const designNote = ctx.designDocs ? ` If your work changed behaviour a ${d.design}/*.md doc describes, update that doc too.` : '';
  const body = taskFileBody(task, ctx.maxTaskBytes);
  const contextBlock = opts.resumed ? '' : `
## Context for this fresh session

--- TASK FILE (${task.taskFileRel ?? 'none'}) ---
${body ?? `(no task file — the roadmap bullet is the whole task: "${task.id} — ${task.title}")`}
--- END TASK FILE ---

--- PROGRESS (${d.progress}) ---
${readProgress(ctx, paths)}
--- END PROGRESS ---
`;
  const text = renderPrompt('wrapup.md', {
    projectName: basename(paths.root),
    taskId: task.id,
    taskTitle: task.title,
    taskFile: rel0,
    progress: d.progress,
    resumedPreamble,
    buildStep,
    designNote,
    contextBlock,
  });
  return withNotes(text, ctx);
}

export function buildResumePrompt(ctx: PromptCtx, errorMessage: string): string {
  const { task } = ctx;
  return withNotes(`The previous turn of this session was cut short by an infrastructure error (${errorMessage}), not by anything you did. You have been resumed with the same context.

Continue ${task.id} — ${task.title} from where you left off under the same rules. Check \`git status\` and \`git log -3\` first to see what is already in place. Run everything in the foreground, finish the progress section and the Hand-off, and end your final message with the SYMPHONY_RESULT block exactly as instructed:

SYMPHONY_RESULT
status: <exactly one word: done, continue, blocked, or failed>
summary: <one line>
END_SYMPHONY_RESULT
`, ctx);
}
