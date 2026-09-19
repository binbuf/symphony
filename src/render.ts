import type { NormalizedEvent } from './providers/types.js';
import { clip, squash } from './util.js';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', magenta: '\x1b[35m', cyan: '\x1b[36m' };

export interface RenderOpts { maxChars: number; color: boolean; multiline?: boolean }

/** One compact line per event: what the model is thinking, saying, and doing. */
export function renderEvent(ev: NormalizedEvent, o: RenderOpts): string | null {
  const paint = (c: string, s: string) => (o.color ? `${c}${s}${C.reset}` : s);
  const cut = (s: string) => (o.multiline ? clip(s, o.maxChars) : squash(s, o.maxChars));
  switch (ev.kind) {
    case 'init':
      return paint(C.dim, `[init] session=${ev.sessionId || '?'}${ev.model ? ` model=${ev.model}` : ''}`);
    case 'thinking':
      return `${paint(C.magenta, '[think]')} ${paint(C.dim, cut(ev.text))}`;
    case 'text':
      return `${paint(C.bold, '[text]')} ${cut(ev.text)}`;
    case 'tool_use':
      return `${paint(C.cyan, `[tool] ${ev.name}`)}${ev.hint ? `: ${ev.hint}` : ''}`;
    case 'tool_result': {
      const t = cut(ev.text);
      if (!t) return null;
      return `${paint(ev.isError ? C.red : C.dim, ev.isError ? '[tool-result ERROR]' : '[tool-result]')} ${paint(C.dim, t)}`;
    }
    case 'error':
      return paint(C.red, `[error] ${cut(ev.text)}`);
    case 'raw':
      return `${paint(C.yellow, `[${ev.stream}]`)} ${cut(ev.text)}`;
    case 'result': {
      const head = ev.ok ? paint(C.green, '[result] ok') : paint(C.red, `[result] ERROR${ev.errorSubtype ? ` ${ev.errorSubtype}` : ''}`);
      const meta = [
        ev.costUsd !== undefined ? `$${ev.costUsd.toFixed(2)}` : '',
        ev.turns !== undefined ? `${ev.turns} turns` : '',
        ev.durationMs !== undefined ? `${Math.round(ev.durationMs / 1000)}s` : '',
        ev.synthesized ? 'synthesized' : '',
      ].filter(Boolean).join(' · ');
      const t = cut(ev.text);
      return `${head}${meta ? ` (${meta})` : ''}${t ? `\n${t}` : ''}`;
    }
  }
}
