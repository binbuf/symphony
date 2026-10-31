import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, type Config } from '../src/config.js';
import { evaluateJev, formatJevEvaluation, jevRecordsPath, readJevRecords, recordJevDecision, recordJevOutcome } from '../src/jev-eval.js';
import { resolvePaths } from '../src/paths.js';

const config = (evaluate = true): Config => ({
  ...DEFAULTS,
  jev: { ...DEFAULTS.jev, enabled: true, evaluate },
});

function paths(): ReturnType<typeof resolvePaths> {
  return resolvePaths(mkdtempSync(join(tmpdir(), 'symphony-jev-eval-')));
}

test('Jev decisions and outcomes are recorded only when evaluation is enabled', () => {
  const p = paths();
  recordJevDecision(p, config(false), { workflow: 'session', taskId: 'T01', decision: 'done', confidence: 0.9 });
  recordJevOutcome(p, config(false), { taskId: 'T01', status: 'done', success: true });
  assert.equal(existsSync(jevRecordsPath(p)), false);

  recordJevDecision(p, config(), { workflow: 'session', taskId: 'T01', decision: 'done', confidence: 0.9, costUsd: 0.001 });
  recordJevOutcome(p, config(), { taskId: 'T01', status: 'done', success: true, attempts: 1 });
  const records = readJevRecords(p);
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, 'decision');
  assert.equal(records[1].kind, 'outcome');
  assert.ok(readFileSync(jevRecordsPath(p), 'utf8').includes('"workflow":"session"'));
});

test('evaluation pairs each decision with the next outcome and reports success by workflow', () => {
  const p = paths();
  const c = config();
  recordJevDecision(p, c, { workflow: 'session', taskId: 'T01', decision: 'done', confidence: 0.9, costUsd: 0.001 });
  recordJevOutcome(p, c, { taskId: 'T01', status: 'done', success: true });
  recordJevDecision(p, c, { workflow: 'escalation', taskId: 'T02', decision: 'escalate', confidence: 0.6, costUsd: 0.002 });
  recordJevOutcome(p, c, { taskId: 'T02', status: 'failed', success: false });
  recordJevDecision(p, c, { workflow: 'breakdown', taskId: 'T03', decision: 'split', confidence: 0.8, costUsd: 0.003 });
  // T03 has no outcome yet: it must stay unpaired rather than counting as a failure.

  const evaluation = evaluateJev(readJevRecords(p));
  assert.equal(evaluation.decisions, 3);
  assert.equal(evaluation.outcomes, 2);
  assert.equal(evaluation.evaluated, 2);
  assert.equal(evaluation.successes, 1);
  assert.equal(evaluation.successRate, 0.5);
  assert.equal(evaluation.unpaired, 1);
  assert.equal(evaluation.costUsd, 0.006);

  const session = evaluation.byWorkflow.find((w) => w.workflow === 'session')!;
  assert.equal(session.decisions, 1);
  assert.equal(session.evaluated, 1);
  assert.equal(session.successRate, 1);
  assert.equal(session.avgConfidence, 0.9);
  const escalation = evaluation.byWorkflow.find((w) => w.workflow === 'escalation')!;
  assert.equal(escalation.successRate, 0);

  const bucket09 = evaluation.calibration.find((b) => b.label === '0.9–1.0')!;
  assert.equal(bucket09.n, 1);
  assert.equal(bucket09.rate, 1);
  const bucket06 = evaluation.calibration.find((b) => b.label === '0.6–0.7')!;
  assert.equal(bucket06.n, 1);
  assert.equal(bucket06.rate, 0);

  const lines = formatJevEvaluation(evaluation);
  assert.match(lines[0], /3 decisions/);
  assert.ok(lines.some((l) => /session/.test(l) && /100%/.test(l)));
  assert.ok(lines.some((l) => /confidence calibration/.test(l)));
});

test('a later outcome re-evaluates a later decision, not the one already paired', () => {
  const p = paths();
  const c = config();
  recordJevDecision(p, c, { workflow: 'escalation', taskId: 'T01', decision: 'decline', confidence: 0.9 });
  recordJevOutcome(p, c, { taskId: 'T01', status: 'failed', success: false });
  recordJevDecision(p, c, { workflow: 'escalation', taskId: 'T01', decision: 'escalate', confidence: 0.8 });
  recordJevOutcome(p, c, { taskId: 'T01', status: 'done', success: true });

  const evaluation = evaluateJev(readJevRecords(p));
  const escalation = evaluation.byWorkflow.find((w) => w.workflow === 'escalation')!;
  assert.equal(escalation.decisions, 2);
  assert.equal(escalation.evaluated, 2);
  assert.equal(escalation.successes, 1);
  assert.equal(escalation.successRate, 0.5);
});
