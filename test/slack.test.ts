import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, type SlackConfig } from '../src/config.js';
import { formatSlackMessage, notifySlack, sendSlackMessage, slackBaseUrl, slackEventEnabled, slackProblem } from '../src/slack.js';

const cfg = (over: Partial<SlackConfig> = {}): SlackConfig => ({ ...DEFAULTS.slack, enabled: true, ...over });

const ENV: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-test' };

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('slackBaseUrl defaults to Slack and honours an override', () => {
  assert.equal(slackBaseUrl(DEFAULTS.slack), 'https://slack.com/api');
  assert.equal(slackBaseUrl({ ...DEFAULTS.slack, baseUrl: 'https://proxy.internal/slack/' }), 'https://proxy.internal/slack');
});

test('slackProblem explains why notifications cannot run', () => {
  assert.equal(slackProblem({ ...DEFAULTS.slack, enabled: false }, ENV), 'disabled');
  assert.match(slackProblem(cfg({ channel: '', user: '' }), ENV) ?? '', /neither/);
  assert.match(slackProblem(cfg({ channel: 'C123ABC' }), {}) ?? '', /SLACK_BOT_TOKEN/);
  assert.equal(slackProblem(cfg({ channel: 'C123ABC' }), ENV), undefined);
  assert.equal(slackProblem(cfg({ user: 'U123ABC' }), ENV), undefined);
});

test('slackEventEnabled requires both the master switch and the event flag', () => {
  assert.equal(slackEventEnabled(cfg(), 'taskDone'), true);
  assert.equal(slackEventEnabled(cfg({ enabled: false }), 'taskDone'), false);
  assert.equal(slackEventEnabled(cfg({ events: { ...DEFAULTS.slack.events, taskDone: false } }), 'taskDone'), false);
});

test('formatSlackMessage renders an emoji, an optional [project] tag, a bold title and detail lines', () => {
  assert.equal(formatSlackMessage({ event: 'runStart', title: 'Run started' }), ':runner: *Run started*');
  assert.equal(formatSlackMessage({ event: 'taskStart', title: 'T01 started' }), ':rocket: *T01 started*');
  assert.equal(formatSlackMessage({ event: 'taskSplit', title: 'T01 split' }), ':scissors: *T01 split*');
  assert.equal(formatSlackMessage({ event: 'taskEscalated', title: 'T01 escalated' }), ':arrow_up: *T01 escalated*');
  assert.equal(formatSlackMessage({ event: 'budgetClose', title: 'Close' }), ':warning: *Close*');
  assert.equal(formatSlackMessage({ event: 'budgetExceeded', title: 'Over' }), ':money_with_wings: *Over*');
  assert.equal(formatSlackMessage({ event: 'taskDone', title: 'T01 DONE — ship it' }), ':white_check_mark: *T01 DONE — ship it*');
  assert.equal(formatSlackMessage({ event: 'taskDone', project: 'symphony', title: 'T01 DONE — ship it' }), ':white_check_mark: *[symphony] T01 DONE — ship it*');
  assert.equal(formatSlackMessage({ event: 'taskFailed', title: 'x', lines: ['a', '', '   ', 'b'] }), ':x: *x*\na\nb');
});

test('sendSlackMessage posts to a channel id with the bearer token', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init as RequestInit });
    return jsonResponse({ ok: true, channel: 'C123ABC', ts: '123.45' });
  }) as unknown as typeof fetch;

  const r = await sendSlackMessage(cfg({ channel: 'C123ABC' }), 'hello', { fetchImpl, env: ENV });
  assert.equal(r.channel, 'C123ABC');
  assert.equal(r.ts, '123.45');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal((seen[0].init.headers as Record<string, string>).Authorization, 'Bearer xoxb-test');
  const params = new URLSearchParams(String(seen[0].init.body));
  assert.equal(params.get('channel'), 'C123ABC');
  assert.equal(params.get('text'), 'hello');
  assert.equal(params.get('unfurl_links'), 'false');
});

