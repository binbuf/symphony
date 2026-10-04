import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveJudge, type Config } from './config.js';
import { git, untrackedFiles } from './git.js';
import { openRunSinks, type Logger, type RunSinks } from './logger.js';
import { planMcp } from './mcp.js';
import type { Paths } from './paths.js';
import { getProvider, variantSupported } from './providers/index.js';
import { startSession } from './session.js';
import type { LogRef } from './state.js';
import { renderPrompt } from './templates.js';
import { headAndTailBytes, nowIso, squash, stamp } from './util.js';

/**
 * The independent completion judge. After a task reports `done` and its verify command passes, a
 * separate read-only LLM session reviews the task's intent (Goal / Scope / acceptance items) against
 * what actually landed (the worktree diff) and returns pass/fail. This is the check a test command
 * cannot make: whether the task was completed *as intended*, not merely green on its own tests. The
 * judge never edits the tree; the runner decides what a failing verdict does (`judge.onFail`).
 */

export type JudgeVerdictKind = 'pass' | 'fail';

/** Everything the judge sees. Gathered by the runner (or a test) so the session needs no tools. */
export interface JudgeEvidence {
  taskId: string;
  taskTitle: string;
  taskPhase: string;
  status: string;
  attempts: number;
  /** The task file body (Goal / Context / Scope / Done when / Hand-off), already capped by the caller. */
  taskBody?: string;
  /** The task's own acceptance items and whether each landed. */
  acceptance?: { text: string; checked: boolean; blocking: boolean }[];
  verifyCommand?: string;
  verifyOk?: boolean;
  verifyOutput?: string;
  /** The final session's reported summary. */
  sessionSummary?: string;
  /** Files touched by this task's uncommitted work, for the "what landed" section. */
  changedFiles?: string[];
  /** Of `changedFiles`, the ones that are symphony bookkeeping (ROADMAP/PROGRESS/logs), not task work. */
  harnessFiles?: string[];
  /** The worktree diff against HEAD. */
  diff?: string;
  diffTruncated?: boolean;
  /** Tail of the task's own progress note. */
  progressNote?: string;
}

export interface JudgeVerdict {
  verdict: JudgeVerdictKind;
  ok: boolean;
  confidence?: number;
  summary: string;
  gaps?: string;
  costUsd?: number;
  /** Provider/model that ran the judge, for the task log. */
  provider?: string;
  model?: string;
  /**
   * Whether a failing verdict should be enforced (demote the `done`). Set by the runner after any
   * `judge.jev` cross-check, so the caller does not have to re-derive it. Undefined when not applied.
   */
  enforce?: boolean;
  /** The independent Jev cross-check, when `judge.jev` ran before an enforceable rejection. */
  jev?: JudgeJevCheck;
}

/** One independent Jev review of a rejection the judge is about to enforce. */
export interface JudgeJevCheck {
  verdict: JudgeVerdictKind;
  confidence?: number;
  /**
   * True when Jev reached a usable opinion (a parsed verdict at or above `jev.minConfidence`).
   * A decisive `fail` agrees with the rejection; a decisive `pass` disagrees. When not decisive
   * — no answer, unavailable, or below the confidence bar — the judge's own decision stands.
   */
  decisive: boolean;
  /** True when Jev agrees the completion should be rejected; only then is the rejection enforced. */
  agreed: boolean;
  summary?: string;
  model?: string;
  costUsd?: number;
}

export interface JudgeDeps {
  paths?: Paths;
  log?: Logger;
  abort?: AbortSignal;
  /**
   * Receives a log reference for the judge session the moment it starts (relative paths, provider/
   * model, status `running`) so the caller can show the judge step while it is in flight. The same
   * object is later handed to `onLog` with the outcome filled in.
   */
  onStart?: (ref: Omit<LogRef, 'kind'>) => void;
  /** Receives the same log reference once the session ends, with its status, cost and summary set. */
  onLog?: (ref: Omit<LogRef, 'kind'>) => void;
}

