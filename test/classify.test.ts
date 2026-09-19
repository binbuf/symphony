import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFailure, type FailureEvidence } from '../src/classify.js';

const FATAL = ['auth', 'billing', 'usage_limit', 'model', 'config'];
const base: FailureEvidence = {
  apiErrorCategories: [], errorTexts: [], resultOk: false, sawResult: true, exitCode: 1, signal: null,
  stderrTail: '', timedOut: false, stalled: false, interrupted: false,
};

test('spawn ENOENT → config, fatal', () => {
  const c = classifyFailure({ ...base, spawnError: 'spawn claude ENOENT', sawResult: false }, FATAL);
  assert.equal(c.category, 'config'); assert.equal(c.fatal, true); assert.equal(c.transient, false);
});

test('structured claude billing_error → billing, fatal', () => {
  const c = classifyFailure({ ...base, apiErrorCategories: ['rate_limit', 'billing_error'], resultText: 'API error' }, FATAL);
  assert.equal(c.category, 'billing'); assert.equal(c.fatal, true);
});

test('text: credit balance too low → billing', () => {
  const c = classifyFailure({ ...base, resultText: 'Credit balance is too low to run this request.' }, FATAL);
  assert.equal(c.category, 'billing'); assert.equal(c.fatal, true);
});

test('text: not logged in → auth', () => {
  const c = classifyFailure({ ...base, stderrTail: 'Error: Not logged in. Please run /login', sawResult: false }, FATAL);
  assert.equal(c.category, 'auth'); assert.equal(c.fatal, true);
});

test('rate limit → transient, not fatal', () => {
  const c = classifyFailure({ ...base, apiErrorCategories: ['rate_limit'], resultText: '429 rate limited' }, FATAL);
  assert.equal(c.category, 'rate_limit'); assert.equal(c.transient, true); assert.equal(c.fatal, false);
});

test('network reset → transient', () => {
  const c = classifyFailure({ ...base, stderrTail: 'FetchError: read ECONNRESET', sawResult: false }, FATAL);
  assert.equal(c.category, 'network'); assert.equal(c.transient, true);
});

test('non-zero exit without result and no other clue → crash, transient', () => {
  const c = classifyFailure({ ...base, sawResult: false, exitCode: 137 }, FATAL);
  assert.equal(c.category, 'crash'); assert.equal(c.transient, true);
});

test('timeout and stall', () => {
  assert.equal(classifyFailure({ ...base, timedOut: true }, FATAL).transient, false);
  const s = classifyFailure({ ...base, stalled: true }, FATAL);
  assert.equal(s.category, 'stall'); assert.equal(s.transient, true);
});

test('budget and max turns are terminal but not fatal', () => {
  assert.equal(classifyFailure({ ...base, resultSubtype: 'error_max_budget_usd' }, FATAL).category, 'budget');
  assert.equal(classifyFailure({ ...base, resultSubtype: 'error_max_turns' }, FATAL).category, 'max_turns');
});

test('ok result without a block → task', () => {
  const c = classifyFailure({ ...base, resultOk: true, exitCode: 0 }, FATAL);
  assert.equal(c.category, 'task'); assert.equal(c.fatal, false); assert.equal(c.transient, false);
});

test('halt categories are configurable', () => {
  const c = classifyFailure({ ...base, resultText: 'Credit balance is too low' }, ['auth']);
  assert.equal(c.category, 'billing'); assert.equal(c.fatal, false);
});
