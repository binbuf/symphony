import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, type VisionConfig } from '../src/config.js';
import { describeImage, visionBaseUrl, visionCommand, visionProblem, visionPromptNote } from '../src/vision.js';

const cfg = (over: Partial<VisionConfig> = {}): VisionConfig => ({ ...DEFAULTS.vision, enabled: true, ...over });

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('visionBaseUrl defaults to OpenRouter and honours an override', () => {
  assert.equal(visionBaseUrl(DEFAULTS.vision), 'https://openrouter.ai/api');
  assert.equal(visionBaseUrl({ ...DEFAULTS.vision, baseUrl: 'https://gateway.internal/' }), 'https://gateway.internal');
});

test('visionProblem explains why the tool cannot run', () => {
  assert.equal(visionProblem({ ...DEFAULTS.vision, enabled: false }, {}), 'disabled');
  assert.match(visionProblem(cfg(), {}) ?? '', /OPENROUTER_API_KEY/);
  assert.equal(visionProblem(cfg(), { OPENROUTER_API_KEY: 'sk-or-x' }), undefined);
});

test('describeImage reads a local image into a data URL and returns the description', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-vision-'));
  const image = join(dir, 'shot.png');
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  let seen: { url: string; init: RequestInit } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init: init as RequestInit };
    return jsonResponse({
      model: 'qwen/qwen3-vl-235b-a22b-instruct',
      choices: [{ message: { role: 'assistant', content: 'A diagram of the build pipeline.' } }],
      usage: { cost: 0.0004 },
    });
  }) as unknown as typeof fetch;

  const result = await describeImage(cfg(), { image }, { fetchImpl, env: { OPENROUTER_API_KEY: 'sk-or-test' } });
  assert.equal(result.text, 'A diagram of the build pipeline.');
  assert.equal(result.model, 'qwen/qwen3-vl-235b-a22b-instruct');
  assert.equal(result.costUsd, 0.0004);
  assert.equal(seen?.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal((seen?.init.headers as Record<string, string>).Authorization, 'Bearer sk-or-test');
  const body = JSON.parse(String(seen?.init.body)) as { model: string; messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[] };
  assert.equal(body.model, 'qwen/qwen3-vl-235b-a22b-instruct');
  const parts = body.messages[0].content;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[0].text, DEFAULTS.vision.prompt);
  assert.match(parts[0].text ?? '', /salient subjects, setting, visible actions, and spatial relationships/);
  assert.match(parts[0].text ?? '', /screenshots, documents, charts, or diagrams/);
  assert.doesNotMatch(parts[0].text ?? '', /Task-specific question or context:/);
  assert.equal(parts[1].image_url?.url, `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`);
});

test('describeImage passes an http(s) URL through and honours a custom prompt', async () => {
  let body: { messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[] } | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as typeof body;
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  }) as unknown as typeof fetch;

  await describeImage(cfg(), { image: 'https://example.com/a.jpg', prompt: 'Read the error text.' }, { fetchImpl, env: { OPENROUTER_API_KEY: 'k' } });
  assert.equal(body?.messages[0].content[1].image_url?.url, 'https://example.com/a.jpg');
  assert.equal(body?.messages[0].content[0].text, 'Read the error text.');
});

test('describeImage appends additional context to the base prompt, not replaces it', async () => {
  let body: { messages: { content: { type: string; text?: string }[] }[] } | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as typeof body;
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  }) as unknown as typeof fetch;

  await describeImage(cfg(), { image: 'https://example.com/a.png', context: 'Focus on the red banner.' }, { fetchImpl, env: { OPENROUTER_API_KEY: 'k' } });
  assert.equal(body?.messages[0].content[0].text, `${DEFAULTS.vision.prompt}\n\nTask-specific question or context:\nFocus on the red banner.`);

  await describeImage(cfg(), { image: 'https://example.com/a.png', prompt: 'Transcribe the text.', context: 'Ignore the sidebar.' }, { fetchImpl, env: { OPENROUTER_API_KEY: 'k' } });
  assert.equal(body?.messages[0].content[0].text, 'Transcribe the text.\n\nTask-specific question or context:\nIgnore the sidebar.');
});

test('describeImage rejects a missing key, a missing file, an oversized image and an API error', async () => {
  const never = (async () => jsonResponse({})) as unknown as typeof fetch;
  await assert.rejects(describeImage(cfg(), { image: 'x.png' }, { fetchImpl: never, env: {} }), /no API key/);
  await assert.rejects(describeImage(cfg(), { image: join(tmpdir(), 'does-not-exist.png') }, { fetchImpl: never, env: { OPENROUTER_API_KEY: 'k' } }), /image not found/);

  const dir = mkdtempSync(join(tmpdir(), 'symphony-vision-'));
  const big = join(dir, 'big.png');
  writeFileSync(big, Buffer.alloc(2048));
  await assert.rejects(describeImage(cfg({ maxImageBytes: 1024 }), { image: big }, { fetchImpl: never, env: { OPENROUTER_API_KEY: 'k' } }), /over vision\.maxImageBytes/);

  const bad = (async () => jsonResponse({ error: { message: 'model not found' } }, 404)) as unknown as typeof fetch;
  await assert.rejects(describeImage(cfg(), { image: 'https://example.com/a.png' }, { fetchImpl: bad, env: { OPENROUTER_API_KEY: 'k' } }), /404: model not found/);
});

test('describeImage accepts a content-part array as the assistant answer', async () => {
  const fetchImpl = (async () => jsonResponse({ choices: [{ message: { content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] } }] })) as unknown as typeof fetch;
  const result = await describeImage(cfg(), { image: 'https://example.com/a.png' }, { fetchImpl, env: { OPENROUTER_API_KEY: 'k' } });
  assert.equal(result.text, 'part one\npart two');
});

test('describeImage turns an aborted request into a clear timeout error', async () => {
  const abort = (async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }) as unknown as typeof fetch;
  await assert.rejects(describeImage(cfg(), { image: 'https://example.com/a.png' }, { fetchImpl: abort, env: { OPENROUTER_API_KEY: 'k' } }), /timed out after 60000 ms/);
});

test('the prompt note names a launcher that matches the platform', () => {
  assert.equal(visionCommand(), process.platform === 'win32' ? String.raw`.\.symphony\symphony.cmd vision` : './.symphony/symphony vision');
  assert.match(visionPromptNote(), /Image analysis tool \(enabled\)/);
  assert.ok(visionPromptNote().includes(visionCommand()));
  assert.match(visionPromptNote(), /omit it when you need a general description/);
  assert.match(visionPromptNote(), /--context.*--prompt/s);
  assert.doesNotMatch(visionCommand(), /<image>/);
});
