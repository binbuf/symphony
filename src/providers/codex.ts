import { isRecord, num, str } from '../util.js';
import { hintFromInput, newHints, toText, tryJson, usageFrom, addUsage } from './common.js';
import type { ClassifyHints, LineParser, NormalizedEvent, Provider } from './types.js';

/**
 * OpenAI Codex CLI `codex exec --json`. JSONL events:
 *   thread.started{thread_id} · turn.started · item.started|item.updated|item.completed{item}
 *   turn.completed{usage} · turn.failed{error{message}} · error{message}
 * item.type: agent_message{text} · reasoning{text} · command_execution{command,aggregated_output,exit_code,status}
 *   file_change{changes[{path,kind}],status} · mcp_tool_call{server,tool,arguments,result,error,status}
 *   web_search{query} · todo_list{items} · error{message}
 * There is no single terminal "result" event with the final text: the last agent_message is the answer,
 * and turn.completed / turn.failed close the run.
 */
export class CodexParser implements LineParser {
  private readonly h: ClassifyHints = newHints();
  private threadId?: string;
  private readonly seen = new Set<string>();
  private lastMessage = '';
  private failed = false;

  hints(): ClassifyHints { return this.h; }

  private itemEvents(item: Record<string, unknown>, phase: 'started' | 'updated' | 'completed'): NormalizedEvent[] {
    const id = str(item.id) ?? '';
    const type = str(item.type) ?? '';
    const key = (k: string) => `${id}:${type}:${k}`;
    const once = (k: string, ev: NormalizedEvent): NormalizedEvent[] => { if (this.seen.has(key(k))) return []; this.seen.add(key(k)); return [ev]; };
    switch (type) {
      case 'agent_message': {
        if (phase !== 'completed') return [];
        const text = str(item.text) ?? '';
        if (!text.trim()) return [];
        this.lastMessage = text;
        return once('text', { kind: 'text', text });
      }
      case 'reasoning': {
        if (phase !== 'completed') return [];
        const text = str(item.text) ?? toText(item.summary);
        return text.trim() ? once('think', { kind: 'thinking', text }) : [];
      }
      case 'command_execution': {
        const out: NormalizedEvent[] = [];
        const cmd = str(item.command) ?? '';
        out.push(...once('use', { kind: 'tool_use', name: 'shell', hint: hintFromInput(cmd), input: { command: cmd } }));
        const status = str(item.status);
        if (phase === 'completed' || status === 'completed' || status === 'failed' || status === 'declined') {
          const code = num(item.exit_code);
          const text = toText(item.aggregated_output);
          out.push(...once('result', { kind: 'tool_result', text: `${status === 'declined' ? '(declined) ' : ''}${code !== undefined && code !== 0 ? `exit ${code}: ` : ''}${text}`.trim(), isError: status === 'failed' || status === 'declined' || (code !== undefined && code !== 0) }));
        }
        return out;
      }
      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const hint = changes.map((c) => (isRecord(c) ? `${str(c.kind) ?? 'edit'} ${str(c.path) ?? ''}`.trim() : '')).filter(Boolean).join(', ');
        const out = once('use', { kind: 'tool_use', name: 'edit', hint: hint.slice(0, 120), input: changes });
        if (phase === 'completed') out.push(...once('result', { kind: 'tool_result', text: `${changes.length} file change${changes.length === 1 ? '' : 's'} ${str(item.status) ?? 'completed'}`, isError: item.status === 'failed' }));
        return out;
      }
      case 'mcp_tool_call': {
        const name = `${str(item.server) ?? 'mcp'}/${str(item.tool) ?? 'tool'}`;
        const out = once('use', { kind: 'tool_use', name, hint: hintFromInput(item.arguments), input: item.arguments });
        if (phase === 'completed') out.push(...once('result', { kind: 'tool_result', text: toText(item.error ?? item.result), isError: item.error !== undefined && item.error !== null }));
        return out;
      }
      case 'web_search':
        return once('use', { kind: 'tool_use', name: 'web_search', hint: str(item.query) ?? '', input: item });
      case 'todo_list':
        return phase === 'completed' ? once('todo', { kind: 'text', text: `todo: ${toText(item.items)}` }) : [];
      case 'error': {
        const text = str(item.message) ?? toText(item);
        this.h.errorTexts.push(text);
        return once('err', { kind: 'error', text });
      }
      default:
        return [];
    }
  }

  parse(line: string): NormalizedEvent[] {
    const ev = tryJson(line);
    if (!isRecord(ev)) return [{ kind: 'raw', text: line, stream: 'stdout' }];
    switch (ev.type) {
      case 'thread.started':
        this.threadId = str(ev.thread_id) ?? this.threadId;
        return this.threadId ? [{ kind: 'init', sessionId: this.threadId }] : [];
      case 'turn.started':
        return [];
      case 'item.started': return isRecord(ev.item) ? this.itemEvents(ev.item, 'started') : [];
      case 'item.updated': return isRecord(ev.item) ? this.itemEvents(ev.item, 'updated') : [];
      case 'item.completed': return isRecord(ev.item) ? this.itemEvents(ev.item, 'completed') : [];
      case 'turn.completed': {
        // Cost is not reported; token usage goes to the result event and stays in the log line too.
        const raw = isRecord(ev.usage) ? ev.usage : {};
        this.h.usage = addUsage(this.h.usage, usageFrom(raw));
        const tokens = ['input_tokens', 'cached_input_tokens', 'output_tokens'].map((k) => `${k.replace('_tokens', '')}=${num(raw[k]) ?? 0}`).join(' ');
        return [{ kind: 'result', ok: !this.failed, text: this.lastMessage, sessionId: this.threadId, errorSubtype: this.failed ? 'turn_failed' : undefined, turns: undefined, durationMs: undefined, costUsd: undefined, synthesized: false, ...(this.h.usage ? { usage: this.h.usage } : {}) }, { kind: 'raw', text: `usage ${tokens}`, stream: 'stdout' }];
      }
      case 'turn.failed': {
        this.failed = true;
        const err = isRecord(ev.error) ? ev.error : {};
        const text = str(err.message) ?? toText(ev.error);
        this.h.errorTexts.push(text);
        return [{ kind: 'error', text }, { kind: 'result', ok: false, text: this.lastMessage, sessionId: this.threadId, errorSubtype: 'turn_failed' }];
      }
      case 'error': {
        const text = str(ev.message) ?? toText(ev);
        this.h.errorTexts.push(text);
        return [{ kind: 'error', text }];
      }
      default:
        return [];
    }
  }
}

export const codexProvider: Provider = {
  name: 'codex',
  supportsBudget: false,
  supportsResume: true,
  supportsVariant: true,
  supportsMcp: true,
  authCheckArgs: ['login', 'status'],
  buildCommand(o) {
    // `codex exec [resume <id>] [flags] <prompt>`; `-` reads the prompt from stdin.
    const args = ['exec'];
    if (o.resumeId) args.push('resume', o.resumeId);
    args.push('--json', '--color', 'never', '--skip-git-repo-check');
    if (!o.resumeId) args.push('--cd', o.cwd);
    if (o.model) args.push('--model', o.model);
    // Codex has no effort flag: the setting is a config key, overridden per invocation.
    if (o.variant) args.push('-c', `model_reasoning_effort=${o.variant}`);
    if (o.readOnly) args.push('--sandbox', 'read-only', '--ask-for-approval', 'never');
    else if (o.autoApprove) args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('--sandbox', 'workspace-write', '--ask-for-approval', 'never');
    args.push(...o.extraArgs);
    // `-` reads the prompt from stdin; never place the prompt on argv.
    args.push('-');
    return { bin: o.bin, args, stdinPayload: o.prompt };
  },
  createParser: () => new CodexParser(),
};
