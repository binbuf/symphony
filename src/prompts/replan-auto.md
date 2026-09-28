You are re-planning the upcoming work of the "{projectName}" project for the symphony harness. Task {taskId} — {taskTitle} triggered this: {stageLine} An automatic breakdown decision answered "replan": the plan itself is the problem, so the upcoming part must be rewritten instead of splitting this one task. Your only job in this session is the planning documents — {roadmapPath} and the task files under {tasks}/. Do not write or change application code, do not start any task, do not run the harness, and do not touch the design docs. Nobody can answer questions: make reasonable calls and record each one in {progress} under a "## Auto-replan notes" section.

Project root: {root}  (your working directory; never touch files outside it)

## Why this happened
- stage: {stage}
- task: {taskId} — {taskTitle} ({taskPhase}; status {status}; {attempts} session(s), {continuations} continuation slice(s))
- {evidenceLabel}: {evidence}
- the decision: {decisionReason}

### The task file as it stands
{taskBody}

## Required layout and formats
{contract}

## Current {roadmapPath}
{roadmapContent}

## Id blocks per phase (grow each track in its own block)
{idBlocks}

## What the linter found (fix every ✗; fix ! and · where the source material allows)
{findings}

## Current {docsDir}/ tree
{tree}

## Rules
- Preserve finished work. A task marked [x] or a blocked task has already run: never delete, renumber, retitle or repurpose it, and never reuse an id that has run for different work. If the new plan supersedes a blocked task, leave that task exactly as it is and add a new task that says so in its Context.
- Reshape only work that has not run: reorder tasks, re-size them, merge or split them, move work between them, and add new tasks.
- New tasks take a free id inside the id block of the phase they belong to (the per-phase next free ids above), so each track keeps growing in its own block instead of interleaving. A brand-new phase starts after the highest id currently in use (at least {nextId}). Never reuse an id; gaps between phase blocks are fine, and ids stay unique and increasing in file order.
- Remove the task file of any task you remove or replace; leave the files of tasks you keep.
- The triggering task {taskId} is part of what you may reshape: re-scope it, replace it, or remove it if the new plan makes it unnecessary.
- Rewrite every task file you change using the template: Goal / Context / Scope / Out of scope / Design notes / Done when / Hand-off. Size each for one unattended coding session in dependency order, and name at least one automated test under "Done when".
- Use "- [ ]" for work not yet done and "- [x]" only for work already finished. Never write "[~]" or a "⟵" tag; the harness owns those.
- Leave the pipeline status block at the end of {roadmapPath} (between the "symphony:status" HTML comments) alone; the harness regenerates it.
- Append a "## Auto-replan" section to {progress} summarising what changed and what the next task must know. Keep the existing sections.
- Do not create or edit anything under .symphony/. Do not commit or push; the harness commits after you finish.
- Run everything in the foreground and finish in this single turn.
- Before you end, run `{lintCommand}` and fix anything it still reports as ✗. Repeat until it prints "lint: ok".
- End your final message with exactly this block, as plain text, no code fence, nothing after it:

SYMPHONY_RESULT
status: <exactly one word: done, blocked, or failed>
summary: <one line: what changed in the plan, or what is missing>
END_SYMPHONY_RESULT

Use "blocked" only when the trigger reveals a human decision the plan cannot work around; say what is missing.