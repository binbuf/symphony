import assert from 'node:assert/strict';
import { test } from 'node:test';
import { antigravityProvider } from '../src/providers/antigravity.js';
import { ClaudeParser, claudeProvider } from '../src/providers/claude.js';
import { CodexParser, codexProvider } from '../src/providers/codex.js';
import { ARGV_PROMPT_LIMIT, ATTACHED_PROMPT, promptFileHint, promptOverflowsArgv } from '../src/providers/common.js';
import { CursorParser, cursorProvider } from '../src/providers/cursor.js';
import { GenericParser } from '../src/providers/generic.js';
import { geminiProvider } from '../src/providers/gemini.js';
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

test('claude parser: result usage sums cache reads and creations; absent usage invents no key', () => {
  const p = new ClaudeParser();
  const r = p.parse(j({ type: 'result', subtype: 'success', is_error: false, result: 'final', usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 30 } }))[0] as { usage?: unknown };
  assert.deepEqual(r.usage, { inputTokens: 100, cachedInputTokens: 25, outputTokens: 30 });
  assert.deepEqual(p.hints().usage, { inputTokens: 100, cachedInputTokens: 25, outputTokens: 30 });
  const bare = new ClaudeParser().parse(j({ type: 'result', subtype: 'success', is_error: false, result: 'x' }))[0] as Record<string, unknown>;
  assert.ok(!('usage' in bare), 'no usage on the wire means no usage property on the event');
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

test('claude buildCommand: prompt inline on -p, bypass by default, safe mode flags', () => {
  const c = claudeProvider.buildCommand(opts({ model: 'mm', budgetUsd: 5, resumeId: 'r1' }));
  assert.equal(c.bin, 'bin');
  assert.equal(c.stdinPayload, undefined, 'the prompt is on argv, never on stdin');
  assert.deepEqual(c.args.slice(0, 2), ['-p', 'do it']);
  assert.ok(c.args.includes('--dangerously-skip-permissions'));
  assert.ok(c.args.join(' ').includes('--resume r1'));
  assert.ok(c.args.join(' ').includes('--model mm'));
  assert.ok(c.args.join(' ').includes('--max-budget-usd 5'));
  assert.ok(c.args.includes('--x'));
  assert.ok(!c.args.join(' ').includes('Follow the instructions'), 'no base-prompt wrapper');
  const s = claudeProvider.buildCommand(opts({ autoApprove: false }));
  assert.ok(!s.args.includes('--dangerously-skip-permissions'));
  assert.ok(s.args.join(' ').includes('--permission-mode acceptEdits'));
  // A read-only session pre-approves Read and blocks the write/shell tools, whatever autoApprove says.
  const ro = claudeProvider.buildCommand(opts({ readOnly: true }));
  const roArgs = ro.args.join(' ');
  assert.ok(roArgs.includes('--allowedTools Read'));
  assert.ok(roArgs.includes('--disallowedTools Edit Write NotebookEdit Bash'));
  assert.ok(roArgs.includes('--permission-mode acceptEdits'));
  assert.ok(!ro.args.includes('--dangerously-skip-permissions'), 'read-only beats the bypass flag');
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

test('cursor buildCommand: prompt is the last positional; --force only when auto-approving', () => {
  const c = cursorProvider.buildCommand(opts({ model: 'm' }));
  assert.equal(c.args[c.args.length - 1], 'do it');
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

test('opencode parser: a 2.x typed error exposes its type and top-level message', () => {
  const p = new OpenCodeParser();
  const e = p.parse(j({ type: 'error', sessionID: 'o1', error: { type: 'provider.no-route', message: 'Variant unavailable for lithosai/deepseek-v4.1-flash: bogus' } }));
  assert.deepEqual(e.filter((x) => x.kind === 'error'), [{ kind: 'error', text: 'provider.no-route: Variant unavailable for lithosai/deepseek-v4.1-flash: bogus' }]);
  assert.ok(p.hints().errorTexts[0].includes('Variant unavailable'));
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

test('opencode parser: step_finish tokens accumulate, cache read/write folds into cached', () => {
  const p = new OpenCodeParser();
  p.parse(j({ type: 'step_finish', sessionID: 'o1', part: { tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 10 } }, cost: 0.01 } }));
  p.parse(j({ type: 'reasoning', sessionID: 'o1', part: { text: 'more' } }));
  p.parse(j({ type: 'step_finish', sessionID: 'o1', part: { tokens: { total: 62, input: 50, output: 8, reasoning: 0, cache: { read: 4, write: 0 } }, cost: 0.02 } }));
  assert.deepEqual(p.hints().usage, { inputTokens: 150, cachedInputTokens: 54, outputTokens: 28, reasoningTokens: 5, totalTokens: 62 });
  assert.equal(p.hints().costUsd, 0.03);
  // A step with no tokens (an error step) contributes nothing.
  const q = new OpenCodeParser();
  q.parse(j({ type: 'step_finish', sessionID: 'o2', part: { cost: 0.5 } }));
  assert.equal(q.hints().usage, undefined);
});

test('opencode buildCommand: prompt inline as the trailing positional, --auto by default, --session on resume, --standalone', () => {
  const c = opencodeProvider.buildCommand(opts({ model: 'anthropic/x', resumeId: 'sess' }));
  assert.equal(c.args[0], 'run');
  assert.ok(c.args.includes('--auto'));
  // 2.x: a private server per invocation, so a kill stops the session and OPENCODE_CONFIG_CONTENT stays authoritative.
  assert.ok(c.args.includes('--standalone'));
  assert.ok(c.args.join(' ').includes('--session sess'));
  assert.ok(c.args.join(' ').includes('--model anthropic/x'));
  // The prompt is the trailing positional: no `--file`, no read-the-file bootstrap.
  assert.equal(c.args[c.args.length - 1], 'do it');
  assert.equal(c.args[c.args.length - 2], '--x');
  assert.equal(c.stdinPayload, undefined);
  assert.ok(!c.args.includes('--file'));
  assert.ok(!c.args.includes('--dir'));
  assert.ok(c.args.join(' ').includes('--format json'));
  assert.ok(c.args.includes('--thinking'));
});

test('every provider passes the prompt on argv with no base-prompt or file wrapper', () => {
  const expected: Array<[string, ReturnType<typeof antigravityProvider.buildCommand>]> = [
    ['gemini', geminiProvider.buildCommand(opts({ prompt: 'watch this' }))],
    ['cursor', cursorProvider.buildCommand(opts({ prompt: 'watch this' }))],
    ['antigravity', antigravityProvider.buildCommand(opts({ prompt: 'watch this' }))],
    ['codex', codexProvider.buildCommand(opts({ prompt: 'watch this' }))],
    ['claude', claudeProvider.buildCommand(opts({ prompt: 'watch this' }))],
    ['opencode', opencodeProvider.buildCommand(opts({ prompt: 'watch this' }))],
  ];
  for (const [name, c] of expected) {
    const text = c.args.join(' ');
    assert.ok(c.args.includes('watch this'), `${name} carries the prompt on argv`);
    assert.ok(!text.includes('Follow the instructions'), `${name} drops the base-prompt wrapper`);
    assert.equal(c.stdinPayload, undefined, `${name} sends nothing on stdin`);
  }
});

test('prompt overflow predicate: only a Windows .cmd/.bat shim past the limit offloads', () => {
  const big = 'x'.repeat(ARGV_PROMPT_LIMIT + 1);
  const atLimit = 'x'.repeat(ARGV_PROMPT_LIMIT);
  // Wrong platform, a native .exe, or a prompt at/under the limit all stay inline.
  assert.equal(promptOverflowsArgv({ bin: 'opencode.cmd', prompt: big, cwd: '/p' }, 'linux'), false);
  assert.equal(promptOverflowsArgv({ bin: 'C:\\tools\\opencode.exe', prompt: big, cwd: '/p' }, 'win32'), false);
  assert.equal(promptOverflowsArgv({ bin: 'C:\\tools\\opencode.cmd', prompt: atLimit, cwd: '/p' }, 'win32'), false);
  assert.equal(promptOverflowsArgv({ bin: 'C:\\tools\\opencode.cmd', prompt: big, cwd: '/p' }, 'win32'), true);
  assert.equal(promptOverflowsArgv({ bin: 'C:\\tools\\opencode.bat', prompt: big, cwd: '/p' }, 'win32'), true);
  // The limit is bytes, not UTF-16 code units, so a multibyte prompt past it offloads.
  assert.equal(promptOverflowsArgv({ bin: 'C:\\tools\\opencode.cmd', prompt: 'é'.repeat(ARGV_PROMPT_LIMIT), cwd: '/p' }, 'win32'), true);
});

test('an oversized prompt offloads to the runner prompt file for a Windows .cmd shim', { skip: process.platform !== 'win32' }, () => {
  const big = 'x'.repeat(ARGV_PROMPT_LIMIT + 1);
  const shim = { bin: 'opencode.cmd', cwd: '/proj' };

  // opencode attaches the file; the pointer must precede `--file` (an array flag).
  const oc = opencodeProvider.buildCommand(opts({ ...shim, prompt: big }));
  assert.deepEqual(oc.args.slice(-3), [ATTACHED_PROMPT, '--file', '/tmp/p.md']);
  assert.ok(!oc.args.includes(big), 'opencode keeps the payload off argv');
  assert.equal(oc.stdinPayload, undefined);

  // codex reads the prompt from stdin (`-`); claude names the file on `-p`.
  const cd = codexProvider.buildCommand(opts({ ...shim, prompt: big }));
  assert.equal(cd.args[cd.args.length - 1], '-');
  assert.equal(cd.stdinPayload, big);
  const cl = claudeProvider.buildCommand(opts({ ...shim, prompt: big }));
  assert.deepEqual(cl.args.slice(0, 2), ['-p', promptFileHint('/tmp/p.md')]);
  assert.ok(!cl.args.includes(big));

  // cursor/gemini/antigravity have no attach flag, so the message names the path.
  const others = [
    ['cursor', cursorProvider.buildCommand(opts({ ...shim, prompt: big }))],
    ['gemini', geminiProvider.buildCommand(opts({ ...shim, prompt: big }))],
    ['antigravity', antigravityProvider.buildCommand(opts({ ...shim, prompt: big }))],
  ] as const;
  for (const [name, c] of others) {
    assert.ok(c.args.includes(promptFileHint('/tmp/p.md')), `${name} names the prompt file`);
    assert.ok(!c.args.includes(big), `${name} keeps the payload off argv`);
  }
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
  assert.deepEqual((done[0] as { usage?: unknown }).usage, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 });
  assert.deepEqual(p.hints().usage, { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 });
  const q = new CodexParser();
  const failed = q.parse(j({ type: 'turn.failed', error: { message: 'You have exceeded your usage limit' } }));
  assert.deepEqual(failed.map((e) => e.kind), ['error', 'result']);
  assert.equal((failed[1] as { ok: boolean }).ok, false);
  assert.ok(q.hints().errorTexts[0].includes('usage limit'));
});

test('codex buildCommand: full bypass by default, sandbox in safe mode, resume subcommand, prompt inline', () => {
  const c = codexProvider.buildCommand(opts({ model: 'o3' }));
  assert.deepEqual(c.args.slice(0, 2), ['exec', '--json']);
  assert.ok(c.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(c.args.join(' ').includes('--cd /proj'));
  assert.equal(c.args[c.args.length - 1], 'do it');
  assert.equal(c.stdinPayload, undefined);
  const s = codexProvider.buildCommand(opts({ autoApprove: false, resumeId: 'th1' }));
  assert.deepEqual(s.args.slice(0, 3), ['exec', 'resume', 'th1']);
  assert.ok(s.args.join(' ').includes('--sandbox workspace-write'));
  assert.ok(!s.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  // A read-only session runs in codex's read-only sandbox, whatever autoApprove says.
  const ro = codexProvider.buildCommand(opts({ readOnly: true }));
  assert.ok(ro.args.join(' ').includes('--sandbox read-only'));
  assert.ok(!ro.args.join(' ').includes('workspace-write'));
  assert.ok(!ro.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  const big = codexProvider.buildCommand(opts({ prompt: 'x'.repeat(9000) }));
  assert.equal(big.args[big.args.length - 1].length, 9000, 'even a large prompt rides on argv');
  assert.equal(big.stdinPayload, undefined);
});

test('generic parser: gemini-style stats models fold into hints usage', () => {
  const p = new GenericParser();
  p.parse(j({ session_id: 'g1', response: 'hi', stats: { models: { 'gemini-3-pro': { tokens: { input: 100, output: 10, cached: 20, thoughts: 3, total: 133 } } } } }));
  assert.deepEqual(p.hints().usage, { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 3, totalTokens: 133 });
  // Plain text lines and unrelated objects stay usage-free.
  const q = new GenericParser();
  q.parse('just text');
  q.parse(j({ type: 'result', subtype: 'success', response: 'done' }));
  assert.equal(q.hints().usage, undefined);
});

test('variant args: every provider with an effort knob gets its own flag or reference, and only when set', () => {
  assert.ok(claudeProvider.buildCommand(opts({ model: 'm', variant: 'high' })).args.join(' ').includes('--effort high'));
  // OpenCode 2.x carries the variant in the model reference, not a `--variant` flag.
  const oc = opencodeProvider.buildCommand(opts({ model: 'anthropic/x', variant: 'high' }));
  assert.ok(oc.args.join(' ').includes('--model anthropic/x#high'));
  assert.ok(!oc.args.includes('--variant'));
  assert.ok(codexProvider.buildCommand(opts({ model: 'o3', variant: 'high' })).args.join(' ').includes('-c model_reasoning_effort=high'));
  assert.ok(antigravityProvider.buildCommand(opts({ model: 'g', variant: 'high' })).args.join(' ').includes('--effort high'));
  assert.ok(!claudeProvider.buildCommand(opts({ model: 'm' })).args.includes('--effort'));
  assert.ok(!opencodeProvider.buildCommand(opts({ model: 'anthropic/x', variant: 'high' })).args.includes('--variant'));
  // A variant with no model to ride on is dropped rather than emitted as a stray flag.
  assert.ok(!opencodeProvider.buildCommand(opts({ variant: 'high' })).args.join(' ').includes('high'));
});

test('opencode model variant catalog: the 2.x /api/model document maps refs to their variants', () => {
  const out = JSON.stringify({
    location: { directory: '/p' },
    data: [
      { providerID: 'deepinfra', id: 'deepseek-ai/X', variants: [{ id: 'low' }, { id: 'high' }] },
      { providerID: 'other', id: 'plain', variants: [] },
      { providerID: 'openrouter', id: 'anthropic/claude-sonnet-4-5', variants: [{ id: 'thinking' }] },
    ],
  });
  const map = parseModelVariants(out);
  assert.deepEqual([...map.get('deepinfra/deepseek-ai/X')!].sort(), ['high', 'low']);
  assert.deepEqual([...map.get('other/plain')!], []);
  assert.deepEqual([...map.get('openrouter/anthropic/claude-sonnet-4-5')!], ['thinking']);
  // Garbage, and the retired interleaved `models --verbose` shape, yield an empty map rather than a throw.
  assert.equal(parseModelVariants('not json').size, 0);
  assert.equal(parseModelVariants('deepinfra/x\n{"providerID":"deepinfra","id":"x"}').size, 0);
});

test('opencode version gate: 2.x is accepted, 1.x warns, unknown shapes do not block', () => {
  assert.equal(opencodeVersionWarning('2.0.23'), undefined);
  assert.equal(opencodeVersionWarning('2.1.0\n'), undefined);
  assert.match(opencodeVersionWarning('1.18.29') ?? '', /requires OpenCode 2\.x/);
  assert.match(opencodeVersionWarning('1.0.0') ?? '', /1\.0\.0/);
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
  // MCP scoping: claude/codex/opencode/gemini accept per-session config; cursor/antigravity do not.
  assert.equal(claudeProvider.supportsMcp, true);
  assert.equal(codexProvider.supportsMcp, true);
  assert.equal(opencodeProvider.supportsMcp, true);
  assert.equal(geminiProvider.supportsMcp, true);
  assert.equal(cursorProvider.supportsMcp, false);
  assert.equal(antigravityProvider.supportsMcp, false);
});
