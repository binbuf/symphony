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

test('"rate limit reached" text is a transient rate limit, not a fatal usage limit', () => {
  const c = classifyFailure({ ...base, resultText: 'Rate limit reached. Please retry in a moment.' }, FATAL);
  assert.equal(c.category, 'rate_limit');
  assert.equal(c.fatal, false);
  assert.equal(c.transient, true);
});

test('a subscription usage limit is still fatal', () => {
  const c = classifyFailure({ ...base, resultText: 'You have hit your limit. Resets at 3pm.' }, FATAL);
  assert.equal(c.category, 'usage_limit');
  assert.equal(c.fatal, true);
});

test('"please run <command>" is not mistaken for an auth failure', () => {
  const c = classifyFailure({ ...base, stderrTail: 'Please run `npm install` before building', sawResult: false }, FATAL);
  assert.notEqual(c.category, 'auth');
  assert.equal(c.fatal, false);
  const login = classifyFailure({ ...base, stderrTail: 'Not logged in. Please run /login', sawResult: false }, FATAL);
  assert.equal(login.category, 'auth');
});

test('network reset → transient', () => {
  const c = classifyFailure({ ...base, stderrTail: 'FetchError: read ECONNRESET', sawResult: false }, FATAL);
  assert.equal(c.category, 'network'); assert.equal(c.transient, true);
});

test('a dropped MCP/plugin/tool session is a transient network fault, not a task failure', () => {
  const examples = [
    'get_test_job failed: Unity plugin session 7f3c9 dropped',
    'MCP server connection closed unexpectedly',
    'tool session 12 timed out while running the suite',
    'The plugin session was terminated by the host',
  ];
  for (const text of examples) {
    const c = classifyFailure({ ...base, resultText: text }, FATAL);
    assert.equal(c.category, 'network', text);
    assert.equal(c.transient, true, text);
    assert.equal(c.fatal, false, text);
  }
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

test('a numeric HTTP status classifies even when the wording is unknown', () => {
  const r = classifyFailure({ ...base, httpStatus: 429, resultText: 'Provider returned an error.' }, FATAL);
  assert.equal(r.category, 'rate_limit'); assert.equal(r.transient, true);
  const s = classifyFailure({ ...base, httpStatus: 503, resultText: 'Provider returned an error.' }, FATAL);
  assert.equal(s.category, 'server'); assert.equal(s.transient, true);
  // 408 is mapped by status alone: no RULES pattern names it.
  const n = classifyFailure({ ...base, httpStatus: 408, resultText: 'Provider returned an error.' }, FATAL);
  assert.equal(n.category, 'network'); assert.equal(n.transient, true);
});

test('an unrecognised 4xx stays terminal (a request problem is not transient)', () => {
  const c = classifyFailure({ ...base, httpStatus: 404, resultText: 'Provider returned an error.' }, FATAL);
  assert.equal(c.category, 'unknown'); assert.equal(c.transient, false); assert.equal(c.fatal, false);
});

test('a provider-flagged retryable or a bare error event is transient without a status', () => {
  const retryable = classifyFailure({ ...base, retryable: true, errorTexts: ['upstream returned a weird blob'] }, FATAL);
  assert.equal(retryable.category, 'server'); assert.equal(retryable.transient, true);
  const sawError = classifyFailure({ ...base, sawError: true, errorTexts: ['upstream returned a weird blob'] }, FATAL);
  assert.equal(sawError.category, 'server'); assert.equal(sawError.transient, true);
});

test('broadened throttling wording and Retry-After are recognised', () => {
  for (const text of ['The request was throttled.', 'Too many requests.', 'HTTP 429', 'try again; retry-after: 30']) {
    const c = classifyFailure({ ...base, resultText: text }, FATAL);
    assert.equal(c.category, 'rate_limit', text);
    assert.equal(c.transient, true, text);
  }
  const c = classifyFailure({ ...base, httpStatus: 429, retryAfterSec: 42 }, FATAL);
  assert.equal(c.retryAfterSec, 42);
});
