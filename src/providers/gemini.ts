import { argvPrompt } from './common.js';
import { GenericParser } from './generic.js';
import type { Provider } from './types.js';

/**
 * Google Gemini CLI (`gemini`). Non-interactive with `-p/--prompt`; `--yolo` bypasses approval
 * prompts. Output is parsed best-effort (see GenericParser); the prompt is passed on argv when it
 * fits and via `--prompt-file`-style instruction to read the written prompt file otherwise.
 */
export const geminiProvider: Provider = {
  name: 'gemini',
  supportsBudget: false,
  supportsResume: false,
  buildCommand(o) {
    const args = ['--output-format', 'json'];
    if (o.model) args.push('--model', o.model);
    if (o.autoApprove) args.push('--yolo');
    args.push(...o.extraArgs);
    args.push('--prompt', argvPrompt(o.prompt, o.promptFile));
    return { bin: o.bin, args };
  },
  createParser: () => new GenericParser(),
};