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
