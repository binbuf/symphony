/* The planning contract in one place: templates and the prose both `brief` and `prepare` hand to an LLM. */
import { rel, type Paths } from './paths.js';
import { PROGRESS_HEADER } from './prompt.js';

export const ROADMAP_TEMPLATE = `# Roadmap

Symphony runs the tasks below in ROADMAP order, one fresh agent session per task, and commits after each.
Bullet syntax (indented here so these examples are not picked up as tasks):

    - [ ] T01 — Title → [tasks/01-title.md](tasks/01-title.md)     not started
    - [~] T02 — Title ⟵ failed                                       unfinished: interrupted, blocked, or needs a rerun
    - [x] T03 — Title                                                done

Rules
- One top-level bullet per task. Ids are T01, T02, … (T + number). Phases are "##" headings.
- The harness owns the [ ]/[~]/[x] marker and the trailing "⟵ tag"; edit the rest freely.
- Task details live in tasks/NN-slug.md (linked from the bullet, or matched by the NN prefix).
- The harness keeps a pipeline status block (between the "symphony:status" HTML comments) at the end of this
  file: high-level what is done, blocked, failed and left. Do not edit that block by hand.

## Phase 1 — Foundation

<!-- add tasks here, e.g.:  - [ ] T01 — Scaffold the project → [tasks/01-scaffold.md](tasks/01-scaffold.md) -->
`;

export const LOGS_README = `# Logs

One markdown file per task (\`T01.md\`, \`T02.md\`, …), written by the symphony harness after every
session. Each file is the high-level run log for that task: status, provider/model, timing, cost, commit,
and each session's reported \`SYMPHONY_RESULT\` status and summary. It is regenerated in place, so it always
reflects the latest state. Do not edit these files by hand; the raw provider streams live under
\`.symphony/runs/\` (gitignored).
`;

export const TASK_TEMPLATE = `---
# Optional per-task overrides read by the harness (delete if unused):
# provider: claude | cursor | opencode | codex | gemini | antigravity
# model: <model id>
# timeoutMin: 240
# verify: <shell command the harness runs after this task reports done; non-zero fails the task>
---
# TNN — <Title>

## Goal
One or two sentences: what exists at the end of the session that did not exist before, and why it matters.

## Context (read first)
- \`path/to/file.ts:123\` — why this file matters
- \`<design>/<doc>.md\` — the design this task implements

## Scope
- [ ] Concrete, verifiable item

## Out of scope
- Item and the task that owns it (→ TNN)

## Design notes
Decisions the implementer must follow (names, signatures, constraints).

## Done when
- [ ] Tests named here pass, with the commands to run them
- [ ] Docs touched: …
- [ ] Hand-off below filled in

## Hand-off
_(filled in by the implementing session: what landed, what deviated and why, what the next task must know)_
`;

export const DESIGN_README = `# Design

Architecture documents for this project. One topic per file. Agent sessions read the docs relevant to
their task before editing code and update them when behaviour changes. Decisions that constrain later
work go into adr/ as numbered records.
`;

export const ADR_TEMPLATE = `# 0000 — ADR template

Copy to \`NNNN-short-title.md\` with the next free number. Keep it to one page.

## Status
proposed | accepted | superseded by NNNN

## Context
What forces are at play; why a decision is needed now.

## Decision
What we decided, in one or two sentences, and the alternatives rejected.

## Consequences
What becomes easier or harder; what later tasks must respect.
`;

const indent = (s: string) => s.trimEnd().split('\n').map((l) => `    ${l}`).join('\n');

/** The format rules, phrased for an LLM that must produce or repair the planning package. */
export function docsContract(paths: Paths, opts: { design?: boolean } = {}): string {
  const design = opts.design !== false;
  const roadmap = rel(paths.root, paths.roadmap);
  const tasks = rel(paths.root, paths.tasksDir);
  const progress = rel(paths.root, paths.progress);
  const designDir = rel(paths.root, paths.designDir);
  const adr = rel(paths.root, paths.adrDir);
  const logs = rel(paths.root, paths.logsDir);
  const rules = [
    `${roadmap}
   - "# <Project> Roadmap", a short summary, then phases as "## Phase N — <name>" headings in execution order.
   - Under each phase, one top-level bullet per task, in the order they must run, exactly in this form:
       - [ ] T01 — <short imperative title> → [tasks/01-<slug>.md](tasks/01-<slug>.md)
   - Ids are T01, T02, … zero-padded, unique and increasing across the whole file. Every task bullet starts with "- [ ] " (or "- [x] " if that work is already done). No sub-bullets under task bullets. No other bullets or numbered items anywhere in the file that begin with a number or a T-number; put prose in paragraphs.
   - Size each task for one unattended coding session: one concern, roughly 1–3 hours of work, verifiable by running commands. Dependencies always come earlier in the list. The first task sets up the repo/tooling and a runnable test command.
   - For a greenfield project, the early tasks scaffold the repo, tooling and a passing test command before feature work. For an existing codebase, the tasks describe the incremental feature/fix work to implement; never re-scaffold what already exists.
   - The harness appends and maintains a pipeline status block (between "symphony:status" HTML comments) at the end of the file describing what is done, blocked, failed and left. Do not write or edit that block.`,

    `${tasks}/NN-<slug>.md — one file per task (NN = the two-digit id), using this template exactly, with every section present:

${indent(TASK_TEMPLATE.replace(/^---[\s\S]*?---\n/, ''))}

   Rules: "Scope" items are concrete and checkable; "Out of scope" names the task that owns each excluded item; "Done when" lists the commands to run and what they must show, and names at least one automated test that must pass; leave "Hand-off" as the single italic placeholder line until the task runs. Optionally set "verify:" in the front matter to the single command the harness should run itself to confirm the task (leave it out when the project's test command is enough).${design ? ' Cite design docs by path.' : ''}`,

    `${progress} — starts with exactly this header (existing notes below it are kept):

${indent(PROGRESS_HEADER)}`,

    `${logs}/TNN.md — the harness's per-task run logs (status, provider/model, timing, cost, commit and each session's SYMPHONY_RESULT status + summary). It is written and regenerated by the harness after every session, so do not create or edit files there.`,
  ];
  if (design) {
    rules.push(
      `${designDir}/<topic>.md — architecture docs split by topic (overview.md with goals/non-goals and the component map; then one file each for data model, key flows, interfaces/APIs, testing strategy, and anything the tasks must build against). Tasks cite these by path; keep each doc under two pages.`,
      `${adr}/NNNN-<slug>.md — one ADR per decision that constrains the work (language/stack, storage, protocols, module boundaries, hosting). Number from 0001. Each ADR has exactly these sections: "## Status", "## Context", "## Decision", "## Consequences". One page max. As the pipeline runs, sessions add new ADRs (and update the design docs) whenever a substantial decision diverges from the original design; the ADR records the change rather than silently rewriting history.`,
    );
  }
  rules.push('.gitignore for the target repo, appropriate to the stack, including the line ".symphony/".');
  return rules.map((r, i) => `${i + 1}. ${r}`).join('\n\n');
}
