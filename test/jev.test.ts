import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, type JevConfig } from '../src/config.js';
import { classifyError, classifyEscalation, classifySessionResult, jevBaseUrl, jevProblem, parseDecision, parseErrorDecision, parseEscalationDecision } from '../src/jev.js';

const jevConfig = (over: Partial<JevConfig> = {}): JevConfig => ({ ...DEFAULTS.jev, enabled: true, ...over });

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('parseDecision reads the disposition choice, its confidence, probabilities and cost', () => {
  const d = parseDecision({
    model: 'typesafe/jev-1.13-20260917',
    answers: { disposition: { type: 'choice', choice: 'done', confidence: 0.91, probabilities: { done: 0.91, continue: 0.05, blocked: 0.02, failed: 0.02 } } },
    usage: { input_tokens: 100, output_tokens: 4, cost: 0.00002 },
  });
  assert.equal(d?.status, 'done');
  assert.equal(d?.confidence, 0.91);
  assert.equal(d?.probabilities?.continue, 0.05);
  assert.equal(d?.model, 'typesafe/jev-1.13-20260917');
  assert.equal(d?.costUsd, 0.00002);
});

test('parseDecision rejects malformed answers and unknown options', () => {
  assert.equal(parseDecision(null), undefined);
  assert.equal(parseDecision({}), undefined);
  assert.equal(parseDecision({ answers: {} }), undefined);
  assert.equal(parseDecision({ answers: { disposition: { type: 'noul', noul: 0.9 } } }), undefined);
  assert.equal(parseDecision({ answers: { disposition: { type: 'choice', choice: 'maybe', confidence: 0.9 } } }), undefined);
});

test('jevProblem explains why the fallback cannot run', () => {
  assert.equal(jevProblem({ ...DEFAULTS.jev, enabled: false }, {}), 'disabled');
  assert.match(jevProblem(jevConfig(), {}) ?? '', /OPENROUTER_API_KEY/);
  assert.equal(jevProblem(jevConfig(), { OPENROUTER_API_KEY: 'sk-or-x' }), undefined);
});

test('jevBaseUrl defaults to OpenRouter and honours an override', () => {
  assert.equal(jevBaseUrl(DEFAULTS.jev), 'https://openrouter.ai/api');
  assert.equal(jevBaseUrl({ ...DEFAULTS.jev, baseUrl: 'https://gateway.internal/' }), 'https://gateway.internal');
});

test('classifySessionResult posts the System One request and parses the answer', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init: init as RequestInit };
    return jsonResponse({ model: 'typesafe/jev-1.13', answers: { disposition: { type: 'choice', choice: 'continue', confidence: 0.8 } }, usage: { cost: 0.00001 } });
  }) as unknown as typeof fetch;

  const d = await classifySessionResult(jevConfig(), { taskTitle: 'Do the thing', output: 'Part one is done; part two remains.' }, { fetchImpl, env: { OPENROUTER_API_KEY: 'sk-or-test' } });
  assert.equal(d?.status, 'continue');
  assert.equal(d?.confidence, 0.8);
  assert.equal(d?.costUsd, 0.00001);
  assert.equal(seen?.url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal((seen?.init.headers as Record<string, string>).Authorization, 'Bearer sk-or-test');
  const body = JSON.parse(String(seen?.init.body)) as { model: string; state: Record<string, string>; questions: { disposition: { type: string; criteria: Record<string, string> } } };
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.questions.disposition.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.disposition.criteria), ['done', 'continue', 'blocked', 'failed']);
  assert.equal(body.state.task_title, 'Do the thing');
});

