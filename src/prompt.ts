import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { Paths } from './paths.js';
import { DONE_STATES, type State } from './state.js';
import { parseFrontMatter, type Task } from './tasks.js';
import { ensureDir, slugify } from './util.js';

export interface PromptCtx {
  paths: Paths;
  task: Task;
  tasks: Task[];
  state: State;
  attempt: number;
  providerName: string;
  model?: string;
  maxProgressBytes: number;
  /** Message of the failure that ended the previous attempt, if any. */
  lastError?: string;
}

export const PROGRESS_HEADER = `# Progress notes

Shared notebook for the symphony run. Each task session appends a "## Txx — title" section with what
later tasks need to know: real paths, commands that work, contract deviations, gotchas. Facts, not
narrative. The harness inlines the tail of this file into every prompt.
`;

export function ensureProgressFile(paths: Paths): boolean {
  if (existsSync(paths.progress)) return false;
  ensureDir(paths.docs);
  writeFileSync(paths.progress, PROGRESS_HEADER);
  return true;
}

/** Tail of PROGRESS.md capped at maxBytes, cut forward to a line boundary, with a marker. */
export function readProgressCapped(path: string, maxBytes: number): string {
  if (!existsSync(path)) return '(PROGRESS.md does not exist yet)';
  const size = statSync(path).size;
  const text = readFileSync(path, 'utf8');
  if (size <= maxBytes) return text.trim() || '(empty)';
  const buf = Buffer.from(text, 'utf8');
  let start = buf.length - maxBytes;
  const nl = buf.indexOf(0x0a, start);
  if (nl !== -1 && nl < buf.length - 1) start = nl + 1;
  const tail = buf.subarray(start).toString('utf8');
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  return `[… PROGRESS.md truncated: showing the last ${kb(buf.length - start)} of ${kb(buf.length)}; read .docs/PROGRESS.md for the rest …]\n\n${tail.trim()}`;
}

export function listDesignDocs(paths: Paths): { design: string[]; adr: string[] } {
  const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort().map((f) => relative(paths.root, join(dir, f))) : []);
  return { design: list(paths.designDir), adr: list(paths.adrDir) };
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

function taskFileBody(task: Task): string | undefined {
  if (!task.taskFile) return undefined;
  return parseFrontMatter(readFileSync(task.taskFile, 'utf8')).body.trim();
}

function ids(ctx: PromptCtx, pick: (status: string) => boolean): string {
  const out = ctx.tasks.filter((t) => pick(ctx.state.tasks[t.id]?.status ?? 'pending')).map((t) => t.id);
  return out.length ? out.join(', ') : '-';
}

