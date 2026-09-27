import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readProgressContext, renderInlinedDocs, selectTaskDesignDocs } from './context.js';
import { rel, type Paths } from './paths.js';
import { readIndexCapped } from './repomap.js';
import { DONE_STATES, type State } from './state.js';
import { parseFrontMatter, type Task } from './tasks.js';
import { renderPrompt } from './templates.js';
import { ensureDir, slugify } from './util.js';

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
  const buf = Buffer.from(text, 'utf8');
  const kb = (n: number): string => `${Math.round(n / 1024)} KB`;
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n\n[… task file truncated: showing the first ${kb(maxBytes)} of ${kb(buf.length)}; read ${displayName} for the full text …]`;
}

export function taskFileBody(task: Task, maxBytes?: number): string | undefined {
  if (!task.taskFile) return undefined;
  const body = parseFrontMatter(readFileSync(task.taskFile, 'utf8')).body.trim();
  return capTaskBody(body, maxBytes, task.taskFileRel ?? task.taskFile);
}

function ids(ctx: PromptCtx, pick: (status: string) => boolean): string {
  const out = ctx.tasks.filter((t) => pick(ctx.state.tasks[t.id]?.status ?? 'pending')).map((t) => t.id);
  return out.length ? out.join(', ') : '-';
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
  const { paths, task } = ctx;
  const d = docPaths(paths);
  const body = taskFileBody(task, ctx.maxTaskBytes);
  const taskFileRel = task.taskFileRel ?? defaultTaskFileRel(paths, task);
  const noTaskFileNote = body === undefined
    ? `- No task file exists for this task. The roadmap bullet is the entire specification. Before implementing, create ${taskFileRel} with Goal, Scope, Done when, and Hand-off sections, and put your understanding of the task there.\n`
    : '';
  const retryNote = ctx.lastError
    ? `\nPrevious attempt of this task ended with: ${ctx.lastError}. The working tree may contain partial work from it: inspect \`git status\` and \`git log -3\` before continuing, and build on what is already there.\n`
    : '';
  const continuationNote = ctx.continuation > 0
    ? `\nThis is continuation session ${ctx.continuation} of ${task.id}: a previous session deliberately reported "continue" after finishing part of the task. Read the task's Hand-off and your own "## ${task.id}" section in ${d.progress}, inspect \`git status\` and \`git log -5\`, and do the next unfinished slice only. Do not redo completed work.\n`
    : '';

  const steps: string[] = [
    `Read the task file (inlined below)${ctx.designDocs ? ' and every Context or design doc it names' : ''}, then implement exactly its Scope. Out-of-scope items belong to other tasks: note them in the Hand-off instead of doing them.`,
    'Keep the work verifiable. Write or update the unit/integration tests the task\'s "Done when" names, run them in the foreground, and paste the real command and result into the Hand-off. Do not claim done unless those tests actually pass; if the task names no tests, add at least one meaningful automated check that would fail if your change regressed.',
  ];
  if (ctx.designDocs) {
    steps.push(`Keep the design docs honest. If your change makes a ${d.design}/*.md doc untrue, update it in the same session; if a decision now constrains later tasks, add an ADR under ${d.adr}/ (next free number, Status / Context / Decision / Consequences, one page max) and list it in the Hand-off.`);
  }
  steps.push(
    `If the task is too large for one session, do not rush or fake completion. Finish the largest coherent slice that leaves the tree green, record what remains under "## Hand-off" and in ${d.progress}, and report status "continue" (see the block below). The harness will start a fresh session to finish the rest; the next session reads your notes and continues. Only use "continue" when real, committed progress was made and a later session can pick it up.`,
    'Only report "blocked" when a human decision or an external dependency genuinely stops you and no further useful work is possible. Before blocking, finish every part that does not depend on the human, and write precisely what is needed under "## Hand-off".',
    `Git: when you finish, the harness runs \`git add -A && git commit -m "${task.id}: ${task.title} [<status>]"\` in the project root. You may also commit yourself with a message starting "${task.id}:". Never push, never amend or rebase commits you did not create, never switch branches.`,
    `This is a single non-interactive session. The moment you end your turn the process exits, every background job you started is killed, and no notification can ever reach you. Never end a turn waiting on background work. Run long commands in the foreground (raise the tool timeout; split anything longer than about ten minutes into chunks). Write the Hand-off, the ${basename(paths.progress)} section, and the result block in that same final turn.`,
  );
  const howTo = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const finalStep = steps.length + 1;
  const inlinedContext = inlineContextBlocks(ctx, paths, body, d);

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
    provider: ctx.providerName,
    model: ctx.model ?? 'provider default',
    variant: ctx.variant ?? 'provider default',
    progress: d.progress,
    logs: d.logs,
    index: d.index,
    design: d.design,
    adr: d.adr,
    noTaskFileNote,
    doneIds: ids(ctx, (s) => (DONE_STATES as string[]).includes(s)),
    blockedIds: ids(ctx, (s) => s === 'blocked' || s === 'failed'),
    howTo,
    finalStep,
    inlinedContext,
    taskFileForBlock: task.taskFileRel ?? 'none',
    taskBody: body ?? `(no task file — the roadmap bullet is the whole task: "${task.id} — ${task.title}")`,
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
    const inlined = renderInlinedDocs(selectTaskDesignDocs(paths, body)).trim();
    if (inlined) blocks.push(inlined);
  }
  if ((ctx.maxIndexBytes ?? 0) > 0) {
    const map = ctx.indexBody ?? readIndexCapped(paths.index, ctx.maxIndexBytes as number, d.index);
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
  const { paths, task } = ctx;
  const d = docPaths(paths);
  const rel0 = task.taskFileRel ?? defaultTaskFileRel(paths, task);
  return withNotes(`This is a continuation session for ${task.id} — ${task.title}. A previous session completed part of this task and reported status "continue"; the harness has started you in a fresh session to finish it.

Nobody can answer questions. Work only on what remains:
1. Read ${rel0} (especially "## Hand-off"), the "## ${task.id}" section in ${d.progress}, and run \`git status\` and \`git log -5\` to see what already landed.
2. Finish the remaining scope. Keep tests passing. Do not redo completed work.
3. Update the "## Hand-off" and ${d.progress} to reflect the new state; if still unfinished, report "continue" again with what remains, otherwise "done".
4. Run everything in the foreground and finish in this single turn.
5. End your final message with exactly this block, as plain text, no code fence, nothing after it:

SYMPHONY_RESULT
status: <exactly one word: done, continue, blocked, or failed>
summary: <one line>
END_SYMPHONY_RESULT
`, ctx);
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
