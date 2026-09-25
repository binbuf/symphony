import { isRecord, num, str } from '../util.js';
import { hintFromInput, newHints, toText, tryJson } from './common.js';
import type { ClassifyHints, LineParser, NormalizedEvent, Provider } from './types.js';

/**
 * Claude Code `claude -p --output-format stream-json --verbose`.
 * Whitelist parser: a real session emits hundreds of `system/*`, `tool_progress`, `rate_limit_event`
 * and `stream_event` lines that are noise for our purposes.
 */
export class ClaudeParser implements LineParser {
  private readonly h: ClassifyHints = newHints();

  hints(): ClassifyHints { return this.h; }

  parse(line: string): NormalizedEvent[] {
    const ev = tryJson(line);
    if (!isRecord(ev)) return [{ kind: 'raw', text: line, stream: 'stdout' }];
    switch (ev.type) {
      case 'system': {
        if (ev.subtype === 'init') return [{ kind: 'init', sessionId: str(ev.session_id) ?? '', model: str(ev.model) }];
        if (ev.subtype === 'api_retry') {
          const cat = str(ev.error) ?? 'unknown';
          this.h.apiErrorCategories.push(cat);
          const text = `api_retry ${cat} attempt ${ev.attempt ?? '?'}/${ev.max_retries ?? '?'}${ev.error_status ? ` http ${ev.error_status}` : ''}${ev.retry_delay_ms ? ` next in ${Math.round(Number(ev.retry_delay_ms) / 1000)}s` : ''}`;
          this.h.errorTexts.push(text);
          return [{ kind: 'error', text }];
        }
        if (ev.subtype === 'permission_denied') {
          const text = `permission denied: ${str(ev.tool_name) ?? toText(ev.tool_use ?? ev.reason ?? '')}`;
          return [{ kind: 'error', text }];
        }
        return [];
      }
      case 'assistant': {
        const content = isRecord(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : [];
        const out: NormalizedEvent[] = [];
        for (const b of content) {
          if (!isRecord(b)) continue;
          if (b.type === 'thinking') { const t = str(b.thinking) ?? ''; if (t.trim()) out.push({ kind: 'thinking', text: t }); }
          else if (b.type === 'text') { const t = str(b.text) ?? ''; if (t.trim()) out.push({ kind: 'text', text: t }); }
          else if (b.type === 'tool_use') out.push({ kind: 'tool_use', name: str(b.name) ?? 'tool', hint: hintFromInput(b.input), input: b.input });
        }
        return out;
      }
      case 'user': {
        const content = isRecord(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : [];
        const out: NormalizedEvent[] = [];
        for (const b of content) {
          if (isRecord(b) && b.type === 'tool_result') out.push({ kind: 'tool_result', text: toText(b.content), isError: b.is_error === true });
        }
        return out;
      }
      case 'result': {
        const subtype = str(ev.subtype) ?? 'success';
        const ok = ev.is_error !== true && subtype === 'success';
        const text = toText(ev.result);
        if (!ok) {
          this.h.errorTexts.push(text);
          if (Array.isArray(ev.errors)) for (const e of ev.errors) this.h.errorTexts.push(toText(e));
        }
        const cost = num(ev.total_cost_usd);
        if (cost !== undefined) this.h.costUsd = cost;
        return [{
          kind: 'result', ok, text,
          sessionId: str(ev.session_id), costUsd: cost, turns: num(ev.num_turns),
          errorSubtype: ok ? undefined : subtype, durationMs: num(ev.duration_ms),
        }];
      }
      default:
        return [];
    }
  }
}

export const claudeProvider: Provider = {
  name: 'claude',
  supportsBudget: true,
  supportsResume: true,
  supportsVariant: true,
  authCheckArgs: ['auth', 'status'],
  buildCommand(o) {
    // Prompt goes over stdin (avoids argv limits; the predecessor harness ran ~70 sessions this way).
    const args = ['-p', 'Follow the instructions provided on stdin exactly.', '--output-format', 'stream-json', '--verbose'];
    if (o.resumeId) args.push('--resume', o.resumeId);
    if (o.model) args.push('--model', o.model);
    // Claude Code's session effort knob: low | medium | high | xhigh | max.
    if (o.variant) args.push('--effort', o.variant);
    if (o.budgetUsd !== undefined) args.push('--max-budget-usd', String(o.budgetUsd));
    if (o.readOnly) {
      // Read-only sessions may read but not write or run commands: allow Read, block the write/shell tools.
      args.push('--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--allowedTools', 'Read', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash');
    } else if (o.autoApprove) args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', 'acceptEdits', '--permission-prompts', 'none');
    args.push(...o.extraArgs);
    return { bin: o.bin, args, stdinPayload: o.prompt };
  },
  createParser: () => new ClaudeParser(),
};
