# symphony

**A thin harness that drives an LLM coding agent through your project's roadmap — one fresh session per task, a git commit after each, resumable, and safe to leave unattended.**

symphony lives in `<your target project>/.symphony/` (gitignored) and reads its plan from `<project>/docs/` and launches using your provider's LLM CLI tool.

Providers: **Claude Code · Cursor · OpenCode · Codex CLI · Gemini CLI · Google Antigravity** — all launched with permission prompts bypassed so nothing ever waits on a human (`--safe` turns that off for one run). Connectors/MCP configured inside each agent keep working: symphony only launches the CLI and reads its output.

**Contents** — [Why symphony](#why-symphony) · [Quick start](#quick-start) · [The lifecycle](#the-lifecycle) · [Run scenarios](#run-scenarios) · [Pivoting mid-run](#pivoting-mid-run) · [Multiple task sets](#multiple-task-sets) · [The docs contract](#the-docs-contract) · [CLI reference](#cli-reference) · [Providers](#providers) · [Escalation](#escalation) · [Jev](#jev) · [Config](#config) · [Hooks](#hooks) · [Logs and state](#logs-and-state) · [Platform support](#platform-support) · [Exit codes](#exit-codes) · [Developing the harness](#developing-the-harness)

## Why symphony

- **Unattended by default.** No session ever waits on a human. The harness handles the things that normally make you babysit an agent: transient API failures, oversized tasks, missing result blocks, runaway loops, and dirty worktrees.
- **Fresh context per task.** Every task starts in a brand-new session with only its task file, the digest and recent tail of `PROGRESS.md`, the design docs it names and a generated project index. No context rot, no hidden state carried from the previous task.
- **Everything lands in git.** Each task ends in a commit that carries the code, the roadmap marker, the task's hand-off, the design updates and the run log. `git log` is the pipeline's history; `git revert` is the undo.
- **Resumable and inspectable.** Kill it, crash it, or pause it with a file — state and roadmap markers let the next run pick up exactly where it left off. Every session's exact prompt, rendered log and raw NDJSON are saved.
- **Provider-agnostic.** The same plan and lifecycle work with any of the six agent CLIs, or the built-in `fake` provider for testing the harness itself without spending anything.
- **Guardrails you control.** An independent verify command after every `done` (your `verifyCommand`, a per-task `verify:`, or the project's `npm test`), retry/halt policies, per-task and per-run cost caps, and lifecycle hooks for notifications or CI.

## Quick start

### 1. Clone into your shared repos folder, then install into your project

```bash
# macOS / Linux — clone next to your other repositories
mkdir -p ~/repos && cd ~/repos
git clone https://github.com/binbuf/symphony.git      # or git@github.com:binbuf/symphony.git
cd symphony
./install.sh /path/to/your/project
```

```powershell
# Windows (PowerShell) — clone next to your other repositories
New-Item -ItemType Directory -Force "$HOME\repos" | Out-Null
Set-Location "$HOME\repos"
git clone https://github.com/binbuf/symphony.git      # or git@github.com:binbuf/symphony.git
Set-Location symphony
./install.ps1 -Target C:\path\to\your\project
```

The installer builds symphony in the clone (`npm install && npm run build`) and copies the compiled `dist/`, the launchers, this README and the config example into `<project>/.symphony/`. It also:

- writes `<project>/.symphony/.gitignore` containing `*`, so the installed harness stays untracked;
- appends `.symphony/` to your project's `.gitignore`;
- seeds `<project>/.symphony/symphony.config.json` from the example if it does not exist.

Re-run the installer any time to upgrade: build output is replaced, your config is left alone. Requirements: **Node ≥ 20.11** and **git**. The installed copy has no runtime dependencies.

### 2. (Optional) Pick a provider and configure it

symphony defaults to **Claude Code** (`claude`). Install and log in to the agent CLI you want first, then edit `<project>/.symphony/symphony.config.json`:

```json
{
  "provider": "opencode",
  "providers": {
    "opencode": { "model": "anthropic/claude-sonnet-4-5" }
  }
}
```

Or override per run: `./.symphony/symphony run --provider codex --model gpt-5`. The resolution order is `--provider/--model` > `SYMPHONY_PROVIDER`/`SYMPHONY_MODEL` > task front matter > config > defaults. Every key is optional; see [Providers](#providers) and [Config](#config). `doctor` verifies the chosen binary and its login before anything runs.

### 3. init → doctor → run

```bash
cd /path/to/your/project
./.symphony/symphony init      # scaffold docs/ (never overwrites anything)
./.symphony/symphony doctor    # preflight: node, git, roadmap, every provider a task uses + auth, verify, halt/STOP/lock
./.symphony/symphony run       # work through the roadmap, one fresh session per task
```

On Windows use `./.symphony/symphony.ps1` (or `.symphony\symphony.cmd` from `cmd.exe`). Every command accepts `--root DIR` to point at another project.

`init` creates the docs skeleton and a starting config. Then fill in the plan — one of three ways:

| you have… | do this |
|---|---|
| an idea, no plan | `./.symphony/symphony brief` prints a paste-ready prompt; give any LLM your idea plus that text and drop the files it returns into the project |
| a plan already | write `docs/ROADMAP.md` and `docs/tasks/NN-slug.md` yourself (templates are scaffolded) |
| planning docs in another shape | `./.symphony/symphony lint` shows what differs; `./.symphony/symphony prepare` lets the agent convert them in place and commits the result |

## The lifecycle

```
 install ──▶ init ──▶ doctor ──▶ run ─────────────────────────────────────────────┐
                                  │  per task, in roadmap order:                 │
                                  │    mark [~] running → spawn fresh session    │
                                  │    stream output → parse SYMPHONY_RESULT     │
                                  │    verify → log → commit → next task         │
                                  └── done ─ continue ─ blocked ─ failed ──▶ status / accept / reset / nudge
```

### Preflight — `doctor`

Run it before the first `run` and after changing providers or config. It checks, in order: Node version, that the project is a git repository (and whether the worktree is dirty), that `ROADMAP.md` exists and parses, that the binary of every provider a task will use is on `PATH` (per-task front matter included), that they are authenticated, that an independent verify command exists (warning when nothing will check a `done`), and whether a halt, STOP sentinel or another live run (lock) would block you. Failures exit `4`; warnings do not stop a run. `run` repeats these checks itself before every invocation.

### `init` — scaffold the plan

Creates the docs skeleton and config, never overwriting existing files:

```
docs/
  ROADMAP.md              the ordered task list (bullets the harness owns the checkbox of)
  PROGRESS.md             the shared notebook every session reads and appends to
  logs/README.md          explains the per-task run logs the harness regenerates
  tasks/TEMPLATE.md       the task-file template
  design/README.md        architecture docs the sessions read and update
  design/adr/0000-template.md
.symphony/symphony.config.json
.gitignore                adds .symphony/ and the stop sentinel
```

### `run` — the main loop

`run` walks the selected tasks in roadmap order. For each one:

1. **Marks the bullet** `[~] ⟵ running` and records the attempt in `.symphony/state.json`.
2. **Builds the prompt** and writes it to `.symphony/runs/<task>-<stamp>.prompt.md`. It contains the task file, a generated "Key facts" digest of `PROGRESS.md` plus its most recent sections, the design docs the task names (inlined, not just listed), the generated `docs/INDEX.md` (design-doc summaries + a source map), the rules for the session, and the required result block.
3. **Spawns the provider CLI** in the project root with permissions bypassed, and streams what it does:

   ```
   [init] session=... model=...
   [think] I should read the existing schema before adding the table
   [text]  Adding the migration.
   [tool]  Bash: npm test
   [tool-result] 42 passing
   [result] ok ($0.42 · 12 turns · 310s)
   ```

4. **Parses the result block** every session must end with:

   ```
   SYMPHONY_RESULT
   status: done | continue | blocked | failed
   summary: <one line>
   END_SYMPHONY_RESULT
   ```

   - `done` — acceptance criteria met and the named tests pass.
   - `continue` — a real slice landed but the task needs more. The harness commits the slice and starts a **fresh** session for the next one, up to `maxContinuations`. This is how a large task is split across manageable sessions without losing progress.
   - `blocked` — a human decision or external dependency is genuinely required.
   - `failed` — anything else.

5. **Verifies independently.** A per-task `verify:` (front matter) wins, then `verifyCommand`; when neither is set the harness uses the project's `package.json` test script (`npm test`) if one exists (`inferVerify: false` disables that). It runs the command itself after a `done`. A non-zero exit demotes the task to `failed` and records the command, exit code and output tail in the logs. Provider-agnostic: any command, any stack.
6. **Writes the record.** `docs/logs/TNN.md` (status, provider/model, timing, cost, commit, each session's reported status and summary), then regenerates the pipeline status block at the bottom of `ROADMAP.md`.
7. **Commits everything** with `git add -A && git commit -m "T01: <title> [<status>]"` (template configurable). Before staging, an ephemeral-file guard keeps secrets and build junk out of the commit by adding them to `.gitignore` — agent-created source files still land. A failed commit is retried once; if it still fails the task is demoted to `failed` rather than recorded `done`, because its work is not in git. Commits also refuse to run if a session switched branches (`HEAD` is checked against the branch the run started on).
8. **Starts the next task in a new session.** Each session is also instructed to append a `## Txx` section to `PROGRESS.md`, fill the task file's `## Hand-off`, run the named tests in the foreground, and update the design docs/ADRs its work touched.

### Mid-run: how the harness keeps going

| event | what happens |
|---|---|
| session ends cleanly but with **no result block** | it is resumed once with a close-out prompt (a "nudge"); `--no-nudge` disables |
| **transient error** — rate limit, overloaded, 5xx, network drop, stalled output, crash | retried in place with backoff (30 s, 2 min, 5 min), **resuming the same session** when the provider supports it, so work is kept |
| **fatal error** — auth, no credits, usage limit, unknown model, bad config, missing binary | the run **halts**: banner, exit `3`, sticky in `state.json`; later `run`s refuse to start |
| task fails **twice in a row**, or one task fails **3 times** | the run halts (thresholds configurable) |
| `continue` past `maxContinuations` | treated as failed |
| `maxIterationsPerTask` / `maxTasksPerRun` / `--budget` reached | the task fails gracefully, or the run processes only the first N tasks, with a clear summary |
| `touch .stop` (path configurable) | pauses at the next boundary — before the next task, or after the current slice when a task is split via `continue` — exit `0`; nothing is killed, and a mid-continuation pause resumes the right slice next run. `touch .symphony/STOP` is the legacy alias |
| commit fails (pre-commit hook, signing, `index.lock`) or a session switched branches | retried once; if it still fails the task is demoted to `failed` instead of recorded `done`, because its work did not land in git |
| reported session cost crosses `maxCostUsdPerRun` | halts the run before the next task; `clear-halt` to continue |
| Ctrl-C | kills the current session, records the task unfinished, exits `130`; press twice to force quit |
| another run already active | refuses to start, exit `4` (lock file holds the live pid and a heartbeat) |

### After the run: review and steer

| command | what it does |
|---|---|
| `status [--json]` | progress table: id, phase, title, status, attempts, duration, start/end, cost, provider, summary. A task split across sessions or retried (attempts ≥ 2) also lists one line per session run beneath its parent line, each with its own start/end, duration and summary |
| `accept T05 [--note "…"]` | human sign-off on a blocked/failed task; counts as done, bullet becomes `[x] ⟵ accepted` |
| `nudge T05 [--note "…"]` | resume the task's last session and ask it to close out with a result block |
| `reset T05 [--revert]` | clear a task's state so it runs again; `--revert` also `git revert`s its `T05:` commits (newest first) |
| `reset --all` | clear every task's state and the halt, and reset every roadmap marker to `[ ]`, so a replaced or rewritten roadmap starts clean |
| `replan [--direction FILE] [--allow-id-reuse] [--reset-state] [--dry-run]` | stop-and-pivot: let the agent rewrite the plan (roadmap, task files, design docs, a pivot ADR) for a new direction, reconcile state, and commit it as a docs change |
| `clear-halt` | lift a halt so `run` can start again |

`status` shows `running?` for a task whose recorded process is gone (harness crashed); the next `run` retries it. A human ticking `[x]` in `ROADMAP.md` is honoured by the next command that loads the project.

## Run scenarios

Everything that can happen to a task, and what you do about it.

| # | scenario | what the harness does | roadmap / state | exit | what you do |
|---|---|---|---|---|---|
| 1 | task reports `done`, verify passes | commits the task; starts the next task in a new session | `[x]` | – | nothing |
| 2 | task reports `continue` | commits the slice; starts a fresh session for the next slice (≤ `maxContinuations`) | `[~] ⟵ running` between sessions | – | nothing |
| 3 | `continue` past the limit | marks the task failed | `[~] ⟵ failed` | 2 | split the task file, or raise `maxContinuations` |
| 4 | task reports `blocked` | stops for a human (default); `onBlocked: "continue"` moves on instead | `[~] ⟵ blocked` | 2 | read the task's Hand-off; `accept T05 --note "…"` or `run --retry --only T05` |
| 5 | task reports `failed` | stops | `[~] ⟵ failed` | 2 | fix the cause, then `run` (failed tasks are retried) |
| 6 | `done` but verify fails | demotes to failed; records command, exit code and output tail | `[~] ⟵ failed` | 2 | fix, then `run` |
| 7 | session ends without a result block | resumes it once to close out | `[~] ⟵ running` while nudging | – | nothing (or `--no-nudge` and accept that it fails) |
| 8 | transient error | retries with backoff, resuming the session | `[~] ⟵ failed` while retrying | – | nothing |
| 9 | fatal error (auth, billing, usage limit, model, config) | halts the whole run; sticky until cleared | halt banner in `status` | 3 | fix the cause, `clear-halt`, `run` |
| 10 | 2 failures in a row / 3 attempts on one task | halts | halt banner in `status` | 3 | fix, `run --clear-halt --retry --only T05` |
| 11 | `.stop` sentinel present | pauses at the next boundary (before a task, or after a `continue` slice); a mid-continuation pause is remembered and resumes the next slice | – | 0 | `rm .stop`, `run` |
| 12 | Ctrl-C | kills the current session; task recorded unfinished (failed) | `[~] ⟵ failed` | 130 | `run` retries it |
| 13 | second run while one is active | refuses to start | lock file with live pid | 4 | wait, or delete `.symphony/lock` if stale |
| 14 | `maxIterationsPerTask` / `maxTasksPerRun` / budget hit | task fails gracefully, or the run processes only the first N tasks | task `failed` / rest `pending` | – | raise the limit, or split the task |
| 15 | you tick `[x]` by hand | next load reconciles state to the roadmap tick | `[x]` | – | nothing |
| 16 | `reset T05 --revert` | clears state and reverts the task's commits newest-first; on conflict it stops and tells you to resolve | `[ ]` pending | 0 | fix conflicts if any, then `run` |

The pipeline stops for a human only when a task itself reports `blocked`, or a fatal provider/config problem halts the run. Everything else — transient errors, large tasks, missing result blocks — is handled by retry, continuation and nudge.

## Pivoting mid-run

Sometimes you discover half-way through that the design is wrong. symphony does not re-plan a running task; it pauses at a task boundary, re-plans the docs, commits the pivot, and resumes with fresh context.

1. **Pause cleanly.** `touch .stop` — the current slice finishes and commits, then `run` exits `0` before the next task or the next continuation session. A task split via `continue` remembers which slice it reached and resumes there. (Ctrl-C mid-task also works but records that task `failed`; prefer the sentinel.)
2. **Write the new direction.** Put it in `docs/REPLAN.md` (or pass `--direction FILE`): what changed, what still stands, what to drop. This is the one input the harness does not own, so keep it outside the docs contract.
3. **Let the agent re-plan.** `symphony replan` hands the direction, the current roadmap, `PROGRESS.md`, the design docs and the live code state to one session, which rewrites `ROADMAP.md`, the task files and the design docs and records the pivot as a superseding ADR. It re-lints and commits the result as `docs: replan … [replan]`, so the pivot is a normal commit you can review or `git revert`.
4. **Reconcile state.** `replan` prunes state rows for tasks that no longer exist, and refuses to reuse an id that already ran for different work unless you pass `--allow-id-reuse`. `--reset-state` clears all state instead; `reset --all` does the same on its own.
5. **Resume.** Remove the sentinel (`rm .stop`) and `symphony run`.

Why not re-plan inside a running session? The one-fresh-session-per-task model is the whole point: a session gets its task and nothing else, and a task that changes underneath it is exactly the context rot symphony exists to avoid. Pause, re-plan, commit, resume — the pivot stays auditable in `git log`.

## Multiple task sets

By default symphony reads one plan: the base docs package (`docs/ROADMAP.md`, `docs/tasks/`, `docs/PROGRESS.md`, `docs/design/`). A project can also declare **additional, independent task sets** in `.symphony/symphony.config.json`. Each set has its own roadmap, tasks, progress, design docs and logs, and its own harness state under `.symphony/sets/<name>/`, so task ids never collide with another set. The base package stays the default; a set runs only when you select it.

This is how symphony lives at a project's side across time: keep the base plan, and add a new set when the project takes on a new phase of work — a migration, an audit, a second product surface — instead of installing symphony for one run and removing it. Each set's `PROGRESS.md` and design docs carry the context of that set's earlier sessions into the next task.

```json
{
  "taskSets": [
    { "name": "phase-2", "docs": "docs/phase-2" },
    { "name": "audit",   "docs": "docs/audit", "design": "docs/design" }
  ]
}
```

Each entry has a `name` and any of the same keys as `paths` (`docs`, `roadmap`, `progress`, `tasks`, `design`, `adr`, `logs`, `index`). A set must name `docs` or `roadmap`, so it can never silently reuse the base package. Planning locations stand on their own — a set's `docs` does not inherit the base `paths` overrides — but you can point a set at a shared location on purpose, like the `audit` set sharing `docs/design` above.

Select a set with `--set NAME`, which every command accepts:

```bash
./.symphony/symphony init --set phase-2     # scaffold that set's docs package
./.symphony/symphony doctor --set phase-2   # preflight that set
./.symphony/symphony run    --set phase-2   # run that set's roadmap
./.symphony/symphony status --set phase-2   # progress for that set
```

Without `--set`, commands use the base package exactly as before. The `paths.state`/`runs`/`log` overrides give each set isolated harness state by default (`.symphony/sets/<name>/state.json`, `/runs/`, `/symphony.log`); set them explicitly in the entry to relocate. The graceful-pause sentinel (`.stop`) is project-wide — one sentinel pauses whichever set is running.

`status` and `status --json` name the active set, so it is always clear which plan a table describes. An unknown `--set` name fails fast with the list of declared sets.

## The docs contract

symphony owns a small, stack-agnostic planning format. `init` scaffolds it, `lint` checks it, `prepare` repairs it, `brief` generates it, and every session is told to maintain it.

```
docs/
  ROADMAP.md            phases as "##" headings; one top-level bullet per task, in execution order
  PROGRESS.md           the agent's shared notebook (learnings for later tasks); created if missing.
                        The harness keeps a generated "Key facts" digest at the top and inlines the
                        digest plus the most recent sections into each prompt
  INDEX.md              generated repo map: one-line design-doc summaries and a source-file map with
                        top-level symbols; rewritten before each task and committed with it
  logs/TNN.md           the harness's per-task run log: status, provider/model, timing, cost and each
                        session's reported status + summary; regenerated after every task
  tasks/NN-slug.md      one detail file per task: Goal / Context / Scope / Out of scope / Design notes /
                        Done when / Hand-off
  tasks/TEMPLATE.md     the template `init` writes
  design/*.md           architecture docs the agent reads before coding and updates when behaviour changes
  design/adr/NNNN-*.md  architecture decision records the agent adds when a decision constrains later tasks
```

### Roadmap bullet syntax

The harness owns the checkbox and the trailing tag; edit everything else freely.

```markdown
## Phase 1 — Foundation
- [ ] T01 — Scaffold the project → [tasks/01-scaffold.md](tasks/01-scaffold.md)   not started
- [~] T02 — Add CI ⟵ failed                 unfinished: interrupted, blocked on a human, or needs a rerun
- [x] T03 — Database schema                 done
- [x] T04 — Auth spike ⟵ accepted           signed off by a human with `accept`
```

Ids are `T01`, `T02`, … (`01 —` and `3.` also parse). Task files are matched by the link, else by the `NN` filename prefix. A bullet with no task file still runs; the agent is told to create the file first. A task file may start with front matter to override the provider, model, timeout or verify command for that task only:

```markdown
---
provider: gemini
model: gemini-2.5-pro
timeoutMin: 90
verify: npm test -- --runInBand
---
```

At the end of every task the harness also rewrites a **pipeline status block** at the bottom of `ROADMAP.md` (between `<!-- symphony:status -->` and `<!-- /symphony:status -->`): what is done, blocked, failed and left, the last finished task and any halt. It is the one place to see the pipeline's high-level state at a glance. Do not edit that block by hand; everything outside the markers stays yours.

**Starting from an idea?** `symphony brief` prints a prompt. Give any LLM your idea plus that text; it emits the docs package in this format, and you drop the files into the project next to `.symphony/`.

**Already have planning docs in another shape?** `symphony lint` scans the project root and docs and reports what differs: `ROADMAP.md`/`PLAN.md`/`TASKS.md` at the root or under `docs/`, `tasks/`, `specs/`; task lines that won't parse (numbered lists, headings, nested bullets, bold ids); wrong-case filenames; ADRs outside `design/adr/`; task files missing sections; broken links. `symphony prepare` hands that report, the outside documents and the format contract to the configured agent for one session, which converts everything in place (`git mv` for moves, meaning preserved, no invented scope), then the harness re-lints and commits. `prepare --dry-run` prints the exact prompt and touches nothing.

### Greenfield vs. existing project

The contract is stack-agnostic. For a greenfield project the early tasks scaffold the repo, tooling and a passing test command before feature work; for an existing codebase the tasks describe incremental feature/fix work and are told never to re-scaffold. Point `paths.docs` at an existing `docs/` or `specs/` tree, or run `prepare` to convert whatever planning shape you already have.

### Tasks only, no design folder

Set `"designDocs": false` to run a plain series of tasks: the harness does not create, require, lint or prompt for `design/` or `adr/`, and no ADR/design-update work is asked of sessions. `docs/` still holds `ROADMAP.md`, `PROGRESS.md` and `tasks/`. Toggle it and re-run `init` or `prepare` to apply.

## CLI reference

Every command accepts `--root DIR` (default: the project containing `.symphony/`) and `--set NAME` (run a declared task set instead of the base docs package; see [Multiple task sets](#multiple-task-sets)). `symphony --version` prints the version. Exit codes are listed [below](#exit-codes).

| command | what it does |
|---|---|
| `run` | run every unfinished task in roadmap order, committing after each; resumes where it left off |
| `run --prepare` | run `prepare` first, then start only if `docs/` lints clean |
| `status [--json]` | progress table with each task's duration and start/end datetime stamps (a live `(running)` elapsed time while one is in flight), or machine-readable JSON. Tasks split across sessions or retried (attempts ≥ 2) list each session run beneath the parent line with its own start/end, duration and summary |
| `logs [T05]` | print a task's per-run log (`docs/logs/T05.md`); with no id, list the log files |
| `doctor` | preflight: node, git repo, roadmap, provider binary + auth, verify command, halt / STOP / lock |
| `init` | create the docs skeleton, `tasks/TEMPLATE.md`, `design/adr/0000-template.md`, config, `.gitignore` entry |
| `lint` | check the project root and docs against the expected layout; no LLM; exit 2 on errors |
| `prepare [--dry-run]` | lint, then let the configured agent convert/repair the docs in place, re-lint, commit |
| `replan [--direction FILE] [--allow-id-reuse] [--reset-state] [--dry-run]` | let the configured agent rewrite the plan for a new direction and commit it; see [Pivoting mid-run](#pivoting-mid-run) |
| `brief` | print a paste-ready prompt so any LLM turns an idea into the docs package in this exact format |
| `accept T05[,T06…] [--note "…"]` | human sign-off on one or more blocked/failed tasks; counts as done, bullet becomes `[x] ⟵ accepted` |
| `reset T05 [--revert]` | clear a task's state so it runs again; `--revert` also undoes its `T05:` commits (newest first) |
| `reset --all` | clear every task's state and the halt, and reset every roadmap marker to `[ ]` |
| `nudge T05 [--note "…"]` | resume a task's last session and ask it to close out with a result block |
| `clear-halt` | lift a halt so `run` can start again |

### `run` flags

| flag | meaning |
|---|---|
| `--prepare` | run `prepare` first; abort the run if the docs still do not lint clean |
| `--provider P`, `--model M` | override provider/model for this run (see precedence above) |
| `--from T03`, `--to T10`, `--only T05,T06` | restrict which tasks are selected |
| `--set NAME` | run a declared task set's plan instead of the base docs package |
| `--retry` | re-run selected tasks even if they are done, accepted or blocked |
| `--continue-on-failure` | keep going past failed/blocked tasks instead of stopping |
| `--dry-run` | print the prompt and exact provider command for each selected task; run nothing |
| `--safe` | do not bypass permission prompts (see the note under Providers) |
| `--no-nudge` | disable the automatic resume when a session omits its result block |
| `--timeout-min N` | wall-clock cap per session (default 240) |
| `--max-tasks N` | process at most N tasks this run |
| `--max-iterations N` | at most N sessions per task, retries and continuations included |
| `--budget USD` | per-task budget (Claude only) |
| `--max-cost USD` | stop the run once reported session cost reaches this (`maxCostUsdPerRun`; 0 = off) |
| `--clear-halt` | clear a sticky halt and start |

## Providers

| provider | binary | how it is launched | bypass flag (default) | `--safe` |
|---|---|---|---|---|
| `claude` | `claude` | `-p --output-format stream-json --verbose`, prompt on stdin | `--dangerously-skip-permissions` | `--permission-mode acceptEdits --permission-prompts none` |
| `cursor` | `agent` | `-p --output-format stream-json --workspace <root> --trust` + prompt-file bootstrap | `--force` | no `--force` |
| `opencode` | `opencode` | `run --standalone --format json --thinking --file <prompt>` + bootstrap | `--auto` | no `--auto` |
| `codex` | `codex` | `exec --json --color never --skip-git-repo-check --cd <root> -`, prompt on stdin | `--dangerously-bypass-approvals-and-sandbox` | `--sandbox workspace-write --ask-for-approval never` |
| `gemini` | `gemini` | `--output-format json --prompt <bootstrap>` (prompt-file) | `--yolo` | no `--yolo` |
| `antigravity` | `agy` | `-p --output-format json --workspace <root>` + prompt-file bootstrap | `--dangerously-skip-permissions` | no bypass flag |
| `fake` | node | replays an NDJSON fixture; for tests | | |

- **Models:** pass `--model`, or set `providers.<name>.model`. Current ids per provider are listed in [Models.md](Models.md); OpenCode addresses models as `provider/model` (browse <https://openrouter.ai/models>). Ids churn, so confirm against each CLI's own listing.
- **Session resume** for retries and nudges uses `--resume` (Claude, Cursor), `--session` (OpenCode) and `exec resume <id>` (Codex); Gemini and Antigravity do not advertise resume, so retries start fresh.
- **Cost** is surfaced for Claude (per session) and OpenCode (cumulative); `--budget` is Claude-only. Codex reports token usage instead.
- **Correcting an adapter:** each provider's argv can be adjusted for your install with `providers.<name>.bin` and `providers.<name>.extraArgs`; unknown stream shapes are parsed best-effort.
- **Prompt size:** prompts are always written to a file first; providers get them over stdin, as an attached file, or via a short bootstrap that names the file, so OS command-line limits are never a problem.

## Escalation

By default, a task the configured model cannot finish is failed. Escalation gives it a second, stronger pair of hands: when a task reports `failed`, the harness's own `verify` command rejects a `done`, or the model burns through `maxContinuations` slices, the task is handed to a second provider/model for a fresh session. Infrastructure failures — auth, rate limits, timeouts — are never escalated; the retry and halt logic owns those.

It is off by default, and the shipped default target is OpenCode running **GLM-5.3** (`z-ai/glm-5.3`). Turn it on with:

```json
"escalation": {
  "enabled": true,
  "provider": "opencode",
  "model": "z-ai/glm-5.3",
  "maxAttempts": 1,
  "onCategories": ["task", "verify"]
}
```

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | turn escalation on |
| `provider` | `opencode` | provider the escalated sessions run on; set it to your own provider for a same-provider model bump |
| `model` | `z-ai/glm-5.3` | model the escalation provider runs (OpenCode wants `provider/model`) |
| `maxAttempts` | `1` | escalation sessions a single task may take before it is failed for good |
| `onCategories` | `[task, verify]` | the give-up reasons that escalate: `task` covers a reported `failed` and the continuation limit, `verify` a rejected `done` |

Escalation is bounded: `maxAttempts` caps it, and `maxIterationsPerTask` still caps the task as a whole, so a task can never ping-pong between models forever. Every session records the provider and model that ran it in `docs/logs/TNN.md`, so an escalated task is visible in the committed log. The escalation provider is also checked during preflight, so a missing binary is reported before the run starts rather than mid-task.

## Jev

**Jev** — TypeSafe's System One decision model — makes fast, typed calls that replace brittle hand-written decisions in the harness. It is reached through [OpenRouter](https://openrouter.ai/settings/keys), so your OpenRouter key is all you need. Jev is off by default and never on the fatal path: every workflow falls back to the harness's own deterministic behavior on a missing key, a timeout, or a low-confidence answer.

It runs up to three independent **workflows**, each behind its own flag:

```json
"jev": {
  "enabled": true,
  "resultFallback": true,
  "failureTriage": true,
  "escalationDecision": true,
  "provider": "openrouter",
  "model": "jev-latest",
  "apiKeyEnv": "OPENROUTER_API_KEY",
  "timeoutMs": 4000,
  "minConfidence": 0.7,
  "acceptStatuses": ["done", "continue"]
}
```

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | master switch for every workflow below |
| `resultFallback` | `true` | settle a session that omitted its `SYMPHONY_RESULT` block |
| `failureTriage` | `true` | place a failure the regex classifier could not |
| `escalationDecision` | `true` | decide whether a failed task is worth escalating |
| `provider` | `openrouter` | where the System One call goes; `baseUrl` overrides it |
| `baseUrl` | – | override the provider's base URL (e.g. a self-hosted gateway) |
| `model` | `jev-latest` | System One model id; `jev-latest` tracks the newest Jev release |
| `apiKeyEnv` | `OPENROUTER_API_KEY` | environment variable holding the bearer token |
| `timeoutMs` | `4000` | hard cap on one call; on timeout the deterministic path runs |
| `minConfidence` | `0.7` | below this the answer is discarded and the deterministic path runs |
| `acceptStatuses` | `[done, continue]` | dispositions `resultFallback` may settle |

### `resultFallback`

A session that ended cleanly without a `SYMPHONY_RESULT` block is normally recovered by **nudging**: resuming it and asking it to report, at the cost of a whole extra session. With this on, Jev reads the task title and the tail of the output and answers a `choice` — `done`, `continue`, `blocked`, or `failed`. A confident answer in `acceptStatuses` settles the session and skips the nudge; otherwise the nudge runs exactly as before.

`acceptStatuses` defaults to `done` and `continue` on purpose: those are the safe, high-value cases, while ending a task as `blocked` or `failed` stays with the agent. A Jev-classified `done` still has to pass the harness's own `verify`, so it cannot smuggle a finished-looking session past the independent check.

### `failureTriage`

`classifyFailure` is a set of hand-written regex rules over the provider's error text. When none match, the failure lands in `unknown`, which the harness treats as terminal and does not retry. With this on, that `unknown` is put to a `choice` — `auth`, `billing`, `usage_limit`, `rate_limit`, `overloaded`, `server`, `network`, `model`, `config`, or `task` — and the answer is mapped back through the harness's own fatal/transient rules, so a `server` or `rate_limit` becomes a retry that might have succeeded anyway. The regex stays primary: Jev is consulted only when the rules admit they do not know. Unlike the others, this workflow can halt a run (a Jev-classified `auth` is fatal), so tune `minConfidence` against your own error logs before leaving it unattended.

### `escalationDecision`

When [escalation](#escalation) is enabled and a task fails on an `onCategories` trigger, Jev reads the **task** (title and body) plus the failure and answers a `choice`: would a more capable model plausibly complete this from the same context, or is the task stuck on missing context or a human decision a stronger model cannot supply either? If Jev confidently says a stronger model would not help, the harness skips the escalation session and fails the task as it otherwise would.

This is a gate, not a router: `onCategories` is still the trigger, infrastructure failures still never escalate, and any Jev problem escalates as configured. Jev can only *decline* an escalation — it never adds one.

`symphony doctor` reports which workflows are armed and whether the key is present.

## Config

Every key is optional and lives in `.symphony/symphony.config.json`. CLI flags and environment variables override it per run. Keys beginning with `_` are ignored, so you can leave notes in the file — the example uses `_models` to point at [Models.md](Models.md).

| key | default | meaning |
|---|---|---|
| `provider` | `claude` | `claude` · `cursor` · `opencode` · `codex` · `gemini` · `antigravity` |
| `providers.<name>.bin` `.model` `.extraArgs` `.budgetUsd` `.idleTimeoutMin` | see `symphony.config.example.json` | binary, model, extra CLI args, per-task budget (Claude), stall timeout override |
| `paths.docs` | `docs` (legacy `.docs` honoured) | planning package directory |
| `paths.roadmap` `.progress` `.tasks` `.design` `.adr` `.logs` `.index` | derived from `paths.docs` | individual overrides, absolute or root-relative |
| `paths.stop` | `.stop` | graceful-pause sentinel (absolute or root-relative) |
| `paths.state` `.runs` `.log` | under `.symphony/` | where harness state, session logs and the event log live |
| `taskSets` | `[]` | extra, independent task sets: `[{ "name": "phase-2", "docs": "docs/phase-2" }]`, each with its own roadmap/tasks/progress/design and state under `.symphony/sets/<name>/`; run one with `--set NAME` (see [Multiple task sets](#multiple-task-sets)) |
| `autoApprove` | `true` | bypass permission prompts (`--safe` sets false for one run) |
| `nudge`, `nudgeTimeoutMin` | `true`, `45` | resume once to collect a missing result block |
| `timeoutMin`, `idleTimeoutMin` | `240`, `20` | max wall clock per session; kill after this long with no output |
| `prepareTimeoutMin` | `60` | wall clock for the `prepare` session |
| `maxProgressBytes` | `32768` | byte cap for the recent `PROGRESS.md` sections inlined into each prompt |
| `progressDigest` | `true` | maintain a generated "Key facts" digest at the top of `PROGRESS.md` and inline it ahead of the recent sections |
| `inlineDesignDocs` | `true` | inline the design docs a task names in its Context / Design notes, not just list them |
| `repoMap` | `true` | generate `docs/INDEX.md` (design-doc summaries + a source map) before each task and inline it |
| `maxIndexBytes` | `16384` | byte cap for the inlined repo map |
| `maxTaskBytes` | `32768` | byte cap for the inlined task file body (the full file stays on disk) |
| `designDocs` | `true` | when `false`, `design/` and `adr/` are neither required nor used: tasks run standalone |
| `maxContinuations` | `4` | extra fresh sessions a task may take after reporting `continue`; counted across a `.stop` pause so pausing does not reset the budget |
| `maxIterationsPerTask`, `maxTasksPerRun` | `0`, `0` | provider-agnostic caps (0 = unlimited): sessions per task in a run, and tasks per run |
| `maxCostUsdPerRun` | `0` | stop the run when the session cost reported during this invocation reaches this many USD (0 = unlimited; providers that do not report cost cannot be capped) |
| `commitPerSession` | `true` | commit each `continue` slice, not just the final result |
| `onBlocked` | `stop` | `stop` at a blocked task for a human, or `continue` to the next task |
| `verifyCommand`, `verifyTimeoutMin` | –, `30` | shell command the harness runs itself after `done`; non-zero demotes to failed (per-task `verify:` wins) |
| `inferVerify` | `true` | when no verify command is configured, use the project's `package.json` test script (`npm test`) |
| `hooks.afterTask` `.onBlocked` `.onHalt` `.onRunEnd` | – | shell commands run on lifecycle events (see [Hooks](#hooks)) |
| `git.autoIgnoreUntracked`, `git.extraIgnore` | `true`, `[]` | before committing, keep untracked ephemeral/secret files out of the commit by adding their patterns to `.gitignore` |
| `retry.maxAttempts`, `retry.backoffSec` | `3`, `[30,120,300]` | transient-error retries |
| `halt.maxConsecutiveFailures`, `halt.maxAttemptsPerTask`, `halt.onCategories` | `2`, `3`, `[auth, billing, usage_limit, model, config]` | when to halt instead of continuing |
| `escalation.enabled`, `.provider`, `.model`, `.maxAttempts`, `.onCategories` | `false`, `opencode`, `z-ai/glm-5.3`, `1`, `[task, verify]` | hand a task the workhorse model failed to a stronger provider/model (see [Escalation](#escalation)) |
| `jev.enabled`, `.resultFallback`, `.failureTriage`, `.escalationDecision`, `.provider`, `.model`, `.apiKeyEnv`, `.timeoutMs`, `.minConfidence`, `.acceptStatuses` | `false`, `true`, `true`, `true`, `openrouter`, `jev-latest`, `OPENROUTER_API_KEY`, `4000`, `0.7`, `[done, continue]` | Jev decision workflows, each behind its own flag (see [Jev](#jev)) |
| `commitMessageTemplate` | `{id}: {title} [{status}]` | |

## Hooks

Four optional shell hooks let the harness notify or trigger anything without built-in integrations. Each runs in the project root with the event in its environment; a hook that fails only warns and never breaks the run.

| hook | when | environment |
|---|---|---|
| `hooks.afterTask` | after every task finishes | `SYMPHONY_TASK`, `SYMPHONY_TITLE`, `SYMPHONY_STATUS`, `SYMPHONY_SUMMARY`, `SYMPHONY_COMMIT`, `SYMPHONY_PROVIDER`, `SYMPHONY_MODEL`, `SYMPHONY_COST` |
| `hooks.onBlocked` | a task reports `blocked` | `SYMPHONY_TASK`, `SYMPHONY_TITLE`, `SYMPHONY_SUMMARY` |
| `hooks.onHalt` | the run halts on a fatal error | `SYMPHONY_TASK`, `SYMPHONY_HALT_CATEGORY`, `SYMPHONY_HALT_REASON` |
| `hooks.onRunEnd` | `run` finishes | `SYMPHONY_EXIT`, `SYMPHONY_STATUS` (`ok` · `stopped` · `halted` · `error`), `SYMPHONY_COST` |

All hooks also get `SYMPHONY_ROOT`. Example:

```json
{ "hooks": { "afterTask": "curl -fsS -d \"$SYMPHONY_TASK $SYMPHONY_STATUS\" $WEBHOOK || true" } }
```

## Logs and state

```
docs/logs/T05.md                               per-task run log: start stamp at the top, finish stamp at the bottom, plus status, provider/model, timing, cost and each session's summary
docs/INDEX.md                                  generated repo map, rewritten before each task and committed with it
.symphony/runs/T05-20260917T231530.jsonl       raw provider NDJSON, byte-faithful
.symphony/runs/T05-20260917T231530.log         rendered [think]/[text]/[tool] stream, longer lines than stdout
.symphony/runs/T05-20260917T231530.prompt.md   the exact prompt sent
.symphony/runs/prepare-<stamp>.*               the prepare session, same three files
.symphony/symphony.log                         harness events: task start/finish, retries, halts, commits
.symphony/state.json                           per-task state and the halt flag; delete it and progress is rebuilt from the roadmap markers
```

Every task gets a `docs/logs/TNN.md` (path overridable with `paths.logs`). It opens with the task's start timestamp and closes with its finish timestamp, and is rewritten in full after each session and committed with the task, so `git log` plus the logs give a per-task and pipeline-wide history. It also records the verify command's result when one is configured. `symphony logs T05` prints one from the terminal. Retries append `-r2`, nudges `-nudge`, continuation sessions `-rN` too. `paths.state`/`.runs`/`.log` move these.

## Platform support

macOS, Linux and Windows are first-class. On Windows the agent process tree is killed with `taskkill /T /F`, and `symphony.ps1` / `symphony.cmd` are provided alongside the POSIX launcher. `install.sh` and `install.ps1` are equivalent. Session process groups are used on POSIX; on Windows `detached` is disabled because there are no process groups. `npm run clean` and the test script avoid POSIX-only commands.

## Exit codes

| code | meaning |
|---|---|
| 0 | ok, or paused at a STOP sentinel |
| 1 | unexpected error |
| 2 | stopped on a blocked/failed task (or lint errors from `lint`) |
| 3 | halted |
| 4 | usage, preflight or lock failure |
| 130 / 143 | interrupted (SIGINT / SIGTERM) |

## Developing the harness

```bash
npm install
npm run dev -- run --root /path/to/project       # run from source via tsx
npm test                                          # node --test
npm run typecheck && npm run build                # tsc → dist/
node dist/tools/parse-check.js claude session.jsonl [--render]   # replay a provider log through the parser
```

The `fake` provider replays Claude-format NDJSON fixtures from `SYMPHONY_FAKE_FIXTURES` (default `.symphony/fixtures`), matched in order `<taskId>.<kind>.jsonl` → `<taskId>.jsonl` → `default.<kind>.jsonl` → `default.jsonl`, where `kind` is `task`, `continue`, `resume` or `nudge` (the `prepare` session uses taskId `prepare`, kind `task`). Control lines the fake agent interprets instead of echoing: `fake_write {path, content}`, `fake_rm {path}`, `fake_run {command}`, `fake_stderr {text}`, `fake_sleep {ms}`, `fake_exit {code}`. That is enough to exercise retries, nudges, continuations, halts, branch switches, and `prepare` without spending anything.

## Notes

- **Never pushes.** symphony commits to the current branch only, and refuses to commit at all if a session switched branches mid-run.
- `--max-cost` and `maxCostUsdPerRun` can only enforce what a provider reports: Claude (per session) and OpenCode (per session) do; Codex reports tokens instead.
- `doctor` warns when neither `verifyCommand` nor a `package.json` test script exists, because then a task's `done` cannot be independently confirmed.
- `--safe` on Claude denies every shell command outright (nobody can answer the prompt), so expect `blocked` results.
- The Gemini and Antigravity adapters follow their documented CLI shapes but were not exercised against a live binary here; adjust `providers.<name>.bin`/`extraArgs` for your install. Claude Code is launched with its normal configuration, so MCP servers/connectors configured there keep working.
- The whole `.symphony/` directory is gitignored: the installer writes `*` into `.symphony/.gitignore` and adds `.symphony/` to the project's `.gitignore`. To track the harness in a repo instead, delete `.symphony/.gitignore`, drop the root entry, and ignore `runs/`, `state.json`, `symphony.log`, `lock`, and your stop file.
