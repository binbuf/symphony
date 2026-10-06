import { spawnSync } from 'node:child_process';
import { resolveSpawn } from '../spawn.js';
import { isRecord, bool, num, str } from '../util.js';
import { ATTACHED_PROMPT, addUsage, compactUsage, hintFromInput, newHints, promptOverflowsArgv, sumCounts, toText, tryJson } from './common.js';
import type { ClassifyHints, LineParser, NormalizedEvent, Provider } from './types.js';

/**
 * OpenCode 2.x `opencode run --format json`. Events: text | reasoning | tool_use | step_start | step_finish | error,
 * each carrying `sessionID` and a `part`. There is no terminal `result` event; session.ts synthesizes one.
 * The event shapes are unchanged from 1.x.
 */
export class OpenCodeParser implements LineParser {
  private readonly h: ClassifyHints = newHints();
  private initDone = false;
  private readonly seenTool = new Set<string>();

  hints(): ClassifyHints { return this.h; }

  parse(line: string): NormalizedEvent[] {
    const ev = tryJson(line);
    if (!isRecord(ev)) return [{ kind: 'raw', text: line, stream: 'stdout' }];
    const out: NormalizedEvent[] = [];
    const sid = str(ev.sessionID) ?? (isRecord(ev.part) ? str(ev.part.sessionID) : undefined);
    if (!this.initDone && sid) { this.initDone = true; out.push({ kind: 'init', sessionId: sid }); }
    const part = isRecord(ev.part) ? ev.part : {};
    switch (ev.type) {
      case 'text': { const t = str(part.text) ?? ''; if (t.trim()) out.push({ kind: 'text', text: t }); break; }
      case 'reasoning': { const t = str(part.text) ?? ''; if (t.trim()) out.push({ kind: 'thinking', text: t }); break; }
      case 'tool_use': {
        const id = str(part.id) ?? str(part.callID) ?? `${this.seenTool.size}`;
        const state = isRecord(part.state) ? part.state : {};
        const status = str(state.status) ?? 'completed';
        const name = str(part.tool) ?? 'tool';
        if (!this.seenTool.has(`${id}:use`)) {
          this.seenTool.add(`${id}:use`);
          out.push({ kind: 'tool_use', name, hint: hintFromInput(state.input), input: state.input });
        }
        if ((status === 'completed' || status === 'error') && !this.seenTool.has(`${id}:${status}`)) {
          this.seenTool.add(`${id}:${status}`);
          out.push({ kind: 'tool_result', text: toText(state.output ?? state.error ?? ''), isError: status === 'error' });
        }
        break;
      }
      case 'step_finish': {
        const cost = num(part.cost);
        if (cost !== undefined) this.h.costUsd = (this.h.costUsd ?? 0) + cost;
        // `step-finish` part tokens (the same shape in 1.x and 2.x):
        // { total?, input, output, reasoning, cache: { read, write } }.
        // `input` is already net of cache reads/writes (packages/opencode/src/session/session.ts getUsage),
        // `output` excludes reasoning, and this part is emitted once per step, so the session sums them.
        const tokens = isRecord(part.tokens) ? part.tokens : undefined;
        if (tokens) {
          const cache = isRecord(tokens.cache) ? tokens.cache : {};
          this.h.usage = addUsage(this.h.usage, compactUsage({
            inputTokens: num(tokens.input),
            cachedInputTokens: sumCounts(num(cache.read), num(cache.write)),
            outputTokens: num(tokens.output),
            reasoningTokens: num(tokens.reasoning),
            totalTokens: num(tokens.total),
          }));
        }
        break;
      }
      case 'error': {
        const err = isRecord(ev.error) ? ev.error : part;
        const data = isRecord(err.data) ? err.data : {};
        const status = statusOf(data.statusCode) ?? statusOf(data.status) ?? statusOf(err.statusCode);
        const retryable = bool(data.isRetryable) ?? bool(err.isRetryable);
        const retryAfter = retryAfterSecOf(data) ?? retryAfterSecOf(err) ?? retryAfterSecOf(data.responseBody) ?? retryAfterSecOf(err.responseBody);
        if (status !== undefined) this.h.httpStatus = status;
        if (retryable !== undefined) this.h.retryable = retryable;
        if (retryAfter !== undefined && this.h.retryAfterSec === undefined) this.h.retryAfterSec = retryAfter;
        // 1.x nests the message under `error.data.message`; 2.x often puts `error.message` and a
        // typed `error.type` (e.g. `provider.no-route`) at the top level. Read both spellings.
        const message = str(data.message) ?? str(err.message) ?? toText(err);
        const label = str(err.name) ?? str(err.type) ?? 'error';
        // Keep the HTTP status and any Retry-After in the text too, so wording the classifier does not
        // know (new providers phrase throttling many ways) is still recognised from the status alone.
        const detail = [
          message,
          status !== undefined ? `(HTTP ${status})` : '',
          retryAfter !== undefined ? `(retry after ${retryAfter}s)` : '',
        ].filter(Boolean).join(' ');
        const text = `${label}: ${detail}`;
        this.h.errorTexts.push(text);
        out.push({ kind: 'error', text });
        break;
      }
      default:
        break;
    }
    return out;
  }
}

