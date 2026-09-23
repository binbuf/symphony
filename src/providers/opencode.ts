import { spawnSync } from 'node:child_process';
import { resolveSpawn } from '../spawn.js';
import { isRecord, num, str } from '../util.js';
import { ATTACHED_BOOTSTRAP, hintFromInput, newHints, toText, tryJson } from './common.js';
import type { ClassifyHints, LineParser, NormalizedEvent, Provider } from './types.js';

/**
 * OpenCode `opencode run --format json`. Events: text | reasoning | tool_use | step_start | step_finish | error,
 * each carrying `sessionID` and a `part`. There is no terminal `result` event; session.ts synthesizes one.
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
        break;
      }
      case 'error': {
        const err = isRecord(ev.error) ? ev.error : part;
        const data = isRecord(err.data) ? err.data : {};
        const text = `${str(err.name) ?? 'error'}: ${str(data.message) ?? toText(err)}`;
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
 * Extract the top-level JSON objects from a stream, ignoring the plain model-id header lines that
 * `opencode models --verbose` prints before each object. Brace counting is string-aware so a `}` in
 * a description does not end the object early.
 */
function extractJsonObjects(s: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed: unknown = JSON.parse(s.slice(start, i + 1));
          if (isRecord(parsed)) out.push(parsed);
        } catch { /* not an object we can use */ }
        start = -1;
      }
    }
  }
  return out;
}

/** Parse `opencode models --verbose` output into a map of `providerID/modelID` → advertised variants. */
export function parseModelVariants(out: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const o of extractJsonObjects(out)) {
    const providerID = str(o.providerID);
    const id = str(o.id);
    if (!providerID || !id) continue;
    map.set(`${providerID}/${id}`, new Set(isRecord(o.variants) ? Object.keys(o.variants) : []));
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

/** Run `opencode models --verbose` and parse it, or null when the catalog cannot be read. */
function readCatalog(bin: string): Map<string, Set<string>> | null {
  const launch = resolveSpawn(bin, ['models', '--verbose']);
  const r = spawnSync(launch.command, launch.args, {
    encoding: 'utf8',
    timeout: 20_000,
    env: process.env,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
  return r.status === 0 && r.stdout ? parseModelVariants(r.stdout) : null;
}

/**
 * OpenCode 2.x is in beta and symphony targets the OpenCode 1.x CLI: 2.x moves the variant into the
 * model reference (`provider/model#variant`), regroups the model catalog, and adds server flags
 * (`--standalone`) this adapter does not pass. Returns a warning when `--version` output names a
 * non-1.x major, and `undefined` when it is 1.x or unparseable (so an unknown shape never blocks).
 */
export function opencodeVersionWarning(versionOutput: string): string | undefined {
  const m = /(\d+)\.\d+/.exec(versionOutput.trim());
  if (!m) return undefined;
  if (Number(m[1]) === 1) return undefined;
  return `opencode ${versionOutput.trim()} detected; symphony requires OpenCode 1.x (2.x is beta and not yet supported)`;
}

export const opencodeProvider: Provider = {
  name: 'opencode',
  supportsBudget: false,
  supportsResume: true,
  supportsVariant: true,
  modelVariants: opencodeModelVariants,
  authCheckArgs: ['auth', 'list'],
  buildCommand(o) {
    // OpenCode 1.x only: `--standalone` is a 2.x server flag and is not passed. The working
    // directory is set via the spawn cwd; opencode has no `--dir` flag (the directory is
    // positional for the top-level command). Pass only flags this CLI understands.
    const args = ['run', '--format', 'json', '--thinking'];
    if (o.resumeId) args.push('--session', o.resumeId);
    if (o.model) args.push('--model', o.model);
    // A model variant is the provider-specific reasoning effort (e.g. "high"); `--variant` is the
    // OpenCode 1.x run flag. (2.x moves it into the model reference as `provider/model#variant`.)
    if (o.variant) args.push('--variant', o.variant);
    if (o.autoApprove) args.push('--auto');
    // The full prompt is attached with `--file`; argv only carries a short bootstrap so an oversized
    // prompt can never overflow the OS command-line limit. In the OpenCode 1.x CLI `--file` is an
    // array flag that would swallow a following positional as another file, so the bootstrap message
    // must come first and `--file` must be last.
    args.push(...o.extraArgs, ATTACHED_BOOTSTRAP, '--file', o.promptFile);
    return { bin: o.bin, args };
  },
  createParser: () => new OpenCodeParser(),
};
