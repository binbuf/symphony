import assert from 'node:assert/strict';
import { test } from 'node:test';
import { antigravityProvider } from '../src/providers/antigravity.js';
import { ClaudeParser, claudeProvider } from '../src/providers/claude.js';
import { CodexParser, codexProvider } from '../src/providers/codex.js';
import { ATTACHED_BOOTSTRAP, fileBootstrap } from '../src/providers/common.js';
import { CursorParser, cursorProvider } from '../src/providers/cursor.js';
import { OpenCodeParser, opencodeProvider, opencodeVersionWarning, parseModelVariants } from '../src/providers/opencode.js';
import type { BuildCommandOpts } from '../src/providers/types.js';

const j = (o: unknown) => JSON.stringify(o);
const opts = (over: Partial<BuildCommandOpts> = {}): BuildCommandOpts => ({
  bin: 'bin', prompt: 'do it', promptFile: '/tmp/p.md', taskId: 'T01', attempt: 1, kind: 'task', autoApprove: true, extraArgs: ['--x'], cwd: '/proj', ...over,
});

test('claude parser: init, thinking/text/tool_use, tool_result (string and blocks), result, noise ignored', () => {
  const p = new ClaudeParser();
  assert.deepEqual(p.parse(j({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' })), [{ kind: 'init', sessionId: 's1', model: 'm' }]);
  assert.deepEqual(p.parse(j({ type: 'system', subtype: 'thinking_tokens', n: 1 })), []);
  assert.deepEqual(p.parse(j({ type: 'tool_progress' })), []);
  const ev = p.parse(j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'run' } }] } }));
  assert.deepEqual(ev.map((e) => e.kind), ['thinking', 'text', 'tool_use']);
  assert.equal((ev[2] as { hint: string }).hint, 'npm test');
  assert.deepEqual(p.parse(j({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok', is_error: false }] } })), [{ kind: 'tool_result', text: 'ok', isError: false }]);
  assert.deepEqual(p.parse(j({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] } })), [{ kind: 'tool_result', text: 'a\nb', isError: false }]);
  const r = p.parse(j({ type: 'result', subtype: 'success', is_error: false, result: 'final', total_cost_usd: 1.5, num_turns: 3, session_id: 's1', duration_ms: 10 }))[0];
  assert.equal(r.kind, 'result');
  assert.deepEqual(r, { kind: 'result', ok: true, text: 'final', sessionId: 's1', costUsd: 1.5, turns: 3, errorSubtype: undefined, durationMs: 10 });
  assert.equal(p.hints().costUsd, 1.5);
});

