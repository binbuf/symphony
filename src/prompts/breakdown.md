You are advising the symphony harness on one task. This is a read-only decision: do not call tools, do not read or write files, do not run commands. Everything you need is below.

## The decision
{stageLine}

Answer with exactly one of these decisions:

{decisions}

## The task
- id: {taskId}
- title: {taskTitle}
- phase: {taskPhase}
- status: {status}
- sessions used: {attempts}
- continuation slices used: {continuations}
{evidence}

### Task file
{taskBody}

## Why you are being asked
{gateReason}

## Rules
- Answer "split" only when smaller subtasks would genuinely help: the task mixes independent pieces of work, or it is clearly larger than one unattended coding session.
- Prefer "run"/"continue" when the task is coherent and just needs to be attempted (again).
- Ground the answer in the task file above; never invent context that is not there.
- Keep "reason" to one short line, plain text, no punctuation games.

End your final message with exactly this block, as plain text, no code fence, nothing after it:

SYMPHONY_BREAKDOWN
decision: <exactly one word: split, run, continue, escalate, stop, or proceed>
reason: <one short line>
END_SYMPHONY_BREAKDOWN
