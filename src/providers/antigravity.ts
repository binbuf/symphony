import { fileBootstrap } from './common.js';
import { GenericParser } from './generic.js';
import type { Provider } from './types.js';

/**
 * Google Antigravity CLI (`antigravity`). Antigravity is primarily an agent IDE; its CLI runs a
 * headless agent with `-p/--print` and a trust/auto flag. Flags here follow the same shape as the
 * other `-p` CLIs and can be corrected per install via `providers.antigravity.extraArgs` or `.bin`.
 * Output is parsed best-effort (GenericParser).
 */
export const antigravityProvider: Provider = {
  name: 'antigravity',
  supportsBudget: false,
  supportsResume: false,
  buildCommand(o) {
    const args = ['-p', '--output-format', 'json', '--workspace', o.cwd];
    if (o.autoApprove) args.push('--dangerously-skip-permissions');
    if (o.model) args.push('--model', o.model);
    args.push(...o.extraArgs, fileBootstrap(o.promptFile));
    return { bin: o.bin, args };
  },
  createParser: () => new GenericParser(),
};