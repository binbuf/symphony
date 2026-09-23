import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { resolveExecutable } from '../src/util.js';
import { fmtDateTime, fmtTime, parseTimeZone, squash, squashTail } from '../src/util.js';

test('fmtTime: a zero-padded local clock time, not a date', () => {
  assert.equal(fmtTime(new Date(2026, 0, 2, 3, 4, 5)), '03:04:05');
  assert.match(fmtTime(), /^\d{2}:\d{2}:\d{2}$/);
});

test('parseTimeZone recognises local, utc and fixed offsets', () => {
  assert.equal(parseTimeZone('local'), 'local');
  assert.equal(parseTimeZone('UTC'), 'utc');
  assert.equal(parseTimeZone('+05:30'), 330);
  assert.equal(parseTimeZone('-8'), -480);
  assert.equal(parseTimeZone('+0530'), 330);
  assert.equal(parseTimeZone('nonsense'), undefined);
  assert.equal(parseTimeZone('+25:00'), undefined);
  assert.equal(parseTimeZone(42), undefined);
});

test('fmtDateTime defaults to a local stamp, honours utc and fixed offsets', () => {
  const iso = '2026-01-02T03:04:05Z';
  assert.equal(fmtDateTime(iso, 'utc'), '2026-01-02 03:04:05Z');
  // A fixed offset shifts the instant and labels itself; +05:30 turns 03:04 into 08:34.
  assert.equal(fmtDateTime(iso, 330), '2026-01-02 08:34:05+05:30');
  assert.equal(fmtDateTime(iso, -480), '2026-01-01 19:04:05-08:00');
  // The default local stamp carries a numeric offset and matches the machine's own date fields.
  const local = fmtDateTime(iso);
  assert.match(local, /^2026-01-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(fmtDateTime(undefined, 'utc'), '-');
  assert.equal(fmtDateTime('not-a-date', 'utc'), 'not-a-date');
});

test('squash keeps the head; squashTail keeps the tail', () => {
  assert.equal(squash('a  b   c', 20), 'a b c');
  assert.equal(squash('abcdefgh', 5), 'abcd…');
  assert.equal(squashTail('a  b   c', 20), 'a b c');
  // Tail truncation survives the specific model name even when the namespace is long.
  assert.equal(squashTail('some/namespace/claude-sonnet-4-5', 12), '…-sonnet-4-5');
  assert.match(squashTail('some/namespace/claude-sonnet-4-5', 28), /^….*claude-sonnet-4-5$/);
  assert.equal(squashTail('short', 28), 'short');
});

test('resolveExecutable: an existing path is returned as-is, a missing one is undefined', () => {
  assert.equal(resolveExecutable(process.execPath), process.execPath);
  assert.equal(resolveExecutable(join(tmpdir(), 'symphony-no-such-binary-xyz')), undefined);
});

test('resolveExecutable: a bare name that is not on PATH is undefined', () => {
  assert.equal(resolveExecutable('symphony-no-such-binary-xyz'), undefined);
});

test('resolveExecutable: a bare name is found along PATH honouring Windows extensions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-resolve-'));
  const name = 'symphony-resolve-probe';
  const file = join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(file, '');
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved ?? ''}`;
  try {
    const found = resolveExecutable(name);
    assert.ok(found, 'expected the probe to resolve');
    // Windows may return the PATHEXT casing (e.g. .CMD) rather than the file's; compare loosely.
    assert.equal(found.toLowerCase().replace(/\\/g, '/'), file.toLowerCase().replace(/\\/g, '/'));
  } finally {
    process.env.PATH = saved;
  }
});