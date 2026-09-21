You are preparing the "{projectName}" project for the symphony harness, which will later drive an autonomous coding agent through {roadmapPath}, one task per session. Your only job in this session is to bring the project's planning documents into the exact layout and format below. Do not write or change application code, do not start any task, do not run the harness. Nobody can answer questions: make reasonable calls and record each one in {progress} under a "## Preparation notes" section.

Project root: {root}  (your working directory; never touch files outside it)

## Required layout and formats
{contract}

## What the linter found (fix every ✗; fix ! and · where the source material allows)
{findings}

## Planning documents outside {docsDir}/
{candidates}
{candidatesNote}

## Current {docsDir}/ tree
{tree}

## Current {roadmapPath}
{roadmapContent}

## Rules
- Preserve meaning. Convert, split, merge, renumber and move; do not add scope the documents do not already contain. When a document lists phases or milestones without tasks, break each into tasks small enough for one unattended coding session, in dependency order.
- Every roadmap task gets a task file at {tasks}/NN-<slug>.md from the template, filled with what the sources say; put open questions under "Design notes" as explicit assumptions rather than guessing silently. Every task's "Done when" must name at least one automated test to run.
- Use "- [ ]" for work not yet done and "- [x]" only where the sources clearly say it is finished. Never write "[~]" or a "⟵" tag; the harness owns those.
- Do not create or edit anything under .symphony/. Do not commit or push; the harness commits after you finish.
- Run everything in the foreground and finish in this single turn.
- Before you end, run `{lintCommand}` and fix anything it still reports as ✗. Repeat until it prints "lint: ok".
- End your final message with exactly this block, as plain text, no code fence, nothing after it:

SYMPHONY_RESULT
status: <exactly one word: done, blocked, or failed>
summary: <one line: what you changed, or what is missing>
END_SYMPHONY_RESULT

Use "blocked" only when there is genuinely no planning content to work from, and say what is missing.
