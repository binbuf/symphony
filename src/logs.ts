import { join } from 'node:path';
import type { Paths } from './paths.js';
import type { TaskState } from './state.js';
import type { Task } from './tasks.js';
import { atomicWriteSync, ensureDir, fmtCost, fmtDateTime, fmtDuration } from './util.js';

/** One markdown file per task in the docs logs dir: `T01.md`. */
export function taskLogPath(paths: Paths, id: string): string {
  return join(paths.logsDir, `${id}.md`);
}

function bullet(label: string, value: string | undefined, fallback = '-'): string {
  return `- ${label}: ${value && value.trim() ? value.trim() : fallback}`;
}

/**
 * Write the high-level run log for one task: the harness's per-task record of every session's
 * reported status and summary, plus provider/model, timing, cost and commit. The task's start
 * stamp opens the file and its finish stamp closes it. Regenerated in full after every session so
 * it always reflects the latest state and never grows duplicates.
 */
export function writeTaskLog(paths: Paths, task: Task, st: TaskState, opts: { commitPreview?: string } = {}): void {
  const lines: string[] = [];
  lines.push(`# ${task.id} — ${task.title}`);
  lines.push('');
  lines.push(`**Started:** ${fmtDateTime(st.started)}`);
  lines.push('');
  lines.push('_Per-run log maintained by the symphony harness; regenerated after every session. Do not edit by hand._');
  lines.push('');
  lines.push(bullet('Phase', task.phase));
  lines.push(bullet('Status', st.status));
  lines.push(bullet('Provider', st.provider ? `${st.provider}${st.model ? ` · model: ${st.model}` : ''}${st.variant ? ` · variant: ${st.variant}` : ''}` : undefined));
  lines.push(bullet('Duration', fmtDuration(st.durationS || undefined)));
  lines.push(bullet('Cost', st.costUsd === undefined ? undefined : fmtCost(st.costUsd)));
  lines.push(bullet('Attempts', String(st.attempts)));
  lines.push(bullet('Commit', st.commit ?? opts.commitPreview));
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(st.summary?.trim() || '_(no summary reported)_');
  if (st.lastError) {
    lines.push('');
    lines.push('## Last error');
    lines.push('');
    lines.push(`${st.lastError.category}: ${st.lastError.message} (${st.lastError.transient ? 'transient' : 'non-transient'}${st.lastError.fatal ? ', fatal' : ''}) at ${st.lastError.at}`);
  }
  if (st.verify) {
    lines.push('');
    lines.push('## Verification');
    lines.push('');
    lines.push(`- command: \`${st.verify.command}\``);
    lines.push(`- result: ${st.verify.ok ? 'pass' : `FAIL (exit ${st.verify.code ?? 'timeout'})`} at ${st.verify.at}`);
    if (st.verify.output) { lines.push('', '```', st.verify.output, '```'); }
  }
  lines.push('');
  lines.push('## Sessions');
  lines.push('');
  if (!st.logs.length) {
    lines.push('_(no sessions recorded)_');
  } else {
    st.logs.forEach((l, i) => {
      const parts = [
        l.status,
        l.started ? `started ${l.started}` : undefined,
        l.durationS !== undefined ? fmtDuration(l.durationS) : undefined,
        l.costUsd !== undefined ? fmtCost(l.costUsd) : undefined,
      ].filter(Boolean);
      lines.push(`### ${i + 1} · ${l.kind}${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
      lines.push('');
      lines.push(`- summary: ${l.summary?.trim() || '_(none)_'}`);
      if (l.provider) lines.push(`- model: ${l.provider}${l.model ? ` · ${l.model}` : ''}${l.variant ? ` · variant ${l.variant}` : ''}`);
      lines.push(`- raw: ${l.jsonl} · log: ${l.log} · prompt: ${l.prompt}`);
      lines.push('');
    });
    if (lines[lines.length - 1] === '') lines.pop();
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**Finished:** ${fmtDateTime(st.finished)}`);
  ensureDir(paths.logsDir);
  atomicWriteSync(taskLogPath(paths, task.id), `${lines.join('\n')}\n`);
}