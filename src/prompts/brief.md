<paste your idea here — replace this line, then give everything below to an LLM>

---

You are the planning lead for "{projectName}". Turn the idea above into a **symphony planning package**: the documents a coding harness needs to execute the work unattended, one task per fresh session. Do not write application code in this response. Output ONLY the files listed below, each as its own Markdown file at the exact path given (write the path as a heading or fenced-file marker so it can be saved).

## How symphony will use this

- It reads `{roadmap}` and runs the task bullets top-to-bottom, one fresh context per task, committing after each.
- Each task should be one small slice (roughly 1–3 hours) with an automated acceptance check.
- After a task reports done, the harness runs the project's test command (or a per-task `verify:`) itself; a non-zero exit fails the task.
- Later sessions read `{designDir}/`, `{index}` and the per-task notes under `{progressDir}/`; keep all of them accurate.

## First, decide the package shape

Start the roadmap with one line naming which of these this is:

1. **New standalone project** — use the default `{docs}/` package below.
2. **A new phase or workstream in a project that already runs symphony** — do NOT create a second package. Add a new `## Phase` with its own id block to the existing `{roadmap}`, extend the existing design docs and ADRs, and make the first tasks adapt rather than re-scaffold.
3. **An independent workstream that deserves its own task set** — say so and describe the `taskSets` entry the operator should add (a `name` and a `docs` directory) so this package lives beside the existing one instead of colliding with it.

## Required package

{contract}

{adrSection}

## Front-load the precursor work

Order the roadmap so these land before feature work:

- a task that scaffolds the repo and toolchain and leaves a **green, foreground test command** the harness can run as its verify step (this is what "done" is checked against);
- lint/format/typecheck wired up and passing;
- CI, environment/config handling and a secrets policy where the stack needs them;
- the initial `{designDir}/` docs (overview with goals *and* non-goals, data model, interfaces/APIs, testing strategy);
- for a greenfield build, a **walking skeleton** (the thinnest end-to-end path) and a short **spike on the riskiest assumption**, early, so later tasks extend something real.

Never re-scaffold what the chosen package shape already provides.

## Rules

- Every task's "Done when" names at least one automated test or command, with the exact command to run.
- Size every task for a single unattended session and put dependencies first.
- Where the idea is ambiguous, choose the simplest reasonable option and record it as an ADR rather than asking.
- Include a `.gitignore` for the target repo that lists `.symphony/`.