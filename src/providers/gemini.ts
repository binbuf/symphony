import { fileBootstrap } from './common.js';
import { GenericParser } from './generic.js';
import type { Provider } from './types.js';

/**
 * Google Gemini CLI (`gemini`). Non-interactive with `-p/--prompt`; `--yolo` bypasses approval
 * prompts. Output is parsed best-effort (see GenericParser); the prompt is written to a file by the
 * runner and argv carries only a short bootstrap that names it (never the payload).
 */
export const geminiProvider: Provider = {
  name: 'gemini',
  supportsBudget: false,
  supportsResume: false,
  supportsVariant: false,
  supportsMcp: true,
  buildCommand(o) {
    const args = ['--output-format', 'json'];
    if (o.model) args.push('--model', o.model);
    if (o.autoApprove) args.push('--yolo');
    args.push(...o.extraArgs);
    args.push('--prompt', fileBootstrap(o.promptFile));
    return { bin: o.bin, args };
  },
  createParser: () => new GenericParser(),
};