test('sendSlackMessage mentions a user id when posting to a channel', async () => {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return jsonResponse({ ok: true, ts: '1' });
  }) as unknown as typeof fetch;

  await sendSlackMessage(cfg({ channel: 'C123ABC', user: 'U123ABC', mention: true }), 'ping', { fetchImpl, env: ENV });
  const params = new URLSearchParams(bodies[0]);
  assert.equal(params.get('channel'), 'C123ABC');
  assert.equal(params.get('text'), '<@U123ABC> ping');

  await sendSlackMessage(cfg({ channel: 'C123ABC', user: 'U123ABC', mention: false }), 'quiet', { fetchImpl, env: ENV });
  assert.equal(new URLSearchParams(bodies[1]).get('text'), 'quiet');
});

test('sendSlackMessage DMs a user id directly (no mention prefix)', async () => {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return jsonResponse({ ok: true, ts: '2' });
  }) as unknown as typeof fetch;

  const r = await sendSlackMessage(cfg({ user: 'U123ABC' }), 'hi', { fetchImpl, env: ENV });
  assert.equal(r.channel, 'U123ABC');
  const params = new URLSearchParams(bodies[0]);
  assert.equal(params.get('channel'), 'U123ABC');
  assert.equal(params.get('text'), 'hi');
});

test('sendSlackMessage resolves a username through users.list', async () => {
  const calls: { url: string; method?: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method });
    if (u.includes('/users.list')) {
      return jsonResponse({ ok: true, members: [{ id: 'U0ALICE', name: 'alice', profile: { display_name: 'Alice' } }], response_metadata: { next_cursor: '' } });
    }
    return jsonResponse({ ok: true, channel: 'U0ALICE', ts: '3' });
  }) as unknown as typeof fetch;

  const r = await sendSlackMessage(cfg({ user: '@alice' }), 'ping', { fetchImpl, env: ENV });
  assert.equal(r.channel, 'U0ALICE');
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/users\.list\?/);
  assert.match(calls[0].url, /limit=200/);
  assert.ok(calls.some((c) => c.url.includes('/chat.postMessage')));
});

test('sendSlackMessage matches a user by handle, ignoring spaces and the @ prefix', async () => {
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/users.list')) {
      return jsonResponse({ ok: true, members: [{ id: 'U0ALICE', name: 'alice', real_name: 'Alice Smith', profile: { display_name: 'Alice Smith' } }], response_metadata: { next_cursor: '' } });
    }
    return jsonResponse({ ok: true, ts: '6' });
  }) as unknown as typeof fetch;

  const r = await sendSlackMessage(cfg({ user: ' @Alice ' }), 'ping', { fetchImpl, env: ENV });
  assert.equal(r.channel, 'U0ALICE');
});

test('sendSlackMessage follows the users.list cursor to a later page', async () => {
  const listParams: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/users.list')) {
      listParams.push(u);
      return listParams.length === 1
        ? jsonResponse({ ok: true, members: [], response_metadata: { next_cursor: 'page2' } })
        : jsonResponse({ ok: true, members: [{ id: 'U0ALICE', name: 'alice' }], response_metadata: { next_cursor: '' } });
    }
    return jsonResponse({ ok: true, ts: '4' });
  }) as unknown as typeof fetch;

  const r = await sendSlackMessage(cfg({ user: 'alice' }), 'ping', { fetchImpl, env: ENV });
  assert.equal(r.channel, 'U0ALICE');
  assert.equal(listParams.length, 2);
  assert.match(listParams[1], /cursor=page2/);
});

test('sendSlackMessage resolves a #channel name through conversations.list', async () => {
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/conversations.list')) {
      return jsonResponse({ ok: true, channels: [{ id: 'C0ENG', name: 'eng', name_normalized: 'eng' }], response_metadata: { next_cursor: '' } });
    }
    return jsonResponse({ ok: true, ts: '5', channel: 'C0ENG' });
  }) as unknown as typeof fetch;

  const r = await sendSlackMessage(cfg({ channel: '#eng' }), 'team', { fetchImpl, env: ENV });
  assert.equal(r.channel, 'C0ENG');
});

