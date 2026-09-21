import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Prompt prose lives in `.md` files under `src/prompts/` (copied to `dist/prompts/` at build time).
 * TypeScript keeps all branching, loops and derived values; the files hold only the text, with
 * `{name}` placeholders that this module substitutes.
 */
const PROMPT_DIR = join(import.meta.dirname, 'prompts');
const cache = new Map<string, string>();

/** Read a prompt template, cached after first use. */
export function loadPrompt(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const text = readFileSync(join(PROMPT_DIR, name), 'utf8');
  cache.set(name, text);
  return text;
}

/**
 * Replace `{name}` placeholders. Throws when the template references a key that was not provided, so a
 * renamed variable fails loudly instead of shipping a literal `{name}` to the model.
 */
export function render(template: string, vars: Record<string, string | number>): string {
  const missing = new Set<string>();
  const out = template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key]);
    missing.add(key);
    return match;
  });
  if (missing.size) throw new Error(`prompt template has unresolved placeholders: ${[...missing].join(', ')}`);
  return out;
}

/** Load and render a prompt in one step. */
export function renderPrompt(name: string, vars: Record<string, string | number>): string {
  return render(loadPrompt(name), vars);
}

/**
 * Split a prompt file into named parts at `<!-- part: name -->` lines. Used where the prompt is an
 * ordered list whose entries are conditionally included (the docs contract).
 */
export function loadParts(name: string): Record<string, string> {
  const raw = loadPrompt(name);
  const marker = /^<!--\s*part:\s*(\w+)\s*-->\s*$/gm;
  const parts: Record<string, string> = {};
  let current: string | undefined;
  let start = 0;
  for (let m = marker.exec(raw); m; m = marker.exec(raw)) {
    if (current !== undefined) parts[current] = trimNewlines(raw.slice(start, m.index));
    current = m[1];
    start = marker.lastIndex;
  }
  if (current !== undefined) parts[current] = trimNewlines(raw.slice(start));
  return parts;
}

function trimNewlines(s: string): string {
  return s.replace(/^\n+|\n+$/g, '');
}
