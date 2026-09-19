import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openRunSinks } from '../src/logger.js';
import { claudeProvider } from '../src/providers/claude.js';
import { startSession } from '../src/session.js';

const script = (lines: unknown[], exit = 0, stderr?: string, sleepMs = 0) => `
  const lines = ${JSON.stringify(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))))};
  process.stdin.resume(); process.stdin.on('data', () => {});
  (async () => {
    for (const l of lines) { process.stdout.write(l + '\\n'); await new Promise(r => setTimeout(r, 5)); }
    ${stderr ? `process.stderr.write(${JSON.stringify(stderr)} + '\\n');` : ''}
    if (${sleepMs}) await new Promise(r => setTimeout(r, ${sleepMs}));
    process.exit(${exit});
  })();`;

function run(js: string, over: Partial<Parameters<typeof startSession>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-sess-'));
  const sinks = openRunSinks(dir, 'T01-test');
  const s = startSession({
    spec: { bin: process.execPath, args: ['-e', js], stdinPayload: 'prompt' },
    provider: claudeProvider, cwd: dir, timeoutMs: 20_000, idleTimeoutMs: 0, sinks,
    liveMaxChars: 100, logMaxChars: 1000, color: false, live: false, ...over,
  });
  return { s, sinks, dir };
}

test('normal session: events accumulate, result captured, files written', async () => {
  const { s, sinks } = run(script([
    { type: 'system', subtype: 'init', session_id: 'abc', model: 'm' },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'let me see' }, { type: 'text', text: 'working' }] } },
    'plain text line',
    { type: 'result', subtype: 'success', is_error: false, result: 'SYMPHONY_RESULT\nstatus: done\nsummary: s\nEND_SYMPHONY_RESULT', total_cost_usd: 0.25, session_id: 'abc' },
  ]));
  const out = await s.done;
  await sinks.close();
  assert.equal(out.exitCode, 0);
  assert.equal(out.sessionId, 'abc');
  assert.equal(out.model, 'm');
  assert.equal(out.costUsd, 0.25);
  assert.equal(out.sawResult, true);
  assert.equal(out.result.ok, true);
  assert.ok(out.result.text.includes('status: done'));
  assert.equal(out.allText, 'working');
  const log = readFileSync(sinks.logPath, 'utf8');
  assert.ok(log.includes('[think] let me see'));
  assert.ok(log.includes('[stdout] plain text line'));
  assert.ok(log.includes('[result] ok'));
  const jsonl = readFileSync(sinks.jsonlPath, 'utf8').trim().split('\n');
  assert.equal(jsonl.length, 4);
});

test('exit without result → synthesized error result, stderr captured', async () => {
  const { s, sinks } = run(script([{ type: 'system', subtype: 'init', session_id: 'x' }], 2, 'Error: Not logged in'));
  const out = await s.done;
  await sinks.close();
  assert.equal(out.exitCode, 2);
  assert.equal(out.sawResult, false);
  assert.equal(out.result.ok, false);
  assert.equal(out.result.synthesized, true);
  assert.equal(out.result.errorSubtype, 'exit_2');
  assert.ok(out.stderrTail.includes('Not logged in'));
});

test('idle timeout kills a silent child and flags stalled', async () => {
  const { s, sinks } = run(script([{ type: 'system', subtype: 'init', session_id: 'x' }], 0, undefined, 60_000), { idleTimeoutMs: 300 });
  const out = await s.done;
  await sinks.close();
  assert.equal(out.stalled, true);
  assert.equal(out.result.ok, false);
  assert.ok(out.signal === 'SIGTERM' || out.exitCode !== 0);
});

test('missing binary → spawnError, no hang', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-sess-'));
  const sinks = openRunSinks(dir, 'T01-nobin');
  const s = startSession({ spec: { bin: '/definitely/not/here', args: [] }, provider: claudeProvider, cwd: dir, timeoutMs: 5000, idleTimeoutMs: 0, sinks, liveMaxChars: 100, logMaxChars: 100, color: false, live: false });
  const out = await s.done;
  await sinks.close();
  assert.match(out.spawnError ?? '', /ENOENT/);
  assert.equal(out.result.ok, false);
});
