You are re-planning the "{projectName}" project for the symphony harness. The plan is being deliberately changed part-way through: the project is pivoting, so {roadmapPath} and the task files under {tasks}/{designPhrase} must be rewritten to match the new direction below, while preserving what has already been built and finished. Your only job in this session is the planning documents. Do not write or change application code, do not start any task, do not run the harness. Nobody can answer questions: make reasonable calls and record each one in {progress} under a "## Replan notes" section.

Project root: {root}  (your working directory; never touch files outside it)

## The new direction (authoritative)
{directionBody}

From: {directionPath}

## Required layout and formats
{contract}

## Current {roadmapPath}
{roadmapContent}

## What the linter found (fix every ✗; fix ! and · where the source material allows)
{findings}

## Current {docsDir}/ tree
{tree}

## Rules
- Preserve finished work. Do not delete, renumber or repurpose a task that already ran. If its work still stands, keep its id and title exactly. New tasks take the next free ids after the highest id currently in use (at least {nextId}), so no id is reused for different work.
- Never reuse the id of a task that already ran for different work. If the pivot invalidates a task that has not run, remove it and its file. If it invalidates finished work, add a new task that supersedes it and say so in that task's Context.
- Rewrite every task file for the new plan using the template: Goal / Context / Scope / Out of scope / Design notes / Done when / Hand-off. Size each for one unattended coding session in dependency order, and name at least one automated test under "Done when".
{designRules}
- Use "- [ ]" for work not yet done and "- [x]" only for work already finished. Never write "[~]" or a "⟵" tag; the harness owns those.
- Leave the pipeline status block at the end of {roadmapPath} (between the "symphony:status" HTML comments) alone; the harness regenerates it.
- Append a "## Replan" section to {progress} summarising what changed and what the next task must know. Keep the existing sections.
- Do not create or edit anything under .symphony/. Do not commit or push; the harness commits after you finish.
- Run everything in the foreground and finish in this single turn.
- Before you end, run `{lintCommand}` and fix anything it still reports as ✗. Repeat until it prints "lint: ok".
- End your final message with exactly this block, as plain text, no code fence, nothing after it:

SYMPHONY_RESULT
status: <exactly one word: done, blocked, or failed>
summary: <one line: what changed in the plan, or what is missing>
END_SYMPHONY_RESULT

Use "blocked" only when the direction is too vague to produce a plan, and say what is missing.
