import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResultBlock } from '../src/result.js';

test('last valid block wins; echoed template is ignored', () => {
  const text = `Here is what I will do.

SYMPHONY_RESULT
status: <exactly one word: done, blocked, or failed>
summary: <one line>
END_SYMPHONY_RESULT

...work...

SYMPHONY_RESULT
status: Done
summary: Added the endpoint and tests
END_SYMPHONY_RESULT
`;
  assert.deepEqual(parseResultBlock(text), { status: 'done', summary: 'Added the endpoint and tests' });
});

test('missing or malformed block → undefined', () => {
  assert.equal(parseResultBlock(undefined), undefined);
  assert.equal(parseResultBlock('no block here'), undefined);
  assert.equal(parseResultBlock('SYMPHONY_RESULT\nstatus: maybe\nEND_SYMPHONY_RESULT'), undefined);
});

test('blocked with empty summary', () => {
  assert.deepEqual(parseResultBlock('SYMPHONY_RESULT\nstatus: blocked\nEND_SYMPHONY_RESULT'), { status: 'blocked', summary: '' });
});

test('continue is a valid reported status', () => {
  assert.deepEqual(parseResultBlock('SYMPHONY_RESULT\nstatus: continue\nsummary: half done\nEND_SYMPHONY_RESULT'), { status: 'continue', summary: 'half done' });
});
