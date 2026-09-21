# symphony

**A thin harness that drives an LLM coding agent through your project's roadmap — one fresh session per task, a git commit after each, resumable, and safe to leave unattended.**

symphony lives in `<your target project>/.symphony/` (gitignored) and reads its plan from `<project>/docs/` and launches using your provider's LLM CLI tool.

Providers: **Claude Code · Cursor · OpenCode · Codex CLI · Gemini CLI · Google Antigravity** — all launched with permission prompts bypassed so nothing ever waits on a human (`--safe` turns that off for one run). Connectors/MCP configured inside each agent keep working: symphony only launches the CLI and reads its output.

**Contents** — [Why symphony](#why-symphony) · [Quick start](#quick-start) · [The lifecycle](#the-lifecycle) · [Run scenarios](#run-scenarios) · [The docs contract](#the-docs-contract) · [CLI reference](#cli-reference) · [Providers](#providers) · [Config](#config) · [Hooks](#hooks) · [Logs and state](#logs-and-state) · [Platform support](#platform-support) · [Exit codes](#exit-codes) · [Developing the harness](#developing-the-harness)

## Why symphony

- **Unattended by default.** No session ever waits on a human. The harness handles the things that normally make you babysit an agent: transient API failures, oversized tasks, missing result blocks, runaway loops, and dirty worktrees.
- **Fresh context per task.** Every task starts in a brand-new session with only its task file, the tail of `PROGRESS.md`, and the design docs it needs. No context rot, no hidden state carried from the previous task.
- **Everything lands in git.** Each task ends in a commit that carries the code, the roadmap marker, the task's hand-off, the design updates and the run log. `git log` is the pipeline's history; `git revert` is the undo.
- **Resumable and inspectable.** Kill it, crash it, or pause it with a file — state and roadmap markers let the next run pick up exactly where it left off. Every session's exact prompt, rendered log and raw NDJSON are saved.
- **Provider-agnostic.** The same plan and lifecycle work with any of the six agent CLIs, or the built-in `fake` provider for testing the harness itself without spending anything.
- **Guardrails you control.** An independent `verifyCommand` after every `done`, retry/halt policies, per-task budgets and iteration caps, and lifecycle hooks for notifications or CI.

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
./.symphony/symphony doctor    # preflight: node, git, roadmap, provider binary + auth, halt/STOP/lock
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

Run it before the first `run` and after changing providers or config. It checks, in order: Node version, that the project is a git repository (and whether the worktree is dirty), that `ROADMAP.md` exists and parses, that the provider binary is on `PATH`, that it is authenticated, and whether a halt, STOP sentinel or another live run (lock) would block you. Failures exit `4`; warnings do not stop a run. `run` repeats these checks itself before every invocation.

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
2. **Builds the prompt** and writes it to `.symphony/runs/<task>-<stamp>.prompt.md`. It contains the task file, the tail of `PROGRESS.md`, the list of design docs and ADRs, the rules for the session, and the required result block.
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

5. **Verifies independently (optional).** If `verifyCommand` (or a per-task `verify:` in the task file's front matter, which wins) is set, the harness runs that shell command itself after a `done`. A non-zero exit demotes the task to `failed` and records the command, exit code and output tail in the logs. Provider-agnostic: any command, any stack.
6. **Writes the record.** `docs/logs/TNN.md` (status, provider/model, timing, cost, commit, each session's reported status and summary), then regenerates the pipeline status block at the bottom of `ROADMAP.md`.
7. **Commits everything** with `git add -A && git commit -m "T01: <title> [<status>]"` (template configurable). Before staging, an ephemeral-file guard keeps secrets and build junk out of the commit by adding them to `.gitignore` — agent-created source files still land.
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
| `touch .stop` (path configurable) | pauses at the next task boundary, exit `0`; nothing is killed. `touch .symphony/STOP` is the legacy alias |
| Ctrl-C | kills the current session, records the task unfinished, exits `130`; press twice to force quit |
| another run already active | refuses to start, exit `4` (lock file holds the live pid and a heartbeat) |

### After the run: review and steer

| command | what it does |
|---|---|
| `status [--json]` | progress table: id, phase, title, status, attempts, time, cost, provider, summary |
| `accept T05 [--note "…"]` | human sign-off on a blocked/failed task; counts as done, bullet becomes `[x] ⟵ accepted` |
| `nudge T05 [--note "…"]` | resume the task's last session and ask it to close out with a result block |
| `reset T05 [--revert]` | clear a task's state so it runs again; `--revert` also `git revert`s its `T05:` commits (newest first) |
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
| 11 | `.stop` sentinel present | pauses before the next task; nothing is killed | – | 0 | `rm .stop`, `run` |
| 12 | Ctrl-C | kills the current session; task recorded unfinished (failed) | `[~] ⟵ failed` | 130 | `run` retries it |
| 13 | second run while one is active | refuses to start | lock file with live pid | 4 | wait, or delete `.symphony/lock` if stale |
| 14 | `maxIterationsPerTask` / `maxTasksPerRun` / budget hit | task fails gracefully, or the run processes only the first N tasks | task `failed` / rest `pending` | – | raise the limit, or split the task |
| 15 | you tick `[x]` by hand | next load reconciles state to the roadmap tick | `[x]` | – | nothing |
| 16 | `reset T05 --revert` | clears state and reverts the task's commits newest-first; on conflict it stops and tells you to resolve | `[ ]` pending | 0 | fix conflicts if any, then `run` |

The pipeline stops for a human only when a task itself reports `blocked`, or a fatal provider/config problem halts the run. Everything else — transient errors, large tasks, missing result blocks — is handled by retry, continuation and nudge.

## The docs contract

symphony owns a small, stack-agnostic planning format. `init` scaffolds it, `lint` checks it, `prepare` repairs it, `brief` generates it, and every session is told to maintain it.

```
docs/
  ROADMAP.md            phases as "##" headings; one top-level bullet per task, in execution order
  PROGRESS.md           the agent's shared notebook (learnings for later tasks); created if missing
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

Every command accepts `--root DIR` (default: the project containing `.symphony/`). Exit codes are listed [below](#exit-codes).

| command | what it does |
|---|---|
| `run` | run every unfinished task in roadmap order, committing after each; resumes where it left off |
| `run --prepare` | run `prepare` first, then start only if `docs/` lints clean |
| `status [--json]` | progress table (or machine-readable JSON) |
| `doctor` | preflight: node, git repo, roadmap, provider binary + auth, halt / STOP / lock |
| `init` | create the docs skeleton, `tasks/TEMPLATE.md`, `design/adr/0000-template.md`, config, `.gitignore` entry |
| `lint` | check the project root and docs against the expected layout; no LLM; exit 2 on errors |
| `prepare [--dry-run]` | lint, then let the configured agent convert/repair the docs in place, re-lint, commit |
| `brief` | print a paste-ready prompt so any LLM turns an idea into the docs package in this exact format |
| `accept T05[,T06…] [--note "…"]` | human sign-off on one or more blocked/failed tasks; counts as done, bullet becomes `[x] ⟵ accepted` |
| `reset T05 [--revert]` | clear a task's state so it runs again; `--revert` also undoes its `T05:` commits (newest first) |
| `nudge T05 [--note "…"]` | resume a task's last session and ask it to close out with a result block |
| `clear-halt` | lift a halt so `run` can start again |

### `run` flags

| flag | meaning |
|---|---|
| `--prepare` | run `prepare` first; abort the run if the docs still do not lint clean |
| `--provider P`, `--model M` | override provider/model for this run (see precedence above) |
| `--from T03`, `--to T10`, `--only T05,T06` | restrict which tasks are selected |
| `--retry` | re-run selected tasks even if they are done, accepted or blocked |
| `--continue-on-failure` | keep going past failed/blocked tasks instead of stopping |
| `--dry-run` | print the prompt and exact provider command for each selected task; run nothing |
| `--safe` | do not bypass permission prompts (see the note under Providers) |
| `--no-nudge` | disable the automatic resume when a session omits its result block |
| `--timeout-min N` | wall-clock cap per session (default 240) |
| `--max-tasks N` | process at most N tasks this run |
| `--max-iterations N` | at most N sessions per task, retries and continuations included |
| `--budget USD` | per-task budget (Claude only) |
| `--clear-halt` | clear a sticky halt and start |

## Providers

| provider | binary | how it is launched | bypass flag (default) | `--safe` |
|---|---|---|---|---|
| `claude` | `claude` | `-p --output-format stream-json --verbose`, prompt on stdin | `--dangerously-skip-permissions` | `--permission-mode acceptEdits --permission-prompts none` |
| `cursor` | `agent` | `-p --output-format stream-json --workspace <root> --trust` + prompt-file bootstrap | `--force` | no `--force` |
| `opencode` | `opencode` | `run --standalone --format json --thinking --file <prompt>` + bootstrap | `--auto` | no `--auto` |
| `codex` | `codex` | `exec --json --color never --skip-git-repo-check --cd <root> -`, prompt on stdin | `--dangerously-bypass-approvals-and-sandbox` | `--sandbox workspace-write --ask-for-approval never` |
| `gemini` | `gemini` | `--output-format json --prompt <bootstrap>` (prompt-file) | `--yolo` | no `--yolo` |
| `antigravity` | `antigravity` | `-p --output-format json --workspace <root>` + prompt-file bootstrap | `--dangerously-skip-permissions` | no bypass flag |
| `fake` | node | replays an NDJSON fixture; for tests | | |

- **Models:** pass `--model`, or set `providers.<name>.model` (OpenCode wants `provider/model`, e.g. `anthropic/claude-sonnet-4-5`).
- **Session resume** for retries and nudges uses `--resume` (Claude, Cursor), `--session` (OpenCode) and `exec resume <id>` (Codex); Gemini and Antigravity do not advertise resume, so retries start fresh.
- **Cost** is surfaced for Claude (per session) and OpenCode (cumulative); `--budget` is Claude-only. Codex reports token usage instead.
- **Correcting an adapter:** each provider's argv can be adjusted for your install with `providers.<name>.bin` and `providers.<name>.extraArgs`; unknown stream shapes are parsed best-effort.
- **Prompt size:** prompts are always written to a file first; providers get them over stdin, as an attached file, or via a short bootstrap that names the file, so OS command-line limits are never a problem.

## Config

Every key is optional and lives in `.symphony/symphony.config.json`. CLI flags and environment variables override it per run.

| key | default | meaning |
|---|---|---|
| `provider` | `claude` | `claude` · `cursor` · `opencode` · `codex` · `gemini` · `antigravity` |
| `providers.<name>.bin` `.model` `.extraArgs` `.budgetUsd` `.idleTimeoutMin` | see `symphony.config.example.json` | binary, model, extra CLI args, per-task budget (Claude), stall timeout override |
| `paths.docs` | `docs` (legacy `.docs` honoured) | planning package directory |
| `paths.roadmap` `.progress` `.tasks` `.design` `.adr` `.logs` | derived from `paths.docs` | individual overrides, absolute or root-relative |
| `paths.stop` | `.stop` | graceful-pause sentinel (absolute or root-relative) |
| `paths.state` `.runs` `.log` | under `.symphony/` | where harness state, session logs and the event log live |
| `autoApprove` | `true` | bypass permission prompts (`--safe` sets false for one run) |
| `nudge`, `nudgeTimeoutMin` | `true`, `45` | resume once to collect a missing result block |
| `timeoutMin`, `idleTimeoutMin` | `240`, `20` | max wall clock per session; kill after this long with no output |
| `prepareTimeoutMin` | `60` | wall clock for the `prepare` session |
| `maxProgressBytes` | `32768` | tail of `PROGRESS.md` inlined into each prompt |
| `designDocs` | `true` | when `false`, `design/` and `adr/` are neither required nor used: tasks run standalone |
| `maxContinuations` | `4` | extra fresh sessions a task may take after reporting `continue` |
| `maxIterationsPerTask`, `maxTasksPerRun` | `0`, `0` | provider-agnostic caps (0 = unlimited): sessions per task in a run, and tasks per run |
| `commitPerSession` | `true` | commit each `continue` slice, not just the final result |
| `onBlocked` | `stop` | `stop` at a blocked task for a human, or `continue` to the next task |
| `verifyCommand`, `verifyTimeoutMin` | –, `30` | shell command the harness runs itself after `done`; non-zero demotes to failed (per-task `verify:` wins) |
| `hooks.afterTask` `.onBlocked` `.onHalt` `.onRunEnd` | – | shell commands run on lifecycle events (see [Hooks](#hooks)) |
| `git.autoIgnoreUntracked`, `git.extraIgnore` | `true`, `[]` | before committing, keep untracked ephemeral/secret files out of the commit by adding their patterns to `.gitignore` |
| `retry.maxAttempts`, `retry.backoffSec` | `3`, `[30,120,300]` | transient-error retries |
| `halt.maxConsecutiveFailures`, `halt.maxAttemptsPerTask`, `halt.onCategories` | `2`, `3`, `[auth, billing, usage_limit, model, config]` | when to halt instead of continuing |
| `commitMessageTemplate` | `{id}: {title} [{status}]` | |

## Hooks

Four optional shell hooks let the harness notify or trigger anything without built-in integrations. Each runs in the project root with the event in its environment; a hook that fails only warns and never breaks the run.

| hook | when | environment |
|---|---|---|
| `hooks.afterTask` | after every task finishes | `SYMPHONY_TASK`, `SYMPHONY_TITLE`, `SYMPHONY_STATUS`, `SYMPHONY_SUMMARY`, `SYMPHONY_COMMIT`, `SYMPHONY_PROVIDER`, `SYMPHONY_MODEL` |
| `hooks.onBlocked` | a task reports `blocked` | `SYMPHONY_TASK`, `SYMPHONY_TITLE`, `SYMPHONY_SUMMARY` |
| `hooks.onHalt` | the run halts on a fatal error | `SYMPHONY_TASK`, `SYMPHONY_HALT_CATEGORY`, `SYMPHONY_HALT_REASON` |
| `hooks.onRunEnd` | `run` finishes | `SYMPHONY_EXIT`, `SYMPHONY_STATUS` (`ok` · `stopped` · `halted` · `error`) |

All hooks also get `SYMPHONY_ROOT`. Example:

```json
{ "hooks": { "afterTask": "curl -fsS -d \"$SYMPHONY_TASK $SYMPHONY_STATUS\" $WEBHOOK || true" } }
```

## Logs and state

```
docs/logs/T05.md                               per-task run log: status, provider/model, timing, cost and each session's summary
.symphony/runs/T05-20260917T231530.jsonl       raw provider NDJSON, byte-faithful
.symphony/runs/T05-20260917T231530.log         rendered [think]/[text]/[tool] stream, longer lines than stdout
.symphony/runs/T05-20260917T231530.prompt.md   the exact prompt sent
.symphony/runs/prepare-<stamp>.*               the prepare session, same three files
.symphony/symphony.log                         harness events: task start/finish, retries, halts, commits
.symphony/state.json                           per-task state and the halt flag; delete it and progress is rebuilt from the roadmap markers
```

Every task gets a `docs/logs/TNN.md` (path overridable with `paths.logs`). It is rewritten in full after each session and committed with the task, so `git log` plus the logs give a per-task and pipeline-wide history. It also records the verify command's result when one is configured. Retries append `-r2`, nudges `-nudge`, continuation sessions `-rN` too. `paths.state`/`.runs`/`.log` move these.

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

The `fake` provider replays Claude-format NDJSON fixtures from `SYMPHONY_FAKE_FIXTURES` (default `.symphony/fixtures`), matched in order `<taskId>.<kind>.jsonl` → `<taskId>.jsonl` → `default.<kind>.jsonl` → `default.jsonl`, where `kind` is `task`, `continue`, `resume` or `nudge` (the `prepare` session uses taskId `prepare`, kind `task`). Control lines the fake agent interprets instead of echoing: `fake_write {path, content}`, `fake_rm {path}`, `fake_stderr {text}`, `fake_sleep {ms}`, `fake_exit {code}`. That is enough to exercise retries, nudges, continuations, halts, and `prepare` without spending anything.

## Notes

- **Never pushes.** symphony commits to the current branch only.
- `--safe` on Claude denies every shell command outright (nobody can answer the prompt), so expect `blocked` results.
- The Gemini and Antigravity adapters follow their documented CLI shapes but were not exercised against a live binary here; adjust `providers.<name>.bin`/`extraArgs` for your install. Claude Code is launched with its normal configuration, so MCP servers/connectors configured there keep working.
- The whole `.symphony/` directory is gitignored: the installer writes `*` into `.symphony/.gitignore` and adds `.symphony/` to the project's `.gitignore`. To track the harness in a repo instead, delete `.symphony/.gitignore`, drop the root entry, and ignore `runs/`, `state.json`, `symphony.log`, `lock`, and your stop file.
