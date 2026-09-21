import { isRecord, squash, str } from '../util.js';
import type { ClassifyHints } from './types.js';

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

/** Linux caps a single argv string at 128 KB; Windows caps the whole command line at ~32 KB. */
export const ARGV_PROMPT_LIMIT = process.platform === 'win32' ? 24 * 1024 : 64 * 1024;

export function argvPrompt(prompt: string, promptFile: string): string {
  if (Buffer.byteLength(prompt, 'utf8') <= ARGV_PROMPT_LIMIT) return prompt;
  return `Read the file ${promptFile} and follow the instructions in it exactly. It is your complete task briefing; do not start work before reading all of it.`;
}
