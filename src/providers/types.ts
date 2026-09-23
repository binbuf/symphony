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
}

export interface LineParser {
  parse(line: string): NormalizedEvent[];
  hints(): ClassifyHints;
}

export interface Provider {
  readonly name: ProviderName;
  readonly supportsBudget: boolean;
  readonly supportsResume: boolean;
  /** Args appended to `bin` for a preflight auth check; exit 0 = authenticated. */
  readonly authCheckArgs?: string[];
  buildCommand(o: BuildCommandOpts): SpawnSpec;
  createParser(): LineParser;
}
