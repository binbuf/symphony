# symphony

A thin harness that drives an LLM coding agent through your project's task list: one **fresh** agent session
per task, `git commit` after each, resumable, and safe to leave unattended. It lives at `<project>/.symphony/`
(gitignored) and by default reads its plan from `<project>/docs/` (a legacy `<project>/.docs/` is still
honoured, and every location can be overridden — see **Config**).

Providers: **Claude Code**, **Cursor**, **OpenCode**, **Codex CLI**, **Gemini CLI**, **Google Antigravity**.
All run with permission prompts bypassed so nothing ever waits on a human (`--safe` turns that off for one
run). Connectors/MCP configured inside each agent are respected: symphony only launches the CLI and reads its
NDJSON, so an agent with connectors keeps them.

## Install

```bash
# macOS / Linux
git clone <this repo> symphony && cd symphony
./install.sh /path/to/your/project          # npm install + build, copies dist/ to <project>/.symphony/, gitignores it
cd /path/to/your/project
./.symphony/symphony init                    # scaffolds docs/ and .symphony/symphony.config.json (never overwrites)
./.symphony/symphony doctor                  # provider binary, auth, git, roadmap
./.symphony/symphony run
```

```powershell
# Windows (PowerShell)
git clone <this repo> symphony; cd symphony
./install.ps1 -Target C:\path\to\your\project
cd C:\path\to\your\project
./.symphony/symphony.ps1 init
./.symphony/symphony.ps1 doctor
./.symphony/symphony.ps1 run
```

Requires Node ≥ 20.11 and git. The installed copy has no runtime dependencies. Re-run the installer to
upgrade; it leaves your `symphony.config.json` alone. On Windows `symphony.cmd` is also installed so the
launcher works from `cmd.exe`.

## Commands

| command | what it does |
|---|---|
| `run` | run every unfinished task in roadmap order, committing after each; resumes where it left off |
| `run --prepare` | run `prepare` first, then start only if `docs/` lints clean |
| `status [--json]` | progress table: id, phase, title, status, attempts, time, cost, provider, summary |
| `doctor` | preflight: node, git repo, roadmap, provider binary + auth, halt / STOP / lock |
| `init` | create the docs skeleton, `tasks/TEMPLATE.md`, `design/adr/0000-template.md`, config, `.gitignore` entry |
| `lint` | check the project root and docs against the expected layout; no LLM; exit 2 on errors |
| `prepare [--dry-run]` | lint, then let the configured agent convert/repair the docs in place, re-lint, commit |
| `brief` | print a paste-ready prompt so any LLM turns an idea into the docs package in this exact format |
| `accept T05 [--note "…"]` | human sign-off on a blocked/failed task; counts as done, bullet becomes `[x] ⟵ accepted` |
| `nudge T05 [--note "…"]` | resume a task's last session and ask it to close out with a result block |
| `clear-halt` | lift a halt so `run` can start again |

Every command accepts `--root DIR` (default: the project containing `.symphony/`). `run` flags: `--provider`,
`--model`, `--from T03`, `--to T10`, `--only T05,T06`, `--retry`, `--continue-on-failure`, `--dry-run`, `--safe`,
`--no-nudge`, `--timeout-min N`, `--budget USD` (Claude only), `--clear-halt`, `--prepare`.

## The docs contract

```
docs/
  ROADMAP.md            phases as "##" headings; one top-level bullet per task, in execution order
  PROGRESS.md           the agent's shared notebook (learnings for later tasks); created if missing
  tasks/NN-slug.md      one detail file per task: Goal / Context / Scope / Out of scope / Design notes / Done when / Hand-off
  tasks/TEMPLATE.md     the template `init` writes
  design/*.md           architecture docs the agent reads before coding and updates when behaviour changes
  design/adr/NNNN-*.md  architecture decision records the agent adds when a decision constrains later tasks
```

Roadmap bullet syntax. The harness owns the checkbox and the trailing tag; edit everything else freely:

```markdown
## Phase 1 — Foundation
- [ ] T01 — Scaffold the project → [tasks/01-scaffold.md](tasks/01-scaffold.md)   not started
- [~] T02 — Add CI ⟵ failed                 unfinished: interrupted, blocked on a human, or needs a rerun
- [x] T03 — Database schema                 done
- [x] T04 — Auth spike ⟵ accepted           signed off by a human with `accept`
```

