import { isRecord, num, squash, str } from '../util.js';
import type { ClassifyHints, TokenUsage } from './types.js';

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
 * The runner always writes the full prompt to `promptFile` before the adapter builds its command,
 * so adapters never need to carry that payload on argv. OS argv limits are platform-specific and
 * apply to the whole command line (Windows caps it near 32 KB, Linux caps a single arg at 128 KB),
 * so any byte threshold on the prompt alone is a broken contract. Instead: send the prompt over
 * stdin, attach it as a file where the CLI supports it, or pass a short bootstrap that names the
 * prompt file.
 */
export function fileBootstrap(promptFile: string): string {
  return `Read the file ${promptFile} and follow the instructions in it exactly. It is your complete task briefing; do not start work before reading all of it.`;
}

/** Bootstrap for CLIs that accept the prompt as an attached file (e.g. opencode `--file`). */
export const ATTACHED_BOOTSTRAP = 'Follow the instructions in the attached file exactly. It is your complete task briefing; do not start work before reading all of it.';