test('notifySlack honours the master and per-event switches, and warns instead of throwing', async () => {
  let calls = 0;
  const ok = (async () => { calls += 1; return jsonResponse({ ok: true }); }) as unknown as typeof fetch;

  await notifySlack(cfg({ enabled: false, channel: 'C123ABC' }), { event: 'taskDone', title: 'x' }, { fetchImpl: ok, env: ENV });
  await notifySlack(cfg({ channel: 'C123ABC', events: { ...DEFAULTS.slack.events, taskDone: false } }), { event: 'taskDone', title: 'x' }, { fetchImpl: ok, env: ENV });
  assert.equal(calls, 0);

  await notifySlack(cfg({ channel: 'C123ABC' }), { event: 'taskDone', title: 'x' }, { fetchImpl: ok, env: ENV });
  assert.equal(calls, 1);

  const warnings: string[] = [];
  const bad = (async () => jsonResponse({ ok: false, error: 'channel_not_found' })) as unknown as typeof fetch;
  await notifySlack(cfg({ channel: 'C123ABC' }), { event: 'taskFailed', title: 'x' }, { fetchImpl: bad, env: ENV }, (m) => warnings.push(m));
  assert.ok(warnings.some((w) => /slack taskFailed: .*channel_not_found/.test(w)), `warnings=${warnings.join('|')}`);
});

test('sendSlackMessage rejects a missing token, an API error and a timeout', async () => {
  const ok = (async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
  await assert.rejects(sendSlackMessage(cfg({ channel: 'C123ABC' }), 'x', { fetchImpl: ok, env: {} }), /no token in SLACK_BOT_TOKEN/);

  const bad = (async () => jsonResponse({ ok: false, error: 'channel_not_found' })) as unknown as typeof fetch;
  await assert.rejects(sendSlackMessage(cfg({ channel: 'C123ABC' }), 'x', { fetchImpl: bad, env: ENV }), /chat\.postMessage failed: channel_not_found/);

  const http = (async () => jsonResponse({ error: 'not_authed' }, 401)) as unknown as typeof fetch;
  await assert.rejects(sendSlackMessage(cfg({ channel: 'C123ABC' }), 'x', { fetchImpl: http, env: ENV }), /returned 401: not_authed/);

  const abort = (async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }) as unknown as typeof fetch;
  await assert.rejects(sendSlackMessage(cfg({ channel: 'C123ABC' }), 'x', { fetchImpl: abort, env: ENV }), /timed out after 10000 ms/);
});

// Live integration test: only runs where a real token and an explicit target are provided, and never
// fails CI when the token lacks the read scopes needed to turn a name into an id. Set SLACK_API_KEY
// (a bot/user token) plus SLACK_TEST_CHANNEL (a channel id) or SLACK_TEST_USER (a user id or handle).
test('live: sends a Slack message through the real API', { timeout: 30_000 }, async (t) => {
  const apiKeyEnv = 'SLACK_API_KEY';
  if (!process.env[apiKeyEnv]) {
    t.skip(`${apiKeyEnv} is not set`);
    return;
  }
  const channel = process.env.SLACK_TEST_CHANNEL ?? '';
  const user = channel ? '' : (process.env.SLACK_TEST_USER ?? '');
  if (!channel && !user) {
    t.skip('set SLACK_TEST_CHANNEL (a channel id) or SLACK_TEST_USER (a user id or handle)');
    return;
  }
  const config: SlackConfig = { ...DEFAULTS.slack, enabled: true, apiKeyEnv, channel, user };
  try {
    const r = await sendSlackMessage(config, ':wave: symphony integration test — Slack notifications are wired up.');
    assert.ok(r.channel, 'a message should report the channel it landed in');
  } catch (e) {
    const message = (e as Error).message;
    if (/missing_scope|no user matching|no channel matching/.test(message)) {
      t.skip(`the token cannot resolve the target (${message}); use a user id or a channel id`);
      return;
    }
    throw e;
  }
});