Ids are `T01`, `T02`, … (`01 —` and `3.` also parse). Task files are matched by the link, else by the `NN`
filename prefix. A bullet with no task file still runs; the agent is told to create the file first. A task file
may start with front matter to override the provider for that task only:

```markdown
---
provider: gemini
model: gemini-2.5-pro
timeoutMin: 90
---
```

**Starting from an idea?** `symphony brief` prints a prompt. Give any LLM your idea plus that text; it emits
the docs package in this format, and you drop the files into the project next to `.symphony/`.

**Already have planning docs in another shape?** `symphony lint` scans the project root and docs and reports
what differs: `ROADMAP.md`/`PLAN.md`/`TASKS.md` at the root or under `docs/`, `tasks/`, `specs/`; task lines that
won't parse (numbered lists, headings, nested bullets, bold ids); wrong-case filenames; ADRs outside `design/adr/`;
task files missing sections; broken links. `symphony prepare` hands that report, the outside documents and the
format contract to the configured agent for one session, which converts everything in place (`git mv` for moves,
meaning preserved, no invented scope), then the harness re-lints and commits. `prepare --dry-run` prints the exact
prompt and touches nothing.

## What a run does

For each task the harness marks the bullet `[~] ⟵ running`, builds a prompt (the task file, the tail of
`PROGRESS.md`, the list of design docs and ADRs, and the rules below), spawns the agent in the project root, and
streams what it does:

```
[think] I should read the existing schema before adding the table
[text]  Adding the migration.
[tool]  Bash: npm test
[tool-result] 42 passing
[result] ok ($0.42 · 12 turns · 310s)
```

The agent must end with a result block the harness parses:

```
SYMPHONY_RESULT
status: done | continue | blocked | failed
summary: <one line>
END_SYMPHONY_RESULT
```

- `done` — acceptance criteria met and the named tests pass.
- `continue` — a real slice landed but the task needs more; the harness commits the slice
  (`commitPerSession`) and starts a **fresh** session for the next slice, up to `maxContinuations`.
  This is how a large task is broken into manageable pieces across sessions without losing progress.
- `blocked` — a human decision or external dependency is genuinely required.
- `failed` — anything else.

The harness then sets the bullet to `[x]`, `[~] ⟵ blocked|failed`, or leaves `[~] ⟵ running` between
continuations, runs `git add -A && git commit -m "T01: <title> [<status>]"`, saves state, and starts the next
task in a **new** session. If the block is missing after an otherwise clean session, that session is resumed
once with a close-out prompt (`--no-nudge` disables).

Provider and model precedence: CLI flag > `SYMPHONY_PROVIDER` / `SYMPHONY_MODEL` > task front matter > config > defaults.

### Progress, hand-off and design continuity

Every session is instructed to, before it ends:

1. append a `## Txx — title` section to `PROGRESS.md` (real paths, working commands, deviations, what remains);
2. fill the task file's `## Hand-off` with what landed, what deviated and why, and what the next task must know;
3. add or update a unit/integration test named under "Done when", run it in the foreground, and paste the result;
4. update any `design/*.md` whose behaviour it changed and write an ADR in `design/adr/` for any decision that
   now constrains later work. Substantial drift from the original design is recorded as a new ADR rather than
   silently rewriting history.

A `continue` session leaves all four in place, so the next fresh session can pick up exactly where it stopped.

## When things stop

| situation | what happens | what you do |
|---|---|---|
| task **blocked** (needs a human) | run stops, exit 2, bullet `[~] ⟵ blocked` | read the task's Hand-off; `accept T05 --note "…"` or `run --retry --only T05` |
| task **failed** | run stops, exit 2, `[~] ⟵ failed` | fix, then `run` (failed tasks are retried) |
| task reports **continue** past `maxContinuations` | treated as failed | split the task file, or raise `maxContinuations` |
| transient error: rate limit, overloaded, 5xx, network drop, stalled output, crash | retried in place with backoff (30 s, 2 min, 5 min), **resuming the same session** so work is kept | nothing |
| **fatal** error: auth, no credits or usage limit, unknown model, bad config, missing binary | **halt**: banner, exit 3, sticky in `state.json`; `run` refuses to start | fix the cause, then `clear-halt` |
| 2 failures in a row (`--continue-on-failure`) or one task failing 3 times | halt | same |
| `touch .stop` (configurable) | pause at the next task boundary, exit 0; nothing is killed | `rm .stop` |
| `touch .symphony/STOP` | legacy alias for the above | `rm .symphony/STOP` |
| Ctrl-C | current session killed, task recorded `[~]`, exit 130; twice = force quit | `run` picks it up |
| another run already active | exit 4 (lock file with the live pid) | wait, or remove `.symphony/lock` if stale |

