import { claudeProvider } from './claude.js';
import { codexProvider } from './codex.js';
import { cursorProvider } from './cursor.js';
import { fakeProvider } from './fake.js';
import { opencodeProvider } from './opencode.js';
import type { Provider, ProviderName } from './types.js';

const REGISTRY: Record<ProviderName, Provider> = {
  claude: claudeProvider,
  cursor: cursorProvider,
  opencode: opencodeProvider,
  codex: codexProvider,
  fake: fakeProvider,
};

export function getProvider(name: ProviderName): Provider {
  return REGISTRY[name];
}
