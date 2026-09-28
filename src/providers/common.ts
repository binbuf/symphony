import { isRecord, num, resolveBinary, squash, str } from '../util.js';
import type { BuildCommandOpts, ClassifyHints, TokenUsage } from './types.js';

export function tryJson(line: string): unknown {
  try { return JSON.parse(line); } catch { return undefined; }
}

/** Tool results are a string or an array of content blocks; other shapes are JSON-stringified. */
export function toText(x: unknown): string {
  if (x === undefined || x === null) return '';
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) {
    return x
      .map((b) => (isRecord(b) ? str(b.text) ?? (b.type === 'image' ? '[image]' : JSON.stringify(b)) : String(b)))
      .join('\n');
  }
  if (isRecord(x)) {
    const direct = str(x.text) ?? str(x.output) ?? str(x.content) ?? str(x.message);
    if (direct !== undefined) return direct;
  }
  try { return JSON.stringify(x); } catch { return String(x); }
}

const HINT_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'skill', 'name'];

/** One short line that says what a tool call is about. */
export function hintFromInput(input: unknown): string {
  if (typeof input === 'string') return squash(input, 120);
  if (!isRecord(input)) return '';
  for (const k of HINT_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return squash(v, 120);
  }
  const firstString = Object.values(input).find((v) => typeof v === 'string' && (v as string).trim());
  return typeof firstString === 'string' ? squash(firstString, 120) : '';
}

export function newHints(): ClassifyHints {
  return { apiErrorCategories: [], errorTexts: [] };
}

/** Sum two optional counts, treating undefined as zero; undefined only when both are missing. */
export function sumCounts(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/** Keep only the fields a provider actually reported; undefined when nothing was reported. */
export function compactUsage(u: TokenUsage | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  const out: TokenUsage = {};
  if (u.inputTokens !== undefined) out.inputTokens = u.inputTokens;
  if (u.cachedInputTokens !== undefined) out.cachedInputTokens = u.cachedInputTokens;
  if (u.outputTokens !== undefined) out.outputTokens = u.outputTokens;
  if (u.reasoningTokens !== undefined) out.reasoningTokens = u.reasoningTokens;
  if (u.totalTokens !== undefined) out.totalTokens = u.totalTokens;
  return Object.keys(out).length ? out : undefined;
}

/** Field-wise sum of two usage records (e.g. per-step totals, or a nudge added to a session). */
export function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return compactUsage({
    inputTokens: sumCounts(a.inputTokens, b.inputTokens),
    cachedInputTokens: sumCounts(a.cachedInputTokens, b.cachedInputTokens),
    outputTokens: sumCounts(a.outputTokens, b.outputTokens),
    reasoningTokens: sumCounts(a.reasoningTokens, b.reasoningTokens),
    totalTokens: sumCounts(a.totalTokens, b.totalTokens),
  });
}

/**
 * Best-effort usage from a provider record, tolerant of the spellings the supported CLIs use:
 * Anthropic `input_tokens`/`cache_read_input_tokens`, OpenAI `input_tokens`/`cached_input_tokens`,
 * Gemini `*TokenCount`, and a Gemini-style stats object
 * (`{ models: { <id>: { tokens: { input, output, cached, thoughts, total } } } }`). Nothing is
 * synthesised, so a field the provider does not distinguish stays undefined.
 */
export function usageFrom(record: unknown): TokenUsage | undefined {
  if (!isRecord(record)) return undefined;
  const flat = compactUsage({
    inputTokens: num(record.input_tokens) ?? num(record.inputTokens) ?? num(record.prompt_tokens) ?? num(record.promptTokens) ?? num(record.promptTokenCount),
    cachedInputTokens: num(record.cached_input_tokens) ?? num(record.cachedInputTokens) ?? num(record.cache_read_input_tokens) ?? num(record.cacheReadInputTokens) ?? num(record.cachedContentTokenCount),
    outputTokens: num(record.output_tokens) ?? num(record.outputTokens) ?? num(record.completion_tokens) ?? num(record.completionTokens) ?? num(record.candidatesTokenCount),
    reasoningTokens: num(record.reasoning_tokens) ?? num(record.reasoningTokens) ?? num(record.reasoning_output_tokens) ?? num(record.thoughtsTokenCount),
    totalTokens: num(record.total_tokens) ?? num(record.totalTokens) ?? num(record.totalTokenCount),
  });
  if (flat) return flat;
  const models = record.models;
  if (!isRecord(models)) return undefined;
  let agg: TokenUsage | undefined;
  for (const m of Object.values(models)) {
    const tokens = isRecord(m) && isRecord(m.tokens) ? m.tokens : isRecord(m) ? m : undefined;
    if (!tokens) continue;
    agg = addUsage(agg, compactUsage({
      inputTokens: num(tokens.input) ?? num(tokens.inputTokens) ?? num(tokens.promptTokenCount),
      cachedInputTokens: num(tokens.cached) ?? num(tokens.cachedInputTokens) ?? num(tokens.cachedContentTokenCount),
      outputTokens: num(tokens.output) ?? num(tokens.outputTokens) ?? num(tokens.candidatesTokenCount),
      reasoningTokens: num(tokens.thoughts) ?? num(tokens.reasoningTokens) ?? num(tokens.thoughtsTokenCount),
      totalTokens: num(tokens.total) ?? num(tokens.totalTokens) ?? num(tokens.totalTokenCount),
    }));
  }
  return agg;
}

/**
 * Replacing an oversized prompt: the full text stays in `promptFile` (the runner writes it before
 * the adapter builds its command), so argv carries only a pointer. For a CLI that can attach the
 * file this is the whole message; otherwise it also names the path. Kept deliberately terse — a
 * chatty wrapper measurably dilutes the model's answer (see the inline-first decision in the
 * provider adapters).
 */
export const ATTACHED_PROMPT = 'Read attached prompt.';

/** The prompt-file pointer for CLIs with no attach flag: they get the path in the message itself. */
export function promptFileHint(promptFile: string): string {
  return `Read ${promptFile}`;
}

/**
 * Byte size at which a prompt is assumed to overflow a `cmd.exe` command line. cmd.exe caps the
 * whole line at ~8191 chars; escaping (quote-wrapping and `^`-prefixing every meta character) and
 * the provider's flags add overhead, so 6000 bytes of prompt leaves headroom. Only ever consulted
 * for a Windows `.cmd`/`.bat` shim: a native `.exe` uses CreateProcess's ~32 KB limit instead.
 */
export const ARGV_PROMPT_LIMIT = 6000;

/**
 * Whether `bin` resolves to a Windows `.cmd`/`.bat` shim, which `resolveSpawn` launches through
 * cmd.exe. A bare configured name is resolved on PATH so the npm-install case (`opencode` →
 * `…\node_modules\.bin\opencode.cmd`) is caught; a native `.exe` is not.
 */
export function isCmdShim(bin: string, cwd?: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  return /\.(?:cmd|bat)$/i.test(resolveBinary(bin, { cwd }));
}

/**
 * Whether this prompt must leave argv for the session to launch. Only a cmd.exe shim can overflow
 * (native binaries get ~32 KB), and only past `ARGV_PROMPT_LIMIT`, so ordinary prompts stay inline.
 */
export function promptOverflowsArgv(o: Pick<BuildCommandOpts, 'bin' | 'prompt' | 'cwd'>, platform: NodeJS.Platform = process.platform): boolean {
  return Buffer.byteLength(o.prompt, 'utf8') > ARGV_PROMPT_LIMIT && isCmdShim(o.bin, o.cwd, platform);
}