/**
 * Normalise an HTTP status that a provider error carries as a number or a numeric string
 * (`429` / `"429"`). Anything else (absent, non-numeric) is undefined.
 */
function statusOf(x: unknown): number | undefined {
  if (typeof x === 'number') return Number.isFinite(x) ? x : undefined;
  if (typeof x === 'string' && /^\d{3}$/.test(x.trim())) return Number(x.trim());
  return undefined;
}

/**
 * Pull a Retry-After value (seconds) from an error payload. AI-SDK errors expose it under several
 * spellings, sometimes inside a JSON string `responseBody`; only the first usable value is used.
 */
function retryAfterSecOf(x: unknown): number | undefined {
  if (typeof x === 'string') {
    const t = x.trim();
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return retryAfterSecOf(JSON.parse(t)); } catch { return undefined; }
    }
    return undefined;
  }
  if (!isRecord(x)) return undefined;
  const direct = num(x.retryAfter) ?? num(x.retryAfterSeconds) ?? num(x.retry_after) ?? num(x['retry-after']);
  if (direct !== undefined) return direct;
  const nested = isRecord(x.headers) ? x.headers : undefined;
  if (nested) {
    const raw = nested['retry-after'] ?? nested['Retry-After'] ?? nested.retry_after;
    const n = num(raw);
    if (n !== undefined) return n;
    const s = str(raw);
    if (s !== undefined && /^\d+(\.\d+)?$/.test(s.trim())) return Number(s.trim());
  }
  return undefined;
}

/**
 * Parse `opencode api GET /api/model` output into a map of `providerID/modelID` → advertised
 * variants. 2.x returns a single `{ location, data: Model[] }` document (each model carries a
 * `variants` array of `{ id, … }`), unlike 1.x's `opencode models --verbose`, which interleaved
 * plain model-id lines with JSON objects and no longer exists.
 */
export function parseModelVariants(out: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  let root: unknown;
  try { root = JSON.parse(out); } catch { return map; }
  const data = isRecord(root) && Array.isArray(root.data) ? root.data : Array.isArray(root) ? root : [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const providerID = str(entry.providerID);
    const id = str(entry.id);
    if (!providerID || !id) continue;
    const variants = new Set<string>();
    if (Array.isArray(entry.variants)) {
      for (const v of entry.variants) {
        const vid = isRecord(v) ? str(v.id) : undefined;
        if (vid) variants.add(vid);
      }
    }
    map.set(`${providerID}/${id}`, variants);
  }
  return map;
}

/** Per-binary catalog cache: `null` records a failed read so it is not retried for every task. */
const variantCache = new Map<string, Map<string, Set<string>> | null>();