const JUDGE_RE = /SYMPHONY_JUDGE[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*END_SYMPHONY_JUDGE/i;

type ParsedJudge = { verdict: JudgeVerdictKind; confidence?: number; summary: string; gaps?: string };

/** Read the verdict fields from one block of text, or undefined when it carries no usable verdict. */
function readJudgeFields(body: string): ParsedJudge | undefined {
  const verdict = /^[ \t]*verdict[ \t]*:[ \t]*([A-Za-z]+)/im.exec(body);
  if (!verdict) return undefined;
  const word = verdict[1].toLowerCase();
  const kind: JudgeVerdictKind | undefined = word === 'pass' || word === 'passed' ? 'pass' : word === 'fail' || word === 'failed' ? 'fail' : undefined;
  if (!kind) return undefined;
  const confidenceRaw = /^[ \t]*confidence[ \t]*:[ \t]*([0-9]*\.?[0-9]+)/im.exec(body);
  let confidence = confidenceRaw ? Number(confidenceRaw[1]) : undefined;
  if (confidence !== undefined && (confidence < 0 || confidence > 1 || !Number.isFinite(confidence))) confidence = undefined;
  const summary = /^[ \t]*summary[ \t]*:[ \t]*(.+)$/im.exec(body);
  const gaps = /^[ \t]*gaps[ \t]*:[ \t]*(.+)$/im.exec(body);
  return {
    verdict: kind,
    confidence,
    summary: summary ? squash(summary[1], 300) : kind === 'pass' ? 'judge passed the completion' : 'judge rejected the completion',
    gaps: gaps ? squash(gaps[1], 400) : undefined,
  };
}

/**
 * Read the verdict out of a judge session's final text: the `SYMPHONY_JUDGE` block when present,
 * otherwise a bare `verdict:` line, so a model that ignores the framing still counts. A block that
 * carries no usable `verdict:` line (a malformed marker, a verdict written just outside it) falls
 * back to scanning the whole reply rather than discarding an otherwise good verdict. Returns
 * undefined only when neither the block nor the reply names a pass/fail verdict.
 */
export function parseJudgeAnswer(text: string): ParsedJudge | undefined {
  const block = JUDGE_RE.exec(text);
  if (block) {
    const parsed = readJudgeFields(block[1]);
    if (parsed) return parsed;
  }
  // Fallback: a bare `verdict:` line, read from the *last* one in the reply. Scanning from the front
  // would let an echoed example, a quoted task body, or a restated prompt pick the verdict; the
  // model's actual conclusion sits at the end. Fields are read from that line onward so the parsed
  // confidence/summary/gaps belong to the same verdict.
  const verdictLines = /^[ \t]*verdict[ \t]*:/gim;
  let at = -1;
  for (let m = verdictLines.exec(text); m; m = verdictLines.exec(text)) at = m.index;
  if (at === -1) return undefined;
  return readJudgeFields(text.slice(at));
}

/** The self-contained judge prompt, rendered from the template. */
export function buildJudgePrompt(ev: JudgeEvidence): string {
  const acceptance = ev.acceptance?.length
    ? ev.acceptance.map((a) => `- [${a.checked ? 'x' : ' '}] ${a.text}${a.blocking ? '' : ' [deferrable]'}`).join('\n')
    : '- (the task file declares no acceptance checkboxes)';

  const verify: string[] = [];
  if (ev.verifyCommand) {
    verify.push(`- command: \`${ev.verifyCommand}\``);
    verify.push(`- result: ${ev.verifyOk ? 'passed' : 'failed or not run'}`);
    if (ev.verifyOutput) { verify.push('', '```', headAndTailBytes(ev.verifyOutput, 4000), '```'); }
  } else {
    verify.push('- (no verify command is configured; the judge is the only independent check)');
  }

  const diff: string[] = [];
  if (ev.changedFiles?.length) {
    const harness = new Set(ev.harnessFiles ?? []);
    diff.push(`- changed files (${ev.changedFiles.length}):`, ...ev.changedFiles.slice(0, 60).map((f) => `  - ${f}${harness.has(f) ? ' [harness]' : ''}`));
    if (ev.changedFiles.length > 60) diff.push(`  - … and ${ev.changedFiles.length - 60} more`);
    if (harness.size) diff.push('', '- files marked `[harness]` are symphony bookkeeping (the ROADMAP status block, progress notes, run logs); any hunks touching them are harness state, not evidence of the task\'s scope — ignore them when deciding.');
    diff.push('');
  }
  if (ev.diff?.trim()) {
    diff.push('```diff', ev.diff.trim(), '```');
    if (ev.diffTruncated) diff.push('_(diff truncated; read the changed files directly for the rest)_');
  } else {
    diff.push('_(no diff captured; read the changed files directly if needed)_');
  }

  return renderPrompt('judge.md', {
    taskId: ev.taskId,
    taskTitle: ev.taskTitle,
    taskPhase: ev.taskPhase,
    status: ev.status,
    attempts: ev.attempts,
    taskBody: ev.taskBody?.trim() ? headAndTailBytes(ev.taskBody, 12_000) : '(no task file — the roadmap bullet is the whole task)',
    acceptance,
    verifySection: verify.join('\n'),
    diffSection: diff.join('\n'),
    sessionSummary: ev.sessionSummary?.trim() ? squash(ev.sessionSummary, 1500) : '(no summary reported)',
    progressNote: ev.progressNote?.trim() ? headAndTailBytes(ev.progressNote, 4000) : '(no progress note written)',
  });
}

/**
 * Parse one `git status --porcelain` line into its status code and file path. The two-char code and
 * the single separating space are dropped, and a rename/copy arrow (`old -> new`) collapses to the
 * destination path, so the evidence lists a clean path rather than `" M src/x.ts"`.
 */
function porcelainPath(line: string): string {
  // `git()` trims stdout, so the very first line may have lost its leading status space. Match an
  // optional one-or-two-char status and the separating whitespace, then keep the path that follows.
  const m = /^\s*[ MADRCU?!]{1,2}\s+(.*)$/.exec(line);
  let rest = m ? m[1] : line;
  const arrow = rest.lastIndexOf(' -> ');
  if (arrow !== -1) rest = rest.slice(arrow + 4);
  return rest.trim().replace(/\\/g, '/');
}

/**
 * Truncate a diff to a byte budget without cutting through a file: whole `diff --git` chunks are kept
 * while they fit, the first over-budget file is byte-truncated, and the remaining files are replaced
 * by a short "omitted" note (the read-only judge can open them directly). Never exceeds `maxBytes`.
 */
function truncateDiffFiles(diff: string, maxBytes: number): string {
  const chunks = diff.split(/(?=^diff --git )/m).filter((c) => c.length > 0);
  if (chunks.length <= 1) return headAndTailBytes(diff, maxBytes);
  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  const reserve = 96;
  for (let i = 0; i < chunks.length; i++) {
    const size = Buffer.byteLength(chunks[i], 'utf8');
    if (used + size <= maxBytes - reserve) { parts.push(chunks[i]); used += size; }
    else { omitted = chunks.length - i; break; }
  }
  if (!parts.length) return headAndTailBytes(diff, maxBytes);
  const text = parts.join('');
  const note = `\n# … ${omitted} file${omitted === 1 ? '' : 's'} omitted (diff exceeded judge.maxDiffBytes); read them directly.\n`;
  if (Buffer.byteLength(text + note, 'utf8') > maxBytes) return headAndTailBytes(text, maxBytes);
  return text + note;
}

/**
 * Snapshot the uncommitted worktree as evidence: the changed-file list plus a diff against HEAD.
 * Untracked files (agent-created sources) are not in `git diff`, so they are named so the read-only
 * judge can open them directly. The file list is always gathered; `includeDiff: false` only skips
 * the (potentially large) diff body, leaving the judge the names it needs to read files directly.
 * Never throws.
 */
export function collectChanges(root: string, maxBytes: number, includeDiff = true): { files: string[]; diff: string; truncated: boolean } {
  try {
    const status = git(root, ['status', '--porcelain']);
    const files = status.code === 0 && status.stdout
      ? [...new Set(status.stdout.split('\n').filter(Boolean).map((l) => porcelainPath(l)).filter(Boolean))]
      : [];
    if (!includeDiff) return { files, diff: '', truncated: false };
    const d = git(root, ['diff', '--no-color', 'HEAD']);
    const raw = d.code === 0 ? d.stdout : '';
    const untracked = untrackedFiles(root);
    const note = untracked.length ? `\n# untracked files (not shown in the diff; read them directly):\n${untracked.map((f) => `#   ${f}`).join('\n')}\n` : '';
    let diff = raw;
    let truncated = Buffer.byteLength(raw + note, 'utf8') > maxBytes;
    if (truncated) diff = truncateDiffFiles(raw, Math.max(0, maxBytes - Buffer.byteLength(note, 'utf8')));
    diff += note;
    if (Buffer.byteLength(diff, 'utf8') > maxBytes) { diff = headAndTailBytes(diff, maxBytes); truncated = true; }
    return { files, diff, truncated };
  } catch {
    return { files: [], diff: '', truncated: false };
  }
}

/**
 * Run one read-only judge session and read its verdict. Never throws: any problem (missing binary,
 * timeout, no usable block) returns undefined, so the caller accepts the `done` as reported rather
 * than failing a task on the judge's own infrastructure.
 */
export async function runJudge(config: Config, ev: JudgeEvidence, deps: JudgeDeps = {}): Promise<JudgeVerdict | undefined> {
  const { paths, log, abort } = deps;
  if (!paths) return undefined;
  let sinks: RunSinks | undefined;
  try {
    const { spec, warnings } = resolveJudge(config, variantSupported);
    warnings.forEach((w) => log?.warn(`judge: ${w}`));
    log?.info(`${ev.taskId}: judging the completion with ${spec.providerName}${spec.model ? ` · ${spec.model}` : ''} · timeout ${config.judge.timeoutMin} min`);
    const started = nowIso();
    const provider = getProvider(spec.providerName);
    sinks = openRunSinks(paths.runs, `judge-${ev.taskId}-${stamp()}`);
    const prompt = buildJudgePrompt(ev);
    writeFileSync(sinks.promptPath, prompt);
    // Announce the run immediately so the caller can render it as an in-flight step; the same ref is
    // completed below, whether or not a verdict parses.
    const ref: Omit<LogRef, 'kind'> = {
      jsonl: relative(paths.root, sinks.jsonlPath),
      log: relative(paths.root, sinks.logPath),
      prompt: relative(paths.root, sinks.promptPath),
      started,
      status: 'running',
      provider: spec.providerName,
      model: spec.model,
      variant: spec.variant,
    };
    deps.onStart?.(ref);
    const mcp = planMcp(config, 'judge', undefined, {}, provider.name, join(paths.runs, sinks.base), (m) => log?.warn(`${ev.taskId}: mcp: ${m}`));
    mcp?.notes.forEach((n) => log?.warn(`${ev.taskId}: mcp: ${n}`));
    const cmd = provider.buildCommand({
      bin: spec.bin, prompt, promptFile: sinks.promptPath, taskId: `judge-${ev.taskId}`, attempt: 1, kind: 'judge',
      model: spec.model, variant: spec.variant, autoApprove: false, readOnly: true, extraArgs: [...spec.extraArgs, ...(mcp?.args ?? [])], cwd: paths.root,
    });
    if (mcp?.env) cmd.env = { ...(cmd.env ?? {}), ...mcp.env };
    log?.info(`${ev.taskId}: ${cmd.bin} ${cmd.args.join(' ')}`.slice(0, 400));
    const session = startSession({
      spec: cmd, provider, cwd: paths.root,
      timeoutMs: spec.timeoutMin * 60_000,
      idleTimeoutMs: spec.idleTimeoutMin ? spec.idleTimeoutMin * 60_000 : 0,
      sinks, liveMaxChars: 200, logMaxChars: 4000, color: false, live: false,
    });
    // An interrupted run (Ctrl-C, TUI quit, split) must not wait out the judge's whole timeout: kill
    // the child as soon as the run's abort signal fires, then let the parse below accept the done.
    const onAbort = () => session.kill('interrupt');
    if (abort) {
      if (abort.aborted) session.kill('interrupt');
      else abort.addEventListener('abort', onAbort, { once: true });
    }
    let outcome;
    try {
      outcome = await session.done;
    } finally {
      abort?.removeEventListener('abort', onAbort);
    }
    const answer = parseJudgeAnswer(outcome.result.text || outcome.allText);
    const why = outcome.spawnError ?? outcome.result.errorSubtype ?? (outcome.timedOut ? 'timeout' : outcome.stalled ? 'stalled' : 'no verdict block');
    // Complete the run's log reference (the TUI, the task log and ROADMAP.md track every judge
    // session, including ones that end without a verdict).
    ref.durationS = Math.round(outcome.durationMs / 1000);
    ref.costUsd = outcome.costUsd;
    ref.usage = outcome.usage;
    ref.status = answer ? `${answer.verdict}${answer.confidence !== undefined ? ` ${Math.round(answer.confidence * 100)}%` : ''}` : why;
    ref.summary = answer ? `${answer.summary}${answer.gaps ? ` — gaps: ${answer.gaps}` : ''}` : `judge session ended without a usable verdict (${why})`;
    deps.onLog?.(ref);
    if (!answer) {
      log?.warn(`${ev.taskId}: judge returned no usable verdict (${why}); accepting the done as reported`);
      return undefined;
    }
    return {
      verdict: answer.verdict,
      ok: answer.verdict === 'pass',
      confidence: answer.confidence,
      summary: answer.summary,
      gaps: answer.gaps,
      costUsd: outcome.costUsd,
      provider: spec.providerName,
      model: spec.model,
    };
  } catch (e) {
    log?.warn(`${ev.taskId}: judge failed (${(e as Error).message}); accepting the done as reported`);
    return undefined;
  } finally {
    // Close the session files on every path, including a throw while building the command or spawning
    // (before `session.done` exists), so a misbehaving provider cannot leak a file handle per attempt.
    await sinks?.close().catch(() => {});
  }
}