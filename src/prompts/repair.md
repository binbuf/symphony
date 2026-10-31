You are repairing a failed verification for task {taskId} — {taskTitle} in "{projectName}". The implementation session already ran; do not redo the task from scratch.

The harness ran the independent verification command and it failed:

- command: `{verifyCommand}`
- result: failed

```
{verifyOutput}
```

Changed files (the work that landed):
{changedFiles}

## Task contract

--- TASK FILE ({taskFile}) ---
{taskBody}
--- END TASK FILE ---

## Rules

- Fix only what makes the verification command fail. Do not expand the task's scope or rewrite unrelated work.
- Inspect `git status`, `git log -3`, and the failing tests first. Build on what is already there.
- Run the verification command in the foreground and keep iterating until it passes, or until you can name a concrete blocker.
- Do not change the task's `symphony-acceptance` block. Do not commit, push, switch branches, or amend/rebase commits you did not create.
- Update the task's Hand-off with what you changed and the exact remaining work.
- End this turn with exactly one result block, as plain text, no code fence, nothing after it:

SYMPHONY_RESULT
status: <done|continue|blocked|failed>
summary: <one line: what you repaired, or what still fails>
END_SYMPHONY_RESULT
