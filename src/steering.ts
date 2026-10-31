import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Paths } from './paths.js';
import { ensureDir, nowIso } from './util.js';

/**
 * Hot steering: operator notes queued for a task while the run is in flight. A running CLI session
 * cannot be interrupted with new input safely, so a note is delivered at the next session boundary
 * (fresh task, continuation, nudge or repair) by prepending it to that session's prompt. The store
 * is append-only: a message record and a consume record, folded on read.
 */

export interface SteeringMessage {
  id: string;
  taskId: string;
  at: string;
  by?: string;
  note: string;
  consumedAt?: string;
}

interface MessageRecord {
  kind: 'message';
  id: string;
  taskId: string;
  at: string;
  by?: string;
  note: string;
}

interface ConsumeRecord {
  kind: 'consume';
  id: string;
  at: string;
}

type RecordLine = MessageRecord | ConsumeRecord;

export const STEERING_MAX_CHARS = 8000;

export function steeringPath(paths: Paths, taskId: string): string {
  return join(dirname(paths.state), 'steering', `${taskId}.jsonl`);
}

function readRecords(paths: Paths, taskId: string): RecordLine[] {
  const file = steeringPath(paths, taskId);
  if (!existsSync(file)) return [];
  const out: RecordLine[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RecordLine;
      if (parsed?.kind === 'message' && typeof parsed.id === 'string' && typeof parsed.note === 'string') out.push(parsed);
      else if (parsed?.kind === 'consume' && typeof parsed.id === 'string') out.push(parsed);
    } catch {
      /* a partial line from a crash is not a delivered message */
    }
  }
  return out;
}

/** Queue one operator note. Returns the stored message (truncated to a safe prompt size). */
export function appendSteering(paths: Paths, taskId: string, note: string, by?: string): SteeringMessage {
  const text = note.trim();
  if (!text) throw new Error('steering note is empty');
  const msg: MessageRecord = {
    kind: 'message',
    id: `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    at: nowIso(),
    ...(by?.trim() ? { by: by.trim() } : {}),
    note: text.length > STEERING_MAX_CHARS ? `${text.slice(0, STEERING_MAX_CHARS)}\n… (truncated)` : text,
  };
  const file = steeringPath(paths, taskId);
  ensureDir(dirname(file));
  appendFileSync(file, `${JSON.stringify(msg)}\n`);
  return { id: msg.id, taskId, at: msg.at, ...(msg.by ? { by: msg.by } : {}), note: msg.note };
}

/** Messages queued for a task that no session has consumed yet, oldest first. */
export function pendingSteering(paths: Paths, taskId: string): SteeringMessage[] {
  const records = readRecords(paths, taskId);
  const consumed = new Set<string>();
  for (const record of records) {
    if (record.kind === 'consume') consumed.add(record.id);
  }
  const messages: SteeringMessage[] = [];
  for (const record of records) {
    if (record.kind !== 'message' || consumed.has(record.id)) continue;
    messages.push({
      id: record.id,
      taskId: record.taskId,
      at: record.at,
      ...(record.by ? { by: record.by } : {}),
      note: record.note,
    });
  }
  return messages;
}

/** Mark messages delivered. Append-only, so a crash mid-write cannot lose or duplicate a note. */
export function consumeSteering(paths: Paths, taskId: string, ids: readonly string[]): void {
  if (!ids.length) return;
  const file = steeringPath(paths, taskId);
  ensureDir(dirname(file));
  const at = nowIso();
  for (const id of ids) appendFileSync(file, `${JSON.stringify({ kind: 'consume', id, at } satisfies ConsumeRecord)}\n`);
}

/** The prompt block prepended to a session. Empty string when there is no pending steering. */
export function steeringBlock(messages: readonly SteeringMessage[]): string {
  if (!messages.length) return '';
  const lines = [
    '## Operator steering (apply this now)',
    '',
    'The human operating the pipeline sent the following while this task was running. Treat it as an',
    'authoritative correction to scope, priority or approach for the work below.',
    '',
  ];
  for (const m of messages) {
    lines.push(`- ${m.at}${m.by ? ` · ${m.by}` : ''}: ${m.note.replace(/\r?\n/g, '\n  ')}`);
  }
  return `${lines.join('\n')}\n\n---\n\n`;
}
