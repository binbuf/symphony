import { isRecord, num, str } from '../util.js';
import { fileBootstrap, hintFromInput, newHints, toText, tryJson } from './common.js';
import type { ClassifyHints, LineParser, NormalizedEvent, Provider } from './types.js';

/** Cursor CLI `agent -p --output-format stream-json`. */
export class CursorParser implements LineParser {
  private readonly h: ClassifyHints = newHints();
  private readonly toolNames = new Map<string, string>();

  hints(): ClassifyHints { return this.h; }

  parse(line: string): NormalizedEvent[] {
    const ev = tryJson(line);
    if (!isRecord(ev)) return [{ kind: 'raw', text: line, stream: 'stdout' }];
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') return [{ kind: 'init', sessionId: str(ev.session_id) ?? '', model: str(ev.model) }];
        return [];
      case 'user':
        return [];
      case 'assistant': {
        const content = isRecord(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : [];
        const out: NormalizedEvent[] = [];
        for (const b of content) {
          if (!isRecord(b)) continue;
          if (b.type === 'text') { const t = str(b.text) ?? ''; if (t.trim()) out.push({ kind: 'text', text: t }); }
          else if (b.type === 'thinking') { const t = str(b.thinking) ?? str(b.text) ?? ''; if (t.trim()) out.push({ kind: 'thinking', text: t }); }
        }
        return out;
      }
      case 'tool_call': {
        const callId = str(ev.call_id) ?? '';
        const tc = isRecord(ev.tool_call) ? ev.tool_call : {};
        const [kindKey, payloadRaw] = Object.entries(tc)[0] ?? ['tool', {}];
        const payload = isRecord(payloadRaw) ? payloadRaw : {};
        let name = kindKey === 'function' ? str(payload.name) ?? 'function' : kindKey.replace(/ToolCall$/, '');
        let args: unknown = payload.args ?? payload.input ?? payload.arguments;
        if (typeof args === 'string') args = tryJson(args) ?? args;
        if (ev.subtype === 'started') {
          this.toolNames.set(callId, name);
          return [{ kind: 'tool_use', name, hint: hintFromInput(args), input: args }];
        }
        if (ev.subtype === 'completed') {
          name = this.toolNames.get(callId) ?? name;
          const result = payload.result ?? payload.output;
          const isError = isRecord(result) && ('error' in result || 'rejected' in result);
          const text = isRecord(result) && isRecord(result.success) ? toText(result.success) : toText(result);
          return [{ kind: 'tool_result', text, isError }];
        }
        return [];
      }
      case 'result': {
        const subtype = str(ev.subtype) ?? 'success';
        const ok = subtype === 'success' && ev.is_error !== true;
        const text = toText(ev.result);
        if (!ok) this.h.errorTexts.push(text);
        return [{ kind: 'result', ok, text, sessionId: str(ev.session_id), durationMs: num(ev.duration_ms), errorSubtype: ok ? undefined : subtype }];
      }
      case 'error': {
        const text = toText(ev.error ?? ev.message ?? ev);
        this.h.errorTexts.push(text);
        return [{ kind: 'error', text }];
      }
      default:
        return [];
    }
  }
}

export const cursorProvider: Provider = {
  name: 'cursor',
  supportsBudget: false,
  supportsResume: true,
  authCheckArgs: ['status', '--format', 'json'],
  buildCommand(o) {
    // `-p` is a boolean (--print); the prompt is the trailing positional.
    const args = ['-p', '--output-format', 'stream-json', '--workspace', o.cwd, '--trust'];
    if (o.resumeId) args.push('--resume', o.resumeId);
    if (o.model) args.push('--model', o.model);
    if (o.autoApprove) args.push('--force');
    args.push(...o.extraArgs, fileBootstrap(o.promptFile));
    return { bin: o.bin, args };
  },
  createParser: () => new CursorParser(),
};
