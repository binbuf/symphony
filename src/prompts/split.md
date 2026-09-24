You are breaking one oversized task into smaller subtasks for the "{projectName}" project, for the symphony harness. An unattended agent session could not finish it as one task, so it must become a short series of tasks that run in its place. Your only job in this session is the planning documents. Do not write or change application code, do not start any task, do not run the harness. Nobody can answer questions: make reasonable calls and record each one in {progress} under a "## Split {taskId}" section.

Project root: {root}  (your working directory; never touch files outside it)

## The task to split
{taskId} — {taskTitle}  (phase: {taskPhase})
Task file: {taskFile}
Status: {parentStatus}

{parentBody}

{noteBlock}## Required layout and formats
{contract}

## Rules
- Replace the single {taskId} bullet in {roadmapPath} with {countRule}, in the same phase and at the same position: the tasks before and after it in the file must not move. {childIdRule}
- Every subtask bullet has exactly this form, with "- [ ]" (work not yet done) and no "⟵" tag:

    - [ ] {firstChild} — <short imperative title> → [{tasks}/{firstChildFile}-<slug>.md]({tasks}/{firstChildFile}-<slug>.md)

- {childFileRule}
- Write one task file per subtask, using the template: Goal / Context / Scope / Out of scope / Design notes / Done when / Hand-off. Inherit every still-relevant detail from the parent task file above — context, paths, constraints, design notes, out-of-scope items — distributing it across the children; do not lose work and do not duplicate it. Size each subtask for one unattended coding session, in dependency order (the first one first).
- {parentFileRule}
- Name at least one automated test under each subtask's "Done when".
- If the parent already produced work, check `git log --oneline -20` and `git status`, and say in the relevant subtask's Context what already exists in the tree and what remains.
- Leave the pipeline status block at the end of {roadmapPath} (between the "symphony:status" HTML comments) alone; the harness regenerates it.
- Append a "## Split {taskId}" section to {progress} summarising the split and what the first subtask must know. Keep the existing sections.
- Do not create or edit anything under .symphony/. Do not commit or push; the harness commits after you finish.
- Run everything in the foreground and finish in this single turn.
- Before you end, run `{lintCommand}` and fix anything it still reports as ✗. Repeat until it prints "lint: ok".
- End your final message with exactly this block, as plain text, no code fence, nothing after it:

SYMPHONY_RESULT
status: <exactly one word: done, blocked, or failed>
summary: <one line: the subtask ids and titles>
END_SYMPHONY_RESULT

Use "blocked" only when the task is too vague to split sensibly, and say what is missing.

## What the linter found before you started (fix every ✗)
{findings}

## Current {roadmapPath}
{roadmapContent}

## Current {tasks}/ tree
{tree}
