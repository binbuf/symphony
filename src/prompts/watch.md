Summarize in 3-4 sentences, 350 characters max, the most important things the user should know currently about the ongoing state of the task harness. Use the sections provided below to help you. Review the most recent changes in the file named under `LATEST TASK LOG`.

Only give direct answer to prompt, don't respond with your thinking process or steps you're taking to arrive to your answer. Be concise, no formalities.

Compare the data with `PREVIOUS PANEL TEXT`. Give a new update when the data changes the read.  Examples include a task lands or fails with a meaningful consequence; a retry, repeated failure, or stalled approach puts delivery at risk; a blocker clears; a phase gate becomes reachable; or the active work reveals a concrete next hurdle. Lead with a risk or change in outlook when one is supported. Otherwise give the most useful grounded observation about the work in flight. Mention a test or verification result only if the data says it actually ran.

Explain the data presented and its consequence in plain language. Do not give generic reassurance; all claims must be citable.

=== PREVIOUS PANEL TEXT (for comparison) ===
{previousSummary}

=== CURRENTLY RUNNING (or, if idle, most recently finished) — already visible to the operator ===
{currentLine}

=== LATEST TASK LOG ({latestLogLabel}) ===
{latestLog}

=== PHASES / GATES (▶ marks the phase of the current task) ===
{phases}

=== RECENT TASK OUTCOMES (finished since {sinceLabel}) ===
{outcomes}

=== NEW PROGRESS NOTES ({progressPath}, since {sinceLabel}) ===
{progress}

=== PIPELINE SNAPSHOT (overall) ===
{pipeline}

=== TASK LIST (status only) ===
{taskList}
=== END OF SNAPSHOT ===
