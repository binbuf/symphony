/* The planning contract in one place: templates and the prose both `brief` and `prepare` hand to an LLM. */
import { rel, type Paths } from './paths.js';
import { PROGRESS_HEADER } from './prompt.js';
import { loadParts, render } from './templates.js';

export const ROADMAP_TEMPLATE = `# Roadmap

Symphony runs the tasks below in ROADMAP order, one fresh agent session per task, and commits after each.
Bullet syntax (indented here so these examples are not picked up as tasks):

    - [ ] T01 — Title → [tasks/01-title.md](tasks/01-title.md)     not started
    - [~] T02 — Title ⟵ failed                                       unfinished: interrupted, blocked, or needs a rerun
    - [x] T03 — Title                                                done

Rules
- One top-level bullet per task. Ids are T01, T02, … (T + number); a task broken down with \`symphony split\`
  is replaced by letter-suffixed children (T10 becomes T10a, T10b, …). Phases are "##" headings.
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
# variant: high | low | ...   (reasoning effort; only sent when the provider/model supports it)
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
  const parts = loadParts('docs-contract.md');
  const vars: Record<string, string> = {
    roadmap: rel(paths.root, paths.roadmap),
    tasks: rel(paths.root, paths.tasksDir),
    progress: rel(paths.root, paths.progress),
    index: rel(paths.root, paths.index),
    logs: rel(paths.root, paths.logsDir),
    designDir: rel(paths.root, paths.designDir),
    adr: rel(paths.root, paths.adrDir),
    taskTemplate: indent(TASK_TEMPLATE.replace(/^---[\s\S]*?---\n/, '')),
    progressHeader: indent(PROGRESS_HEADER),
    designCite: design ? ' Cite design docs by path.' : '',
  };
  const rules = [parts.roadmap, parts.tasks, parts.progress, parts.logs];
  if (design) rules.push(parts.design, parts.adr);
  rules.push(parts.gitignore);
  return rules.map((r, i) => `${i + 1}. ${render(r, vars)}`).join('\n\n');
}
