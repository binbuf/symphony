import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveJudge, type Config } from './config.js';
import { git, untrackedFiles } from './git.js';
import { openRunSinks, type Logger } from './logger.js';
import { planMcp } from './mcp.js';
import type { Paths } from './paths.js';
import { getProvider, variantSupported } from './providers/index.js';
import { startSession } from './session.js';
import { renderPrompt } from './templates.js';
import { headAndTail, headAndTailBytes, squash, stamp } from './util.js';

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
}

export interface JudgeDeps {
  paths?: Paths;
  log?: Logger;
  abort?: AbortSignal;
}

const JUDGE_RE = /SYMPHONY_JUDGE[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*END_SYMPHONY_JUDGE/i;

/**
 * Read the verdict out of a judge session's final text: the `SYMPHONY_JUDGE` block when present,
 * otherwise a bare `verdict:` line, so a model that ignores the framing still counts. Returns
 * undefined when there is no usable verdict.
 */
export function parseJudgeAnswer(text: string): { verdict: JudgeVerdictKind; confidence?: number; summary: string; gaps?: string } | undefined {
  const block = JUDGE_RE.exec(text);
  const body = block ? block[1] : text;
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

/** The self-contained judge prompt, rendered from the template. */
export function buildJudgePrompt(ev: JudgeEvidence): string {
  const acceptance = ev.acceptance?.length
    ? ev.acceptance.map((a) => `- [${a.checked ? 'x' : ' '}] ${a.text}${a.blocking ? '' : ' [deferrable]'}`).join('\n')
    : '- (the task file declares no acceptance checkboxes)';

  const verify: string[] = [];
  if (ev.verifyCommand) {
    verify.push(`- command: \`${ev.verifyCommand}\``);
    verify.push(`- result: ${ev.verifyOk ? 'passed' : 'failed or not run'}`);
    if (ev.verifyOutput) { verify.push('', '```', headAndTail(ev.verifyOutput, 4000), '```'); }
  } else {
    verify.push('- (no verify command is configured; the judge is the only independent check)');
  }

  const diff: string[] = [];
  if (ev.changedFiles?.length) {
    diff.push(`- changed files (${ev.changedFiles.length}):`, ...ev.changedFiles.slice(0, 60).map((f) => `  - ${f}`));
    if (ev.changedFiles.length > 60) diff.push(`  - … and ${ev.changedFiles.length - 60} more`);
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
    taskBody: ev.taskBody?.trim() ? headAndTail(ev.taskBody, 12_000) : '(no task file — the roadmap bullet is the whole task)',
    acceptance,
    verifySection: verify.join('\n'),
    diffSection: diff.join('\n'),
    sessionSummary: ev.sessionSummary?.trim() ? squash(ev.sessionSummary, 1500) : '(no summary reported)',
    progressNote: ev.progressNote?.trim() ? headAndTail(ev.progressNote, 4000) : '(no progress note written)',
  });
}

/**
 * Snapshot the uncommitted worktree as evidence: the changed-file list plus a diff against HEAD.
 * Untracked files (agent-created sources) are not in `git diff`, so they are named so the read-only
 * judge can open them directly. Never throws.
 */
export function collectChanges(root: string, maxBytes: number): { files: string[]; diff: string; truncated: boolean } {
  try {
    const status = git(root, ['status', '--porcelain']);
    const files = status.code === 0 && status.stdout ? status.stdout.split('\n').filter(Boolean).map((l) => l.replace(/\\/g, '/')) : [];
    const d = git(root, ['diff', '--no-color', 'HEAD']);
    let diff = d.code === 0 ? d.stdout : '';
    const untracked = untrackedFiles(root);
    if (untracked.length) diff += `${diff ? '\n' : ''}\n# untracked files (not shown in the diff; read them directly):\n${untracked.map((f) => `#   ${f}`).join('\n')}\n`;
    const truncated = Buffer.byteLength(diff, 'utf8') > maxBytes;
    if (truncated) diff = headAndTailBytes(diff, maxBytes);
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
  try {
    const { spec, warnings } = resolveJudge(config, variantSupported);
    warnings.forEach((w) => log?.warn(`judge: ${w}`));
    log?.info(`${ev.taskId}: judging the completion with ${spec.providerName}${spec.model ? ` · ${spec.model}` : ''} · timeout ${config.judge.timeoutMin} min`);
    const provider = getProvider(spec.providerName);
    const sinks = openRunSinks(paths.runs, `judge-${ev.taskId}-${stamp()}`);
    const prompt = buildJudgePrompt(ev);
    writeFileSync(sinks.promptPath, prompt);
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
      await sinks.close();
    }
    const answer = parseJudgeAnswer(outcome.result.text || outcome.allText);
    if (!answer) {
      const why = outcome.spawnError ?? outcome.result.errorSubtype ?? (outcome.timedOut ? 'timeout' : outcome.stalled ? 'stalled' : 'no verdict block');
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
  }
}