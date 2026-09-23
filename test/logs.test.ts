import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { taskLogPath, writeTaskLog } from '../src/logs.js';
import { resolvePaths } from '../src/paths.js';
import { newTaskState, type TaskState } from '../src/state.js';
import type { Task } from '../src/tasks.js';

const task: Task = { id: 'T01', num: 1, title: 'Do the thing', phase: 'Phase 1', order: 0, meta: {} };

test('writeTaskLog opens with the start stamp and closes with the finish stamp', () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'symphony-logs-')));
  const st: TaskState = {
    ...newTaskState(task.title),
    status: 'done',
    attempts: 1,
    started: '2026-01-02T03:04:05Z',
    finished: '2026-01-02T03:34:05Z',
    durationS: 1800,
    summary: 'all done',
    logs: [{ kind: 'task', jsonl: 'r.jsonl', log: 'r.log', prompt: 'r.prompt.md', status: 'done', started: '2026-01-02T03:04:05Z', summary: 'all done' }],
  };
  writeTaskLog(paths, task, st, { timeZone: 'utc' });
  const lines = readFileSync(taskLogPath(paths, 'T01'), 'utf8').trimEnd().split('\n');
  assert.equal(lines[0], '# T01 — Do the thing');
  assert.equal(lines[2], '**Started:** 2026-01-02 03:04:05Z');
  assert.equal(lines.at(-1), '**Finished:** 2026-01-02 03:34:05Z');
  // The stamps live only at the top and bottom, not duplicated in the metadata bullets.
  assert.equal(lines.filter((l) => l.startsWith('**Started:**')).length, 1);
  assert.equal(lines.filter((l) => l.startsWith('**Finished:**')).length, 1);
  assert.match(lines.join('\n'), /## Sessions/);
});

test('writeTaskLog falls back to "-" when a stamp is missing', () => {
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'symphony-logs-')));
  const st: TaskState = { ...newTaskState(task.title), status: 'pending' };
  writeTaskLog(paths, task, st);
  const text = readFileSync(taskLogPath(paths, 'T01'), 'utf8');
  assert.match(text, /^\*\*Started:\*\* -$/m);
  assert.match(text, /^\*\*Finished:\*\* -$/m);
});