export function buildTaskPrompt(ctx: PromptCtx): string {
  const { paths, task } = ctx;
  const docs = listDesignDocs(paths);
  const body = taskFileBody(task);
  const taskFileRel = task.taskFileRel ?? `.docs/tasks/${String(task.num).padStart(2, '0')}-${slugify(task.title)}.md`;
  const noTaskFileNote = body === undefined
    ? `- No task file exists for this task. The roadmap bullet is the entire specification. Before implementing, create ${taskFileRel} with Goal, Scope, Done when, and Hand-off sections, and put your understanding of the task there.\n`
    : '';
  const retryNote = ctx.lastError
    ? `\nPrevious attempt of this task ended with: ${ctx.lastError}. The working tree may contain partial work from it: inspect \`git status\` and \`git log -3\` before continuing, and build on what is already there.\n`
    : '';
  const designList = docs.design.length ? docs.design.join(', ') : '(none yet)';
  const adrList = docs.adr.length ? docs.adr.join(', ') : '(none yet)';

  return `You are an autonomous coding agent working on exactly one task in the "${basename(paths.root)}" project, driven by the symphony harness. Nobody is watching and nobody can answer questions: make routine judgment calls yourself and record them.

Project root: ${paths.root}  (your working directory; never touch files outside it)
Task: ${task.id} — ${task.title}  (phase: ${task.phase}; task ${task.order + 1} of ${ctx.tasks.length} in .docs/ROADMAP.md)
Task file: ${task.taskFileRel ?? '(none)'}
Attempt: ${ctx.attempt} · provider: ${ctx.providerName} · model: ${ctx.model ?? 'provider default'}
${retryNote}
## The .docs contract
- .docs/ROADMAP.md is the ordered task list. Read it for context on neighbouring tasks. Do not edit the [ ]/[~]/[x] marker or the trailing "⟵" tag on any bullet; the harness owns those. Follow-up work you discover goes into .docs/PROGRESS.md under "## Follow-ups", not into the roadmap.
- .docs/PROGRESS.md is the shared notebook for the whole run; its current content is inlined below. Before you finish, append a section "## ${task.id} — ${task.title}" with what later tasks need to know: real paths, commands that work, contract deviations, gotchas. Facts, not narrative. Never delete other sections.
- .docs/design/*.md are the architecture docs. Read the ones relevant to this task before editing code and update them when you change what they describe.
- .docs/design/adr/NNNN-title.md are architecture decision records. When you make a decision that constrains later tasks (a library, a schema, a protocol, a directory layout), add one using the next free number, ${nextAdrNumber(paths.adrDir)}, with sections Status / Context / Decision / Consequences, at most one page. Do not write ADRs for routine choices.
- The task file's "## Hand-off" section (create it if missing) is where you report what landed, what deviated from the plan and why, and what the next task must know. Replace any placeholder text.
${noTaskFileNote}
Design docs present: ${designList}
ADRs present: ${adrList}
Progress so far: done [${ids(ctx, (s) => (DONE_STATES as string[]).includes(s))}] · blocked/failed [${ids(ctx, (s) => s === 'blocked' || s === 'failed')}]

## How to work
1. Read the task file (inlined below) and every Context or design doc it names, then implement exactly its Scope. Out-of-scope items belong to other tasks: note them in the Hand-off instead of doing them.
2. Run the tests and checks the task names and report real results. If something fails and you cannot fix it within scope, say so in the Hand-off and report status failed; if what is missing is a decision only a human can make, finish everything that does not depend on it, write precisely what is needed under Hand-off, and report status blocked.
3. Git: when you finish, the harness runs \`git add -A && git commit -m "${task.id}: ${task.title} [<status>]"\` in the project root. You may also commit yourself with a message starting "${task.id}:". Never push, never amend or rebase commits you did not create, never switch branches.
4. This is a single non-interactive session. The moment you end your turn the process exits, every background job you started is killed, and no notification can ever reach you. Never end a turn waiting on background work. Run long commands in the foreground (raise the tool timeout; split anything longer than about ten minutes into chunks). Write the Hand-off, the PROGRESS.md section, and the result block in that same final turn.
5. End your final message with exactly this block, as plain text, no code fence, and nothing after it:

SYMPHONY_RESULT
status: <exactly one word: done, blocked, or failed>
summary: <one line: what landed, or what is blocking>
END_SYMPHONY_RESULT

Use "done" only when the task's acceptance criteria are met and its tests pass; "blocked" when a human decision or an external dependency stops you; "failed" when you could not complete it for any other reason.

--- PROGRESS.md (.docs/PROGRESS.md) ---
${readProgressCapped(paths.progress, ctx.maxProgressBytes)}
--- END PROGRESS.md ---

--- TASK FILE (${task.taskFileRel ?? 'none'}) ---
${body ?? `(no task file — the roadmap bullet is the whole task: "${task.id} — ${task.title}")`}
--- END TASK FILE ---
`;
}

export function buildNudgePrompt(ctx: PromptCtx, extraNote?: string): string {
  const { task } = ctx;
  const rel = task.taskFileRel ?? `.docs/tasks/${String(task.num).padStart(2, '0')}-${slugify(task.title)}.md`;
  return `Your previous turn ended without the required SYMPHONY_RESULT block, so the harness could not record ${task.id} — ${task.title}. This is a one-shot session: ending a turn exits the process, and any background job you were waiting on was killed at that moment; no notification will ever arrive.

You have been resumed with your full context. Close ${task.id} out now, in this single turn:
1. Finish only what can be finished cheaply, running every command in the foreground. Anything else: drop it and list it under "## Hand-off" in ${rel} as remaining work.
2. Make sure ${rel} has a complete "## Hand-off" with no placeholder text, and that .docs/PROGRESS.md has your "## ${task.id}" section.
3. Do not start new work. Do not push. If the harness already committed your files, leave that commit alone.
4. End this message with the block below, as plain text, no code fence, nothing after it:

SYMPHONY_RESULT
status: <exactly one word: done, blocked, or failed>
summary: <one line>
END_SYMPHONY_RESULT
${extraNote ? `\nAlso note:\n${extraNote}\n` : ''}`;
}

export function buildResumePrompt(ctx: PromptCtx, errorMessage: string): string {
  const { task } = ctx;
  return `The previous turn of this session was cut short by an infrastructure error (${errorMessage}), not by anything you did. You have been resumed with the same context.

Continue ${task.id} — ${task.title} from where you left off under the same rules. Check \`git status\` and \`git log -3\` first to see what is already in place. Run everything in the foreground, finish the PROGRESS.md section and the Hand-off, and end your final message with the SYMPHONY_RESULT block exactly as instructed:

SYMPHONY_RESULT
status: <exactly one word: done, blocked, or failed>
summary: <one line>
END_SYMPHONY_RESULT
`;
}
