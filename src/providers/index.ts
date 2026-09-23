import { antigravityProvider } from './antigravity.js';
import { claudeProvider } from './claude.js';
import { codexProvider } from './codex.js';
import { cursorProvider } from './cursor.js';
import { fakeProvider } from './fake.js';
import { geminiProvider } from './gemini.js';
import { opencodeProvider } from './opencode.js';
import type { Provider, ProviderName } from './types.js';

const REGISTRY: Record<ProviderName, Provider> = {
  claude: claudeProvider,
  cursor: cursorProvider,
  opencode: opencodeProvider,
  codex: codexProvider,
  gemini: geminiProvider,
  antigravity: antigravityProvider,
  fake: fakeProvider,
};

export function getProvider(name: ProviderName): Provider {
  return REGISTRY[name];
}

/**
 * Whether `variant` can be applied to this provider/model. Providers without a variant knob never
 * qualify; providers with a per-model catalog (OpenCode) qualify only when the model advertises the
 * variant; providers without a catalog accept it for every model. An unreadable catalog is treated
 * as unsupported so a variant is never sent to a model that may reject it.
 */
export function variantSupported(provider: ProviderName, bin: string, model: string | undefined, variant: string): boolean {
  const p = REGISTRY[provider];
  if (!p.supportsVariant) return false;
  if (!p.modelVariants) return true;
  const variants = p.modelVariants(bin, model);
  return variants !== undefined && variants.has(variant);
}