/**
 * The variants the model advertises, from the OpenCode catalog. Returns `undefined` when the
 * catalog could not be read (support is unknown), and an empty set when it was read but the model
 * is absent or exposes no variants.
 */
export function opencodeModelVariants(bin: string, model: string | undefined): Set<string> | undefined {
  if (!model) return undefined;
  if (!variantCache.has(bin)) {
    variantCache.set(bin, readCatalog(bin));
  }
  const catalog = variantCache.get(bin);
  if (!catalog) return undefined;
  return catalog.get(model) ?? new Set<string>();
}

/** Run `opencode api GET /api/model` and parse it, or null when the catalog cannot be read. */
function readCatalog(bin: string): Map<string, Set<string>> | null {
  const launch = resolveSpawn(bin, ['api', 'GET', '/api/model']);
  const r = spawnSync(launch.command, launch.args, {
    encoding: 'utf8',
    timeout: 30_000,
    env: process.env,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
  return r.status === 0 && r.stdout ? parseModelVariants(r.stdout) : null;
}

/**
 * symphony targets OpenCode 2.x. 1.x carries a different CLI surface (`--variant` as a run flag,
 * `opencode models --verbose`, no background service) and is no longer supported. Returns a warning
 * when `--version` output names a major below 2, and `undefined` when it is 2.x or unparseable (so
 * an unknown shape never blocks).
 */
export function opencodeVersionWarning(versionOutput: string): string | undefined {
  const m = /(\d+)\.\d+/.exec(versionOutput.trim());
  if (!m) return undefined;
  if (Number(m[1]) >= 2) return undefined;
  return `opencode ${versionOutput.trim()} detected; symphony requires OpenCode 2.x (1.x is no longer supported — upgrade with "opencode upgrade")`;
}

/** `provider/model#variant` (2.x); a model that already carries a variant is left alone. */
function modelRef(model: string, variant: string | undefined): string {
  if (!variant || model.includes('#')) return model;
  return `${model}#${variant}`;
}

export const opencodeProvider: Provider = {
  name: 'opencode',
  supportsBudget: false,
  supportsResume: true,
  supportsVariant: true,
  supportsMcp: true,
  modelVariants: opencodeModelVariants,
  authCheckArgs: ['auth', 'list'],
  buildCommand(o) {
    // OpenCode 2.x. `--standalone` gives this invocation a private server instead of the shared
    // background service, so the spawned process owns the session: a kill (timeout, Ctrl-C, stop)
    // stops the work rather than leaving it running server-side, and per-invocation env config
    // (OPENCODE_CONFIG_CONTENT, used for MCP scoping) is honoured even when a background service is
    // already running. The working directory is set via the spawn cwd; opencode's directory
    // positional is for the top-level TUI command, not `run`.
    const args = ['run', '--standalone', '--format', 'json', '--thinking'];
    if (o.resumeId) args.push('--session', o.resumeId);
    // 2.x carries the reasoning variant in the model reference (`provider/model#variant`); there is
    // no `--variant` run flag. A variant needs a model reference to ride on, so it is dropped when
    // no model is resolved (the run then uses the configured default with no variant).
    if (o.model) args.push('--model', modelRef(o.model, o.variant));
    if (o.autoApprove) args.push('--auto');
    // A read-only session (the watcher) is the default here: without `--auto`, reads are permitted
    // and edits/shell commands need approval nobody can give, so it can read the named log only.
    // The prompt is normally the trailing positional (never `--file` + a read-the-file bootstrap:
    // that wrapper measurably dulls the model's answer). It leaves argv only when a Windows `.cmd`
    // shim would otherwise overflow cmd.exe; then the runner's audit copy is attached instead.
    if (promptOverflowsArgv(o)) {
      // `--file` is an array flag that would swallow a following positional, so the pointer comes
      // first and `--file` last.
      args.push(...o.extraArgs, ATTACHED_PROMPT, '--file', o.promptFile);
    } else {
      args.push(...o.extraArgs, o.prompt);
    }
    return { bin: o.bin, args };
  },
  createParser: () => new OpenCodeParser(),
};
