export type ErrorCategory =
  | 'auth' | 'billing' | 'usage_limit' | 'model' | 'config'          // fatal by default → halt
  | 'rate_limit' | 'overloaded' | 'server' | 'network' | 'stall' | 'crash'  // transient → retry
  | 'timeout' | 'budget' | 'max_turns' | 'task' | 'interrupted' | 'unknown'; // terminal for this task

export interface Classified { category: ErrorCategory; fatal: boolean; transient: boolean; message: string; retryAfterSec?: number }

export interface FailureEvidence {
  /** Structured categories from the provider (e.g. Claude `system/api_retry.error`). */
  apiErrorCategories: string[];
  /** Text from error events. */
  errorTexts: string[];
  resultOk: boolean;
  resultSubtype?: string;
  resultText?: string;
  sawResult: boolean;
  /** The provider emitted at least one `error` event (a provider/transport fault, not a task failure). */
  sawError?: boolean;
  /** HTTP status parsed from a provider error, when the adapter could see one. */
  httpStatus?: number;
  /** Provider-declared retryability, when an error event carried it. */
  retryable?: boolean;
  /** Server-requested delay before the next attempt, in seconds. */
  retryAfterSec?: number;
  exitCode: number | null;
  signal: string | null;
  spawnError?: string;
  stderrTail: string;
  timedOut: boolean;
  stalled: boolean;
  interrupted: boolean;
}

const TRANSIENT: ErrorCategory[] = ['rate_limit', 'overloaded', 'server', 'network', 'stall', 'crash'];

