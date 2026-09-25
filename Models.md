# Models

Recommended model ids per provider, current as of **September 2026**. Model lines move fast — treat
this as a starting point and confirm against the CLI's own listing, noted per provider below.

Set an id with `--model`, or `providers.<name>.model` in `symphony.config.json`. These are the ids
the harness passes straight through; it does not validate them.

## Reasoning effort

Reasoning effort is set separately from the model id and defaults to `high` for every provider that
has the knob. It is only sent when the model supports it: OpenCode's per-model variants are read
from its own catalog (`opencode models --verbose`), so a model without variants runs at its default.
Override per run with `--variant`, per task with `variant:` front matter, or per provider with
`providers.<name>.variant`. An empty value (`--variant ""`) falls back to the provider default.

| provider | flag | accepted values |
|---|---|---|
| claude | `--effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| opencode | `--variant` | whatever the model advertises (commonly `low`, `medium`, `high`, `max`) |
| codex | `-c model_reasoning_effort=` | `minimal`, `low`, `medium`, `high` (`xhigh` on some models) |
| antigravity | `--effort` | `low`, `medium`, `high` |

Cursor, Gemini and `fake` have no effort knob, so the variant is ignored for them.

## claude — Claude Code (`claude`)

| model | id | notes |
|---|---|---|
| Claude Opus 5.5 | `claude-opus-5-5` | Anthropic's recommended default; 20% cheaper than Opus 5 |
| Claude Opus 5 | `claude-opus-5` | previous Opus |
| Claude Sonnet 5 | `claude-sonnet-5` | fast, lower cost |
| Claude Fable 5.1 | `claude-fable-5-1` | top tier, ~2.5x Opus 5.5 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | cheapest; light or high-volume work |

## cursor — Cursor CLI (`agent`)

Slugs are lowercase-hyphenated and take an effort suffix (`-thinking-high`, `-medium`, `-fast`,
`-low`). Five worth defaulting to:

| model | slug | notes |
|---|---|---|
| Claude Opus 5 | `claude-opus-5` | Anthropic flagship |
| Claude Fable 5.1 | `claude-fable-5-1` | Anthropic top tier |
| GPT-5.6 Sol | `gpt-5.6-sol` | OpenAI's coding flagship |
| Gemini 3.1 Pro | `gemini-3.1-pro` | Google's reasoning flagship |
| Composer 2.5 | `composer-2.5` | Cursor's own fast, low-cost model |

Also seen: `grok-4.5` / `grok-4.6`, `gpt-5.6-terra`, `gpt-5.6-luna`. Cursor's slugs change often —
confirm with `agent --help`, and note the parameterised form is quoted:
`--model 'claude-opus-5 [context=1m,effort=high]'`.

## opencode — OpenCode

OpenCode addresses every model as `provider/model` and routes to any provider, so there is no fixed
list to pin here. Browse the live catalogue at **<https://openrouter.ai/models>**, then set `model` to
the bare id and `modelProvider` to the routing provider — for example
`{ "modelProvider": "openrouter", "model": "deepseek/deepseek-v4.1-flash" }` or
`{ "modelProvider": "openrouter", "model": "z-ai/glm-5.3" }`. Symphony composes the
`provider/model` reference OpenCode expects. Every other CLI takes the bare `model` and ignores
`modelProvider`.

symphony requires **OpenCode 1.x** (`opencode-ai@1`); 2.x is beta and not yet supported. Reasoning
effort uses the 1.x `--variant` run flag (e.g. `high`), gated on the model's `variants` from
`opencode models --verbose`. OpenCode 2.x replaces the flag with a `provider/model#variant` model
reference and regroups the catalog, which this harness does not yet read.

## codex — Codex CLI (`codex`)

| model | id | notes |
|---|---|---|
| GPT-6 Sol | `gpt-6-sol` | recommended for complex coding and agentic work |
| GPT-6 Astra | `gpt-6-astra` | most capable; hardest multi-step work |
| GPT-6 Luna | `gpt-6-luna` | fast and efficient for high-volume work |
| GPT-5.6 Sol / Terra / Luna | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | previous line, still served during the GPT-6 rollout |

GPT-5.5 retires from Codex on 2026-10-14, and `gpt-5.3-codex` is already deprecated.

## gemini — Gemini CLI (`gemini`)

| model | id | notes |
|---|---|---|
| Gemini 3.1 Pro | `gemini-3.1-pro-preview` | strongest reasoning; may require the preview setting |
| Gemini 3 Flash | `gemini-3-flash-preview` | fast |
| Gemini 3 Pro | `gemini-3-pro-preview` | previous Pro |
| Gemini 2.5 Pro / Flash | `gemini-2.5-pro`, `gemini-2.5-flash` | stable fallbacks |

Google is folding Gemini CLI into Antigravity CLI; list what your account serves with the `/model`
command.

## antigravity — Google Antigravity CLI (`agy`)

Slugs come from `agy models`; `--effort low|medium|high` tunes reasoning.

| model | slug | notes |
|---|---|---|
| Gemini 3.8 Flash (High) | `gemini-3.8-flash-high` | newest Flash at high effort |
| Gemini 3.7 Flash (High) | `gemini-3.7-flash-high` | |
| Gemini 3.6 Flash (High) | `gemini-3.6-flash-high` | |
| Gemini 3.1 Pro (High) | `gemini-3.1-pro-high` | Pro reasoning |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | Anthropic, served through Antigravity |

Default when `--model` is omitted: Gemini 3.5 Flash (High). Headless mode fails loudly on an
unknown slug rather than falling back, so a wrong id surfaces immediately.

## fake — fixture replay

Not a real model. The `fake` provider replays NDJSON fixtures for testing the harness itself; it
takes no `model` value.