test('classifySessionResult resolves undefined on a non-OK response, a thrown fetch, or a missing key', async () => {
  const cfg = jevConfig();
  const notOk = (async () => jsonResponse({ error: 'nope' }, 401)) as unknown as typeof fetch;
  assert.equal(await classifySessionResult(cfg, { taskTitle: 't', output: 'x' }, { fetchImpl: notOk, env: { OPENROUTER_API_KEY: 'k' } }), undefined);
  const boom = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
  assert.equal(await classifySessionResult(cfg, { taskTitle: 't', output: 'x' }, { fetchImpl: boom, env: { OPENROUTER_API_KEY: 'k' } }), undefined);
  const never = (async () => jsonResponse({})) as unknown as typeof fetch;
  assert.equal(await classifySessionResult(cfg, { taskTitle: 't', output: 'x' }, { fetchImpl: never, env: {} }), undefined);
});

test('classifyError posts the error state and parses the category', async () => {
  let body: { questions: { category: { type: string; criteria: Record<string, string> } }; state: { exit_code: number; result_subtype: string } } | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return jsonResponse({ model: 'typesafe/jev-1.13', answers: { category: { type: 'choice', choice: 'server', confidence: 0.88 } }, usage: { cost: 0.00001 } });
  }) as unknown as typeof fetch;

  const d = await classifyError(jevConfig(), { evidence: 'the widget exploded', exitCode: 1, resultSubtype: 'error_during_execution' }, { fetchImpl, env: { OPENROUTER_API_KEY: 'k' } });
  assert.equal(d?.category, 'server');
  assert.equal(d?.confidence, 0.88);
  assert.equal(body?.questions.category.type, 'choice');
  assert.ok(Object.keys(body?.questions.category.criteria ?? {}).includes('rate_limit'));
  assert.equal(body?.state.exit_code, 1);
  assert.equal(body?.state.result_subtype, 'error_during_execution');
});

test('parseErrorDecision accepts known categories and rejects anything else', () => {
  assert.equal(parseErrorDecision({ answers: { category: { type: 'choice', choice: 'rate_limit', confidence: 0.9 } } })?.category, 'rate_limit');
  assert.equal(parseErrorDecision({ answers: { category: { type: 'choice', choice: 'made_up', confidence: 0.9 } } }), undefined);
  assert.equal(parseErrorDecision({ answers: { category: { type: 'noul', noul: 0.9 } } }), undefined);
  assert.equal(parseErrorDecision({}), undefined);
});

test('classifyEscalation sends the task and failure and parses the decision', async () => {
  let body: { questions: { decision: { type: string; criteria: Record<string, string> } }; state: { task: { title: string; body: string }; failure: string } } | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return jsonResponse({ model: 'typesafe/jev-1.13', answers: { decision: { type: 'choice', choice: 'escalate', confidence: 0.82 } }, usage: { cost: 0.00001 } });
  }) as unknown as typeof fetch;

  const d = await classifyEscalation(jevConfig(), { taskTitle: 'Do the thing', taskBody: '## Goal\nShip the widget.', failure: 'model reported failed' }, { fetchImpl, env: { OPENROUTER_API_KEY: 'k' } });
  assert.equal(d?.escalate, true);
  assert.equal(d?.confidence, 0.82);
  assert.equal(body?.questions.decision.type, 'choice');
  assert.deepEqual(Object.keys(body?.questions.decision.criteria ?? {}), ['escalate', 'stay']);
  assert.equal(body?.state.task.title, 'Do the thing');
  assert.equal(body?.state.task.body, '## Goal\nShip the widget.');
  assert.equal(body?.state.failure, 'model reported failed');
});

test('parseEscalationDecision maps the choice to a boolean and rejects anything else', () => {
  assert.equal(parseEscalationDecision({ answers: { decision: { type: 'choice', choice: 'escalate', confidence: 0.9 } } })?.escalate, true);
  assert.equal(parseEscalationDecision({ answers: { decision: { type: 'choice', choice: 'stay', confidence: 0.9 } } })?.escalate, false);
  assert.equal(parseEscalationDecision({ answers: { decision: { type: 'choice', choice: 'maybe', confidence: 0.9 } } }), undefined);
  assert.equal(parseEscalationDecision({ answers: { decision: { type: 'noul', noul: 0.9 } } }), undefined);
  assert.equal(parseEscalationDecision({}), undefined);
});