const RULES: Array<[ErrorCategory, RegExp]> = [
  ['billing', /credit balance|insufficient (funds|credits|balance)|billing|payment required|\b402\b|out of credits|account (is )?on hold|top up/i],
  // rate_limit must come before usage_limit: "rate limit reached" would otherwise match usage_limit's
  // "limit reached" and halt the run on what is only a transient throttle. New providers phrase a
  // throttle many ways, so the pattern is deliberately broad (see also the HTTP-status short-circuit).
  ['rate_limit', /\b429\b|rate[ _-]?limit|too many requests|throttl|requests? per (second|minute|hour|day)|\b(?:rpm|tpm|rps)\b|retry[ _-]?after/i],
  ['usage_limit', /usage limit|hit your limit|plan limit|limit reached|resets at \d/i],
  // "please login" phrases, but not a bare "please run <anything>".
  ['auth', /not (logged|signed) in|unauthori[sz]ed|\b40[13]\b|invalid (api[ _]?key|token|credentials?)|authentication|token (has )?expired|please\s+(?:run\s+|use\s+)?[`"']?\/?(?:log ?in|sign ?in)\b|login required|oauth/i],
  ['model', /model[_ ]not[_ ]found|unknown model|invalid model|model .{1,60}(does not exist|not (found|available|supported))/i],
  ['config', /unknown (option|argument|flag|command)|invalid_request|invalid request|too many arguments|missing required/i],
  ['overloaded', /overloaded|\b529\b|at capacity|over capacity|capacity exceeded|service (is )?(busy|unavailable)/i],
  ['server', /\b50[0-9]\b|internal server error|service unavailable|bad gateway|gateway time-?out|upstream/i],
  ['network', /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network (error|failure)|connection (reset|closed|refused|lost|error)|disconnected|unable to connect|dns|tls|handshake|proxy/i],
];

const STRUCTURED: Record<string, ErrorCategory> = {
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  cloud_credential_error: 'auth',
  account_on_hold: 'billing',
  billing_error: 'billing',
  model_not_found: 'model',
  invalid_request: 'config',
  rate_limit: 'rate_limit',
  overloaded: 'overloaded',
  server_error: 'server',
  max_output_tokens: 'unknown',
};

function firstLine(s: string, max = 300): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The evidence text classifyFailure matches its rules against; reused by the Jev tie-breaker. */
export function evidenceText(ev: FailureEvidence): string {
  return [
    ev.resultSubtype ?? '',
    ev.resultOk ? '' : ev.resultText ?? '',
    ...ev.errorTexts,
    ev.httpStatus !== undefined ? `HTTP ${ev.httpStatus}` : '',
    ev.stderrTail,
  ].filter(Boolean).join('\n');
}

/** Map an HTTP status to a failure category. Unknown 4xx return undefined (a request problem is not transient). */
function categoryForStatus(status: number): ErrorCategory | undefined {
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  if (status === 408) return 'network';
  if (status >= 500 && status <= 599) return 'server';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  return undefined;
}

/** Build a Classified for a category, deriving fatal/transient from the harness's own rules. */
export function makeClassified(category: ErrorCategory, message: string, fatalCategories: string[]): Classified {
  return { category, fatal: fatalCategories.includes(category), transient: TRANSIENT.includes(category), message: firstLine(message) };
}

export function classifyFailure(ev: FailureEvidence, fatalCategories: string[]): Classified {
  const make = (category: ErrorCategory, message: string): Classified => {
    const c = makeClassified(category, message, fatalCategories);
    if (ev.retryAfterSec !== undefined) c.retryAfterSec = ev.retryAfterSec;
    return c;
  };

  if (ev.spawnError) {
    return make('config', /ENOENT/.test(ev.spawnError) ? `provider binary not found (${ev.spawnError})` : `could not start provider: ${ev.spawnError}`);
  }
  if (ev.interrupted) return make('interrupted', 'interrupted by signal');
  if (ev.timedOut) return make('timeout', 'wall-clock timeout');
  if (ev.stalled) return make('stall', 'no output from the agent for the idle timeout');

  // Structured signals first (Claude api_retry categories): the *last* one is what the session died on.
  const cats = ev.apiErrorCategories.filter((c) => c in STRUCTURED);
  const evidence = evidenceText(ev);

  if (ev.resultSubtype === 'error_max_budget_usd') return make('budget', 'per-task budget exhausted (--max-budget-usd)');
  if (ev.resultSubtype === 'error_max_turns') return make('max_turns', 'max turns reached');

  if (cats.length) {
    const last = cats[cats.length - 1];
    const cat = STRUCTURED[last];
    // A retry category alone does not mean failure; only consult it when the session did not succeed.
    if (cat !== 'unknown') return make(cat, `${last}: ${firstLine(evidence || 'provider reported ' + last, 200)}`);
  }

  for (const [cat, re] of RULES) {
    const m = re.exec(evidence);
    if (m) {
      const idx = Math.max(0, evidence.lastIndexOf('\n', m.index) + 1);
      const end = evidence.indexOf('\n', m.index);
      return make(cat, evidence.slice(idx, end === -1 ? undefined : end));
    }
  }

  // A provider-level error event or an HTTP status is strong evidence of an infrastructure fault even
  // when the wording is one the rules do not know: new providers phrase throttling many ways, and the
  // AI SDK often reports a generic message with the real 429/503 in a separate field. Only consulted
  // when no rule matched and the session did not succeed, so it never overrides a recognised category.
  if (!ev.resultOk) {
    if (ev.httpStatus !== undefined) {
      const byStatus = categoryForStatus(ev.httpStatus);
      // An unrecognised 4xx is a request problem, not a transient fault: leave it terminal.
      if (byStatus) return make(byStatus, `HTTP ${ev.httpStatus}: ${firstLine(evidence || 'provider error', 180)}`);
    } else if (ev.retryable === true) {
      return make('server', `provider flagged a retryable error: ${firstLine(evidence || 'no detail', 180)}`);
    } else if (ev.sawError) {
      return make('server', `provider error: ${firstLine(evidence || 'no detail', 180)}`);
    }
  }

  if (!ev.sawResult && (ev.exitCode !== 0 || ev.signal)) {
    return make('crash', `agent exited ${ev.signal ? `on ${ev.signal}` : `with code ${ev.exitCode}`} without a result${ev.stderrTail ? `: ${firstLine(ev.stderrTail, 200)}` : ''}`);
  }
  if (!ev.resultOk) return make('unknown', `provider reported failure${ev.resultSubtype ? ` (${ev.resultSubtype})` : ''}: ${firstLine(ev.resultText ?? evidence ?? '', 200)}`);
  return make('task', 'task did not complete');
}
