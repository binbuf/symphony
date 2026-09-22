import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { fireHook } from '../src/hooks.js';

test('hooks receive the event in the environment; failures only warn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-hooks-'));
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  const config = {
    ...DEFAULTS,
    hooks: { afterTask: `node -e "require('fs').writeFileSync(process.env.SYMPHONY_ROOT + '/out.txt', process.env.SYMPHONY_TASK + ':' + process.env.SYMPHONY_STATUS + ':' + process.env.SYMPHONY_COST)"` },
  };
  fireHook(config, 'afterTask', { SYMPHONY_ROOT: dir, SYMPHONY_TASK: 'T01', SYMPHONY_STATUS: 'done', SYMPHONY_COST: '1.25' }, warn);
  assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'T01:done:1.25');
  assert.deepEqual(warnings, []);

  fireHook({ ...config, hooks: { afterTask: 'node -e "process.exit(3)"' } }, 'afterTask', { SYMPHONY_ROOT: dir }, warn);
  assert.ok(warnings.some((w) => /hook afterTask exited 3/.test(w)), `warnings=${warnings.join('|')}`);

  // A hook that is not configured is a no-op, and a hook name with no command does not throw.
  fireHook({ ...DEFAULTS, hooks: {} }, 'onHalt', { SYMPHONY_ROOT: dir }, warn);
  fireHook({ ...DEFAULTS, hooks: { afterTask: 'node -e "throw new Error(1)"' } }, 'afterTask', { SYMPHONY_ROOT: dir }, warn);
  assert.equal(warnings.length, 2);
});