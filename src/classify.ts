export type ErrorCategory =
  | 'auth' | 'billing' | 'usage_limit' | 'model' | 'config'          // fatal by default → halt
  | 'rate_limit' | 'overloaded' | 'server' | 'network' | 'stall' | 'crash'  // transient → retry
  | 'timeout' | 'budget' | 'max_turns' | 'task' | 'interrupted' | 'unknown'; // terminal for this task

export interface Classified { category: ErrorCategory; fatal: boolean; transient: boolean; message: string }

export interface FailureEvidence {
  /** Structured categories from the provider (e.g. Claude `system/api_retry.error`). */
  apiErrorCategories: string[];
  /** Text from error events. */
  errorTexts: string[];
  resultOk: boolean;
  resultSubtype?: string;
  resultText?: string;
  sawResult: boolean;
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
  ['usage_limit', /usage limit|hit your limit|plan limit|limit reached|resets at \d/i],
  ['auth', /not (logged|signed) in|unauthori[sz]ed|\b40[13]\b|invalid (api[ _]?key|token|credentials?)|authentication|token (has )?expired|please (run|log ?in)|login required|oauth/i],
  ['model', /model[_ ]not[_ ]found|unknown model|invalid model|model .{1,60}(does not exist|not (found|available|supported))/i],
  ['config', /unknown (option|argument|flag|command)|invalid_request|invalid request|too many arguments|missing required/i],
  ['rate_limit', /\b429\b|rate[ _-]?limit|too many requests/i],
  ['overloaded', /overloaded|\b529\b|capacity/i],
  ['server', /\b50[023]\b|internal server error|service unavailable|bad gateway|upstream/i],
  ['network', /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network (error|failure)|connection (reset|closed|refused|lost|error)|disconnected|unable to connect|dns/i],
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

export function classifyFailure(ev: FailureEvidence, fatalCategories: string[]): Classified {
  const make = (category: ErrorCategory, message: string): Classified => ({
    category,
    fatal: fatalCategories.includes(category),
    transient: TRANSIENT.includes(category),
    message: firstLine(message),
  });

  if (ev.spawnError) {
    return make('config', /ENOENT/.test(ev.spawnError) ? `provider binary not found (${ev.spawnError})` : `could not start provider: ${ev.spawnError}`);
  }
  if (ev.interrupted) return make('interrupted', 'interrupted by signal');
  if (ev.timedOut) return make('timeout', 'wall-clock timeout');
  if (ev.stalled) return make('stall', 'no output from the agent for the idle timeout');

  // Structured signals first (Claude api_retry categories): the *last* one is what the session died on.
  const cats = ev.apiErrorCategories.filter((c) => c in STRUCTURED);
  const evidence = [ev.resultSubtype ?? '', ev.resultOk ? '' : ev.resultText ?? '', ...ev.errorTexts, ev.stderrTail].filter(Boolean).join('\n');

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

  if (!ev.sawResult && (ev.exitCode !== 0 || ev.signal)) {
    return make('crash', `agent exited ${ev.signal ? `on ${ev.signal}` : `with code ${ev.exitCode}`} without a result${ev.stderrTail ? `: ${firstLine(ev.stderrTail, 200)}` : ''}`);
  }
  if (!ev.resultOk) return make('unknown', `provider reported failure${ev.resultSubtype ? ` (${ev.resultSubtype})` : ''}: ${firstLine(ev.resultText ?? evidence ?? '', 200)}`);
  return make('task', 'task did not complete');
}