The pipeline stops for a human only when a task itself reports `blocked`, or a fatal provider/config problem
halts the run. Everything else — transient errors, large tasks, missing result blocks — is handled by retry,
continuation and nudge. Set `onBlocked: "continue"` (or pass `--continue-on-failure`) if you want the run to
move past blocked tasks and leave them for later sign-off.

`status` shows `running?` for a task whose recorded process is gone (harness crashed); the next `run` retries it.

## Providers

| provider | binary | how it is launched | bypass flag (default) | `--safe` |
|---|---|---|---|---|
| `claude` | `claude` | `-p --output-format stream-json --verbose`, prompt on stdin | `--dangerously-skip-permissions` | `--permission-mode acceptEdits --permission-prompts none` |
| `cursor` | `agent` | `-p --output-format stream-json --workspace <root> --trust <prompt>` | `--force` | no `--force` |
| `opencode` | `opencode` | `run --format json --thinking --dir <root> <prompt>` | `--auto` | no `--auto` |
| `codex` | `codex` | `exec --json --color never --skip-git-repo-check --cd <root> <prompt>` | `--dangerously-bypass-approvals-and-sandbox` | `--sandbox workspace-write --ask-for-approval never` |
| `gemini` | `gemini` | `--output-format json --prompt <prompt>` | `--yolo` | no `--yolo` |
| `antigravity` | `antigravity` | `-p --output-format json --workspace <root> <prompt>` | `--dangerously-skip-permissions` | no bypass flag |
| `fake` | node | replays an NDJSON fixture; for tests | | |

Models: pass `--model`, or set `providers.<name>.model` (OpenCode wants `provider/model`, e.g.
`anthropic/claude-sonnet-4-5`). Session resume for retries and nudges uses `--resume` (Claude, Cursor),
`--session` (OpenCode) and `exec resume <id>` (Codex); Gemini and Antigravity do not advertise resume, so
retries start fresh. Cost is reported by Claude only. Each provider's argv can be corrected for your install
with `providers.<name>.bin` and `providers.<name>.extraArgs`; unknown stream shapes are parsed best-effort.

## Config (`.symphony/symphony.config.json`, every key optional)

| key | default | meaning |
|---|---|---|
| `provider` | `claude` | `claude` · `cursor` · `opencode` · `codex` · `gemini` · `antigravity` |
| `providers.<name>.bin` `.model` `.extraArgs` `.budgetUsd` `.idleTimeoutMin` | see `symphony.config.example.json` | binary, model, extra CLI args, per-task budget (Claude), stall timeout override |
| `paths.docs` | `docs` (legacy `.docs` honoured) | planning package directory |
| `paths.roadmap` `.progress` `.tasks` `.design` `.adr` | derived from `paths.docs` | individual overrides, absolute or root-relative |
| `paths.stop` | `.stop` | graceful-pause sentinel (absolute or root-relative) |
| `paths.state` `.runs` `.log` | under `.symphony/` | where harness state, session logs and the event log live |
| `autoApprove` | `true` | bypass permission prompts (`--safe` sets false for one run) |
| `nudge`, `nudgeTimeoutMin` | `true`, `45` | resume once to collect a missing result block |
| `timeoutMin`, `idleTimeoutMin` | `240`, `20` | wall clock per session; kill after this long with no output |
| `prepareTimeoutMin` | `60` | wall clock for the `prepare` session |
| `maxProgressBytes` | `32768` | tail of PROGRESS.md inlined into each prompt |
| `designDocs` | `true` | when `false`, `design/` and `adr/` are neither required nor used: tasks run standalone |
| `maxContinuations` | `4` | extra fresh sessions a task may take after reporting `continue` |
| `commitPerSession` | `true` | commit each `continue` slice, not just the final result |
| `onBlocked` | `stop` | `stop` at a blocked task for a human, or `continue` to the next task |
| `retry.maxAttempts`, `retry.backoffSec` | `3`, `[30,120,300]` | transient-error retries |
| `halt.maxConsecutiveFailures`, `halt.maxAttemptsPerTask`, `halt.onCategories` | `2`, `3`, `[auth, billing, usage_limit, model, config]` | when to halt instead of continuing |
| `commitMessageTemplate` | `{id}: {title} [{status}]` | |

