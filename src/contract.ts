/* The .docs/ contract in one place: templates and the prose both `brief` and `prepare` hand to an LLM. */
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

## Phase 1 — Foundation

<!-- add tasks here, e.g.:  - [ ] T01 — Scaffold the project → [tasks/01-scaffold.md](tasks/01-scaffold.md) -->
`;

export const TASK_TEMPLATE = `---
# Optional per-task overrides read by the harness (delete if unused):
# provider: claude | cursor | opencode | codex
# model: <model id>
# timeoutMin: 240
---
# TNN — <Title>

## Goal
One or two sentences: what exists at the end of the session that did not exist before, and why it matters.

## Context (read first)
- \`path/to/file.ts:123\` — why this file matters
- \`.docs/design/<doc>.md\` — the design this task implements

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

/** The format rules, phrased for an LLM that must produce or repair the files. */
export function docsContract(): string {
  return `1. .docs/ROADMAP.md
   - "# <Project> Roadmap", a short summary, then phases as "## Phase N — <name>" headings in execution order.
   - Under each phase, one top-level bullet per task, in the order they must run, exactly in this form:
       - [ ] T01 — <short imperative title> → [tasks/01-<slug>.md](tasks/01-<slug>.md)
   - Ids are T01, T02, … zero-padded, unique and increasing across the whole file. Every task bullet starts with "- [ ] " (or "- [x] " if that work is already done). No sub-bullets under task bullets. No other bullets or numbered items anywhere in the file that begin with a number or a T-number; put prose in paragraphs.
   - Size each task for one unattended coding session: one concern, roughly 1–3 hours of work, verifiable by running commands. Dependencies always come earlier in the list. The first task sets up the repo/tooling and a runnable test command.

2. .docs/tasks/NN-<slug>.md — one file per task (NN = the two-digit id), using this template exactly, with every section present:

${indent(TASK_TEMPLATE.replace(/^---[\s\S]*?---\n/, ''))}

   Rules: "Scope" items are concrete and checkable; "Out of scope" names the task that owns each excluded item; "Done when" lists the commands to run and what they must show; leave "Hand-off" as the single italic placeholder line until the task runs. Cite design docs by path.

3. .docs/PROGRESS.md — starts with exactly this header (existing notes below it are kept):

${indent(PROGRESS_HEADER)}

4. .docs/design/<topic>.md — architecture docs split by topic (overview.md with goals/non-goals and the component map; then one file each for data model, key flows, interfaces/APIs, testing strategy, and anything the tasks must build against). Tasks cite these by path; keep each doc under two pages.

5. .docs/design/adr/NNNN-<slug>.md — one ADR per decision that constrains the work (language/stack, storage, protocols, module boundaries, hosting). Number from 0001. Each ADR has exactly these sections: "## Status", "## Context", "## Decision", "## Consequences". One page max.

6. .gitignore for the target repo, appropriate to the stack, including the line ".symphony/".`;
}
