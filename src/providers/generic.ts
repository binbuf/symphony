import { isRecord, num, str } from '../util.js';
import { newHints, toText, tryJson } from './common.js';
import type { ClassifyHints, LineParser, NormalizedEvent } from './types.js';

/**
 * Best-effort parser for CLIs whose stream schema is not pinned (Gemini CLI, Antigravity).
 * It recognises the shapes these tools are most likely to emit and, crucially, treats anything
 * else as assistant text so a `SYMPHONY_RESULT` block is never lost to a `raw` line.
 */
export class GenericParser implements LineParser {
  private readonly h: ClassifyHints = newHints();
  private sawSession = false;

  hints(): ClassifyHints { return this.h; }

  private mapRecord(ev: Record<string, unknown>): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    const sid = str(ev.session_id) ?? str(ev.sessionId) ?? str(ev.thread_id);
    if (sid && !this.sawSession) { this.sawSession = true; out.push({ kind: 'init', sessionId: sid, model: str(ev.model) }); }

    const type = (str(ev.type) ?? str(ev.kind) ?? '').toLowerCase();
    if (type === 'error' || ev.error !== undefined) {
      const text = str(ev.message) ?? toText(ev.error ?? ev);
      this.h.errorTexts.push(text);
      out.push({ kind: 'error', text });
      return out;
    }
    if (type === 'thinking' || type === 'reasoning') {
      const t = str(ev.text) ?? str(ev.thinking) ?? toText(ev.summary);
      if (t.trim()) out.push({ kind: 'thinking', text: t });
      return out;
    }
    if (type === 'tool_use' || type === 'tool_call' || type === 'function_call') {
      const name = str(ev.name) ?? str(ev.tool) ?? str(ev.tool_name) ?? 'tool';
      out.push({ kind: 'tool_use', name, hint: '', input: ev });
      return out;
    }
    if (type === 'tool_result' || type === 'function_response') {
      out.push({ kind: 'tool_result', text: toText(ev.result ?? ev.output ?? ev.content), isError: ev.is_error === true });
      return out;
    }
    if (type === 'result') {
      const ok = ev.is_error !== true && ev.ok !== false;
      const text = toText(ev.result ?? ev.response ?? ev.text ?? ev.content);
      const cost = num(ev.cost_usd) ?? num(ev.total_cost_usd) ?? num(ev.cost);
      if (!ok) this.h.errorTexts.push(text);
      if (cost !== undefined) this.h.costUsd = cost;
      out.push({ kind: 'result', ok, text, sessionId: sid, costUsd: cost, errorSubtype: ok ? undefined : str(ev.subtype) });
      return out;
    }

    // Assistant content block(s), Claude/Gemini style.
    if (isRecord(ev.message) && Array.isArray((ev.message as Record<string, unknown>).content)) {
      const content = (ev.message as Record<string, unknown>).content as unknown[];
      for (const b of content) {
        if (!isRecord(b)) continue;
        if (b.type === 'thinking') { const t = str(b.thinking) ?? str(b.text) ?? ''; if (t.trim()) out.push({ kind: 'thinking', text: t }); }
        else if (b.type === 'text') { const t = str(b.text) ?? ''; if (t.trim()) out.push({ kind: 'text', text: t }); }
        else if (b.type === 'tool_use') out.push({ kind: 'tool_use', name: str(b.name) ?? 'tool', hint: '', input: b.input });
      }
      if (out.length) return out;
    }

    // The terminal answer object: a bare `response`/`text` field is the final message.
    const finalText = str(ev.response) ?? str(ev.text) ?? str(ev.output);
    if (finalText !== undefined) {
      if (type === 'text' || type === 'assistant' || type === 'response' || type === '') {
        if (finalText.trim()) out.push({ kind: 'text', text: finalText });
        return out;
      }
    }
    return out;
  }

  parse(line: string): NormalizedEvent[] {
    const ev = tryJson(line);
    if (!isRecord(ev)) {
      const t = line.trim();
      return t ? [{ kind: 'text', text: line }] : [];
    }
    const mapped = this.mapRecord(ev);
    return mapped.length ? mapped : [{ kind: 'raw', text: line, stream: 'stdout' }];
  }
}