**Greenfield vs. existing project.** The contract is stack-agnostic: for a greenfield project the early tasks
scaffold the repo, tooling and a passing test command before feature work; for an existing codebase the tasks
describe incremental feature/fix work and are told never to re-scaffold. Point `paths.docs` at an existing
`docs/` or `specs/` tree, or run `prepare` to convert whatever planning shape you already have.

**Tasks only, no design folder.** Set `"designDocs": false` to run a plain series of tasks: the harness does not
create, require, lint or prompt for `design/` or `adr/`, and no ADR/design-update work is asked of sessions.
`docs/` still holds `ROADMAP.md`, `PROGRESS.md` and `tasks/`. Toggle it and re-run `init` or `prepare` to apply.

## Logs and state

```
.symphony/runs/T05-20260917T231530.jsonl       raw provider NDJSON, byte-faithful
.symphony/runs/T05-20260917T231530.log         rendered [think]/[text]/[tool] stream, longer lines than stdout
.symphony/runs/T05-20260917T231530.prompt.md   the exact prompt sent
.symphony/runs/prepare-<stamp>.*               the prepare session, same three files
.symphony/symphony.log                         harness events: task start/finish, retries, halts, commits
.symphony/state.json                           per-task state and the halt flag; delete it and progress is rebuilt from the roadmap markers
```

Retries append `-r2`, nudges `-nudge`, continuation sessions `-rN` too. `paths.state`/`.runs`/`.log` move these.

## Platform support

macOS, Linux and Windows are first-class. On Windows the agent process tree is killed with `taskkill /T /F`,
and `symphony.ps1` / `symphony.cmd` are provided alongside the POSIX launcher. `install.sh` and `install.ps1`
are equivalent. Session process groups are used on POSIX; on Windows `detached` is disabled because there are
no process groups. `npm run clean` and the test script avoid POSIX-only commands.

## Developing the harness

```bash
npm install
npm run dev -- run --root /path/to/project       # run from source via tsx
npm test                                          # node --test, 49 tests
npm run typecheck && npm run build                # tsc → dist/
node dist/tools/parse-check.js claude session.jsonl [--render]   # replay a provider log through the parser
```

The `fake` provider replays Claude-format NDJSON fixtures from `SYMPHONY_FAKE_FIXTURES` (`<taskId>.jsonl`,
`<taskId>.task.jsonl`, `<taskId>.continue.jsonl`, `<taskId>.resume.jsonl`, `<taskId>.nudge.jsonl`,
`prepare.jsonl`, `default.jsonl`). Control lines the fake agent interprets instead of echoing:
`fake_write {path, content}`, `fake_rm {path}`, `fake_stderr {text}`, `fake_sleep {ms}`, `fake_exit {code}`.
That is enough to exercise retries, nudges, continuations, halts, and `prepare` without spending anything.

## Notes

- Exit codes: 0 ok or paused · 1 unexpected error · 2 stopped on a blocked/failed task · 3 halted · 4 usage, preflight or lock · 130/143 interrupted.
- `--safe` on Claude denies every shell command outright (nobody can answer the prompt), so expect `blocked`.
- The Gemini and Antigravity adapters follow their documented CLI shapes but were not exercised against a live
  binary here; adjust `providers.<name>.bin`/`extraArgs` for your install. Claude Code is launched with its
  normal configuration, so MCP servers/connectors configured there keep working.
- Never pushes.
- The whole `.symphony/` directory is gitignored: the installer writes a `*` into `.symphony/.gitignore` and adds
  `.symphony/` to the project's `.gitignore`. To track the harness in a repo instead, delete `.symphony/.gitignore`,
  drop the root entry, and ignore `runs/`, `state.json`, `symphony.log`, `lock`, and your stop file.