import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLogger } from '../src/logger.js';

test('logger: stdout and file entries carry a local time prefix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-log-'));
  const file = join(dir, 'symphony.log');
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { written.push(s); return true; };
  try {
    const logger = createLogger(file, false);
    logger.info('hello');
    logger.warn('careful');
    logger.banner('Halted', ['billing']);
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^\d{2}:\d{2}:\d{2} INFO hello$/m);
  assert.match(text, /^\d{2}:\d{2}:\d{2} WARN careful$/m);
  assert.match(text, /^\d{2}:\d{2}:\d{2} HALT Halted \| billing$/m);
  assert.ok(written.some((l) => /^\d{2}:\d{2}:\d{2} INFO hello$/.test(l.trimEnd())));
});