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

export const opencodeProvider: Provider = {
  name: 'opencode',
  supportsBudget: false,
  supportsResume: true,
  authCheckArgs: ['auth', 'list'],
  buildCommand(o) {
    // The working directory is set via the spawn cwd; opencode has no `--dir` flag (the directory is
    // positional for the top-level command). Pass only flags this CLI understands.
    const args = ['run', '--standalone', '--format', 'json', '--thinking'];
    if (o.resumeId) args.push('--session', o.resumeId);
    if (o.model) args.push('--model', o.model);
    if (o.autoApprove) args.push('--auto');
    // The full prompt is attached with `--file`; argv only carries a short bootstrap so an oversized
    // prompt can never overflow the OS command-line limit.
    args.push('--file', o.promptFile, ...o.extraArgs, ATTACHED_BOOTSTRAP);
    return { bin: o.bin, args };
  },
  createParser: () => new OpenCodeParser(),
};