test('claude parser: api_retry hints and error result', () => {
  const p = new ClaudeParser();
  p.parse(j({ type: 'system', subtype: 'api_retry', error: 'billing_error', attempt: 1, max_retries: 3 }));
  const r = p.parse(j({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Credit balance is too low' }))[0];
  assert.equal(r.kind === 'result' && r.ok, false);
  assert.deepEqual(p.hints().apiErrorCategories, ['billing_error']);
  assert.ok(p.hints().errorTexts.some((t) => /Credit balance/.test(t)));
  assert.deepEqual(p.parse('not json'), [{ kind: 'raw', text: 'not json', stream: 'stdout' }]);
});

test('claude buildCommand: stdin prompt, bypass by default, safe mode flags', () => {
  const c = claudeProvider.buildCommand(opts({ model: 'mm', budgetUsd: 5, resumeId: 'r1' }));
  assert.equal(c.bin, 'bin');
  assert.equal(c.stdinPayload, 'do it');
  assert.ok(c.args.includes('--dangerously-skip-permissions'));
  assert.ok(c.args.join(' ').includes('--resume r1'));
  assert.ok(c.args.join(' ').includes('--model mm'));
  assert.ok(c.args.join(' ').includes('--max-budget-usd 5'));
  assert.ok(c.args.includes('--x'));
  const s = claudeProvider.buildCommand(opts({ autoApprove: false }));
  assert.ok(!s.args.includes('--dangerously-skip-permissions'));
  assert.ok(s.args.join(' ').includes('--permission-mode acceptEdits'));
});

test('cursor parser: tool_call reduction and result', () => {
  const p = new CursorParser();
  assert.deepEqual(p.parse(j({ type: 'system', subtype: 'init', session_id: 'c1', model: 'gpt' })), [{ kind: 'init', sessionId: 'c1', model: 'gpt' }]);
  assert.deepEqual(p.parse(j({ type: 'user', message: {} })), []);
  const started = p.parse(j({ type: 'tool_call', subtype: 'started', call_id: 'k1', tool_call: { readToolCall: { args: { path: 'src/a.ts' } } } }))[0];
  assert.deepEqual(started, { kind: 'tool_use', name: 'read', hint: 'src/a.ts', input: { path: 'src/a.ts' } });
  const done = p.parse(j({ type: 'tool_call', subtype: 'completed', call_id: 'k1', tool_call: { readToolCall: { args: { path: 'src/a.ts' }, result: { success: { content: 'file body' } } } } }))[0];
  assert.deepEqual(done, { kind: 'tool_result', text: 'file body', isError: false });
  const fn = p.parse(j({ type: 'tool_call', subtype: 'started', call_id: 'k2', tool_call: { function: { name: 'shell', args: '{"command":"ls"}' } } }))[0];
  assert.deepEqual(fn, { kind: 'tool_use', name: 'shell', hint: 'ls', input: { command: 'ls' } });
  const r = p.parse(j({ type: 'result', subtype: 'success', result: 'bye', session_id: 'c1', duration_ms: 5 }))[0];
  assert.deepEqual(r, { kind: 'result', ok: true, text: 'bye', sessionId: 'c1', durationMs: 5, errorSubtype: undefined });
});

test('cursor buildCommand: prompt file bootstrap is the last positional; --force only when auto-approving', () => {
  const c = cursorProvider.buildCommand(opts({ model: 'm' }));
  assert.equal(c.args[c.args.length - 1], fileBootstrap('/tmp/p.md'));
  assert.ok(c.args.includes('--force') && c.args.includes('--trust') && c.args.includes('-p'));
  assert.equal(c.stdinPayload, undefined);
  assert.ok(!cursorProvider.buildCommand(opts({ autoApprove: false })).args.includes('--force'));
});

test('opencode parser: init once, reasoning, tool dedupe, error', () => {
  const p = new OpenCodeParser();
  const first = p.parse(j({ type: 'reasoning', sessionID: 'o1', part: { text: 'thinking...' } }));
  assert.deepEqual(first.map((e) => e.kind), ['init', 'thinking']);
  assert.deepEqual(p.parse(j({ type: 'text', sessionID: 'o1', part: { text: 'hello' } })), [{ kind: 'text', text: 'hello' }]);
  const t1 = p.parse(j({ type: 'tool_use', sessionID: 'o1', part: { id: 'x', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } } }));
  assert.deepEqual(t1, [{ kind: 'tool_use', name: 'bash', hint: 'ls', input: { command: 'ls' } }]);
  const t2 = p.parse(j({ type: 'tool_use', sessionID: 'o1', part: { id: 'x', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a b' } } }));
  assert.deepEqual(t2, [{ kind: 'tool_result', text: 'a b', isError: false }]);
  assert.deepEqual(p.parse(j({ type: 'tool_use', sessionID: 'o1', part: { id: 'x', tool: 'bash', state: { status: 'completed', output: 'a b' } } })), []);
  const e = p.parse(j({ type: 'error', sessionID: 'o1', error: { name: 'ProviderAuthError', data: { message: 'invalid api key' } } }));
  assert.deepEqual(e, [{ kind: 'error', text: 'ProviderAuthError: invalid api key' }]);
  assert.ok(p.hints().errorTexts[0].includes('invalid api key'));
});

test('opencode parser: an error event exposes HTTP status, retryable, and Retry-After', () => {
  const p = new OpenCodeParser();
  const e = p.parse(j({ type: 'error', sessionID: 'o1', error: { name: 'AI_APICallError', data: { message: 'Provider returned an error', statusCode: 429, isRetryable: true, retryAfter: 30 } } }));
  const ev = e.find((x) => x.kind === 'error') as { kind: 'error'; text: string };
  assert.equal(ev.kind, 'error');
  assert.ok(ev.text.includes('HTTP 429'));
  assert.ok(ev.text.includes('retry after 30s'));
  assert.equal(p.hints().httpStatus, 429);
  assert.equal(p.hints().retryable, true);
  assert.equal(p.hints().retryAfterSec, 30);

  // A numeric string status and a Retry-After nested in responseBody are both understood.
  const q = new OpenCodeParser();
  q.parse(j({ type: 'error', sessionID: 'o2', error: { name: 'AI_APICallError', data: { message: 'busy', status: '503', responseBody: '{"retry_after":15}' } } }));
  assert.equal(q.hints().httpStatus, 503);
  assert.equal(q.hints().retryAfterSec, 15);
});

test('opencode buildCommand: prompt attached via --file, --auto by default, --session on resume', () => {
  const c = opencodeProvider.buildCommand(opts({ model: 'anthropic/x', resumeId: 'sess' }));
  assert.equal(c.args[0], 'run');
  assert.ok(c.args.includes('--auto'));
  assert.ok(c.args.join(' ').includes('--session sess'));
  // `--file` is an array flag in the 1.x CLI: the bootstrap message is the positional and must come
  // first, with `--file <path>` last so the bootstrap is never swallowed as a second file.
  assert.equal(c.args[c.args.length - 2], '--file');
  assert.equal(c.args[c.args.length - 1], '/tmp/p.md');
  assert.equal(c.args[c.args.length - 3], ATTACHED_BOOTSTRAP);
  assert.equal(c.stdinPayload, undefined);
  assert.ok(!c.args.includes('--dir'));
  // OpenCode 1.x flags only: `--standalone` is a 2.x server flag the 1.x CLI rejects.
  assert.ok(!c.args.includes('--standalone'));
  assert.ok(c.args.join(' ').includes('--format json'));
  assert.ok(c.args.includes('--thinking'));
});

test('codex parser: thread, items, turn.completed → result with last message; turn.failed → error result', () => {
  const p = new CodexParser();
  assert.deepEqual(p.parse(j({ type: 'thread.started', thread_id: 'th1' })), [{ kind: 'init', sessionId: 'th1' }]);
  assert.deepEqual(p.parse(j({ type: 'turn.started' })), []);
  assert.deepEqual(p.parse(j({ type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: 'plan' } })), [{ kind: 'thinking', text: 'plan' }]);
  const cmdStart = p.parse(j({ type: 'item.started', item: { id: 'i2', type: 'command_execution', command: 'npm test', status: 'in_progress' } }));
  assert.deepEqual(cmdStart, [{ kind: 'tool_use', name: 'shell', hint: 'npm test', input: { command: 'npm test' } }]);
  const cmdDone = p.parse(j({ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0, status: 'completed' } }));
  assert.deepEqual(cmdDone, [{ kind: 'tool_result', text: 'ok', isError: false }]);
  assert.deepEqual(p.parse(j({ type: 'item.completed', item: { id: 'i3', type: 'file_change', changes: [{ path: 'a.ts', kind: 'add' }], status: 'completed' } })).map((e) => e.kind), ['tool_use', 'tool_result']);
  assert.deepEqual(p.parse(j({ type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'SYMPHONY_RESULT\nstatus: done\nsummary: x\nEND_SYMPHONY_RESULT' } })), [{ kind: 'text', text: 'SYMPHONY_RESULT\nstatus: done\nsummary: x\nEND_SYMPHONY_RESULT' }]);
  const done = p.parse(j({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }));
  assert.equal(done[0].kind, 'result');
  assert.equal((done[0] as { ok: boolean }).ok, true);
  assert.equal((done[0] as { text: string }).text.includes('status: done'), true);
  assert.equal((done[0] as { sessionId?: string }).sessionId, 'th1');
  const q = new CodexParser();
  const failed = q.parse(j({ type: 'turn.failed', error: { message: 'You have exceeded your usage limit' } }));
  assert.deepEqual(failed.map((e) => e.kind), ['error', 'result']);
  assert.equal((failed[1] as { ok: boolean }).ok, false);
  assert.ok(q.hints().errorTexts[0].includes('usage limit'));
});

test('codex buildCommand: full bypass by default, sandbox in safe mode, resume subcommand, prompt on stdin', () => {
  const c = codexProvider.buildCommand(opts({ model: 'o3' }));
  assert.deepEqual(c.args.slice(0, 2), ['exec', '--json']);
  assert.ok(c.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(c.args.join(' ').includes('--cd /proj'));
  assert.equal(c.args[c.args.length - 1], '-');
  assert.equal(c.stdinPayload, 'do it');
  const s = codexProvider.buildCommand(opts({ autoApprove: false, resumeId: 'th1' }));
  assert.deepEqual(s.args.slice(0, 3), ['exec', 'resume', 'th1']);
  assert.ok(s.args.join(' ').includes('--sandbox workspace-write'));
  assert.ok(!s.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  const big = codexProvider.buildCommand(opts({ prompt: 'x'.repeat(9000) }));
  assert.equal(big.args[big.args.length - 1], '-');
  assert.equal(big.stdinPayload?.length, 9000);
});

test('prompt channels: bootstrap names the prompt file, never the payload', () => {
  assert.ok(fileBootstrap('/tmp/x.prompt.md').includes('/tmp/x.prompt.md'));
  assert.ok(ATTACHED_BOOTSTRAP.length > 0);
});

test('variant args: every provider with an effort knob gets its own flag, and only when set', () => {
  assert.ok(claudeProvider.buildCommand(opts({ model: 'm', variant: 'high' })).args.join(' ').includes('--effort high'));
  assert.ok(opencodeProvider.buildCommand(opts({ model: 'anthropic/x', variant: 'high' })).args.join(' ').includes('--variant high'));
  assert.ok(codexProvider.buildCommand(opts({ model: 'o3', variant: 'high' })).args.join(' ').includes('-c model_reasoning_effort=high'));
  assert.ok(antigravityProvider.buildCommand(opts({ model: 'g', variant: 'high' })).args.join(' ').includes('--effort high'));
  assert.ok(!claudeProvider.buildCommand(opts({ model: 'm' })).args.includes('--effort'));
  assert.ok(!opencodeProvider.buildCommand(opts({ model: 'anthropic/x' })).args.includes('--variant'));
});

test('opencode model variant catalog: refs map to their advertised variants', () => {
  const out = [
    'deepinfra/deepseek-ai/X',
    JSON.stringify({ providerID: 'deepinfra', id: 'deepseek-ai/X', variants: { low: {}, high: {} } }, null, 2),
    '',
    'other/plain',
    JSON.stringify({ providerID: 'other', id: 'plain' }, null, 2),
    '',
  ].join('\n');
  const map = parseModelVariants(out);
  assert.deepEqual([...map.get('deepinfra/deepseek-ai/X')!].sort(), ['high', 'low']);
  assert.deepEqual([...map.get('other/plain')!], []);
});

test('opencode version gate: 1.x is accepted, 2.x warns, unknown shapes do not block', () => {
  assert.equal(opencodeVersionWarning('1.18.29'), undefined);
  assert.equal(opencodeVersionWarning('1.0.0\n'), undefined);
  assert.match(opencodeVersionWarning('2.0.0-beta.3') ?? '', /requires OpenCode 1\.x/);
  assert.match(opencodeVersionWarning('2.1.0') ?? '', /2\.1\.0/);
  assert.equal(opencodeVersionWarning('not a version'), undefined);
});

test('provider capability flags: variant support matches the CLI', () => {
  assert.equal(claudeProvider.supportsVariant, true);
  assert.equal(opencodeProvider.supportsVariant, true);
  assert.equal(codexProvider.supportsVariant, true);
  assert.equal(antigravityProvider.supportsVariant, true);
  assert.equal(cursorProvider.supportsVariant, false);
  assert.equal(typeof opencodeProvider.modelVariants, 'function');
  assert.equal(claudeProvider.modelVariants, undefined);
});
