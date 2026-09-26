export type ProviderName = 'claude' | 'cursor' | 'opencode' | 'codex' | 'gemini' | 'antigravity' | 'fake';

export interface BuildCommandOpts {
  bin: string;
  prompt: string;
  /** The prompt is always written here first; adapters may tell the agent to read it. */
  promptFile: string;
  taskId: string;
  attempt: number;
  kind: 'task' | 'resume' | 'nudge' | 'continue' | 'escalate';
  resumeId?: string;
  model?: string;
  /** Reasoning-effort / variant knob, already validated for this provider (e.g. "high"). */
  variant?: string;
  autoApprove: boolean;
  /** When true the session may read files but must not edit or run commands; adapters map this to their read-only mode. */
  readOnly?: boolean;
  budgetUsd?: number;
  extraArgs: string[];
  cwd: string;
}

export interface SpawnSpec {
  bin: string;
  args: string[];
  stdinPayload?: string;
  env?: Record<string, string>;
}

/**
 * Provider-reported token usage for one session, recorded as the provider spells it. Semantics
 * differ (for OpenAI-style usage `inputTokens` includes cached tokens; for Anthropic-style it
 * excludes cache reads/creations, which are summed into `cachedInputTokens`), so fields are never
 * synthesised: a provider that does not report a distinction leaves the field undefined.
 */
export interface TokenUsage {
  inputTokens?: number;
  /** Input served from / written to the prompt cache, where the provider reports it separately. */
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export type NormalizedEvent =
  | { kind: 'init'; sessionId: string; model?: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; name: string; hint: string; input?: unknown }
  | { kind: 'tool_result'; text: string; isError?: boolean }
  | ResultEvent
  | { kind: 'error'; text: string }
  | { kind: 'raw'; text: string; stream: 'stdout' | 'stderr' };

export interface ResultEvent {
  kind: 'result';
  ok: boolean;
  text: string;
  sessionId?: string;
  costUsd?: number;
  turns?: number;
  errorSubtype?: string;
  durationMs?: number;
  synthesized?: boolean;
  /** Token usage the provider reported with this result, when it reports it on the result event. */
  usage?: TokenUsage;
}

export interface ClassifyHints {
  apiErrorCategories: string[];
  errorTexts: string[];
  costUsd?: number;
  /** HTTP status parsed from a provider error event (e.g. 429, 503), when the adapter can see it. */
  httpStatus?: number;
  /** Provider-declared retryability (`isRetryable`), when an error event carries it. */
  retryable?: boolean;
  /** Server-requested delay before the next attempt, in seconds (Retry-After). */
  retryAfterSec?: number;
  /** Token usage accumulated across the session's events, when the provider reports it. */
  usage?: TokenUsage;
}

export interface LineParser {
  parse(line: string): NormalizedEvent[];
  hints(): ClassifyHints;
}

export interface Provider {
  readonly name: ProviderName;
  readonly supportsBudget: boolean;
  readonly supportsResume: boolean;
  /** Whether the CLI has a reasoning-effort / variant knob the harness can set. */
  readonly supportsVariant: boolean;
  /** Whether a session's MCP servers can be scoped per invocation by the adapter (see src/mcp.ts). */
  readonly supportsMcp: boolean;
  /**
   * The variant ids a model advertises, when the provider exposes a per-model catalog (OpenCode
   * does). `undefined` means the catalog could not be read, so support is unknown; a provider with
   * no catalog leaves this undefined and accepts the variant for every model.
   */
  readonly modelVariants?: (bin: string, model: string | undefined) => Set<string> | undefined;
  /** Args appended to `bin` for a preflight auth check; exit 0 = authenticated. */
  readonly authCheckArgs?: string[];
  buildCommand(o: BuildCommandOpts): SpawnSpec;
  createParser(): LineParser;
}
