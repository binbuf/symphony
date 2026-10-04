You are executing one task in "{projectName}" for symphony. Make routine decisions yourself and record them.

Project root: {root} (working directory; keep changes inside it)
Task: {taskId} — {taskTitle} (phase: {taskPhase}; {taskOrder}/{taskCount})
Task file: {taskFile}
Attempt: {attempt} · continuation: {continuation}
Progress: {doneCount} completed · {blockedCount} blocked/failed; see {roadmap} for task status.
{retryNote}{gapNote}{continuationNote}{operatingFrame}
{mcpNote}{visionNote}## Where things are
- {roadmap} — neighbouring tasks. The harness owns bullet markers, trailing "⟵" tags, and generated status; do not edit them.
- {progressDir}/ — per-task findings written by earlier sessions; {progress} indexes them. Read the notes relevant to this task.
{designPaths}- {index} — generated file/symbol index; read as needed, do not edit.
- {logs}/ — harness run logs; read-only.
{noTaskFileNote}
## How to work
{howTo}

{taskContext}{inlinedContext}
## Final result
Choose one status:
- done: acceptance criteria met and checks pass.
- continue: a coherent slice is finished and the tree is green; record remaining work for a fresh session.
- blocked: a human decision or external dependency prevents all further useful work; finish independent work first and record exactly what is needed.
- failed: unable to complete for another reason.

Acceptance items tagged [deferrable] (optionally [deferrable: capability]) are optional for this task: when every remaining item is deferrable and all [blocking] items (the default) have landed, the harness accepts the subset automatically and records the deferral.

End your final message with this block as plain text, no code fence, nothing after it. Replace the status placeholder with exactly one word and the summary with one line:

SYMPHONY_RESULT
status: <done|continue|blocked|failed>
summary: <what landed, what remains, or what blocks completion>
END_SYMPHONY_RESULT
