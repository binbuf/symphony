import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { JevProviderName, VisionConfig } from './config.js';
import { UsageError, isRecord } from './util.js';

/** Base URL per built-in router; `vision.baseUrl` overrides it. */
const BASE_URLS: Record<JevProviderName, string> = {
  openrouter: 'https://openrouter.ai/api',
};

/** Extension → MIME type for the image formats the chat-completions API accepts. */
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

export interface VisionDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface VisionInput {
  /** A local image path (resolved against `cwd`), or an http(s) URL passed straight through. */
  image: string;
  /** Instruction sent with the image; falls back to `config.prompt`. */
  prompt?: string;
  /** Extra context appended to the base instruction (whatever `prompt` selected). */
  context?: string;
  /** Override the MIME type inferred from the file extension. */
  mime?: string;
  /** Directory a relative `image` path resolves against. Defaults to the process cwd. */
  cwd?: string;
}

export interface VisionResult {
  text: string;
  /** The dated model that served the request, when the response names one. */
  model?: string;
  /** What the call cost, from the response's usage block. */
  costUsd?: number;
}

export function visionBaseUrl(config: VisionConfig): string {
  return (config.baseUrl ?? BASE_URLS[config.provider]).replace(/\/+$/, '');
}

/** Why the vision tool cannot run right now, or undefined when it can. Cheap: no network. */
export function visionProblem(config: VisionConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!config.enabled) return 'disabled';
  if (!config.model.trim()) return 'vision.model is empty';
  if (!env[config.apiKeyEnv]) return `no API key in ${config.apiKeyEnv}`;
  return undefined;
}

/** The image as a chat-completions `image_url` URL: passthrough for http(s), else a base64 data URL. */
function imageUrl(config: VisionConfig, input: VisionInput): string {
  if (/^https?:\/\//i.test(input.image)) return input.image;
  const path = resolve(input.cwd ?? process.cwd(), input.image);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new UsageError(`vision: image not found: ${path}`);
  }
  if (size > config.maxImageBytes) {
    const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;
    throw new UsageError(`vision: ${path} is ${mb(size)}, over vision.maxImageBytes (${mb(config.maxImageBytes)}); shrink it or raise the limit`);
  }
  const mime = input.mime ?? MIME_TYPES[extname(path).toLowerCase()] ?? 'image/png';
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

/** Pull the assistant text out of a chat-completions response (string or content-part array). */
function readText(json: unknown): string | undefined {
  if (!isRecord(json) || !Array.isArray(json.choices)) return undefined;
  const first = json.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  const content = first.message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : undefined))
      .filter((t): t is string => t !== undefined);
    if (parts.length) return parts.join('\n').trim();
  }
  return undefined;
}

/**
 * Send one image to the configured vision model and return its text description. Unlike the Jev
 * calls this one throws on failure, because a task is actively waiting on the answer rather than
 * falling back to a deterministic path.
 */
export async function describeImage(config: VisionConfig, input: VisionInput, deps: VisionDeps = {}): Promise<VisionResult> {
  const env = deps.env ?? process.env;
  const key = env[config.apiKeyEnv];
  if (!config.enabled) throw new UsageError('vision: the vision tool is disabled (set vision.enabled in .symphony/symphony.config.json)');
  if (!key) throw new UsageError(`vision: no API key in ${config.apiKeyEnv}`);

  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const onAbort = () => controller.abort();
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener('abort', onAbort, { once: true });

  const base = input.prompt?.trim() || config.prompt;
  const context = input.context?.trim();
  const text = context ? `${base}\n\n${context}` : base;
  try {
    const res = await doFetch(`${visionBaseUrl(config)}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: imageUrl(config, input) } },
          ],
        }],
      }),
      signal: controller.signal,
    });
    const raw = await res.text();
    let json: unknown;
    try { json = JSON.parse(raw); } catch { json = undefined; }
    if (!res.ok) {
      const detail = isRecord(json) && isRecord(json.error) && typeof json.error.message === 'string' ? json.error.message : (raw.trim().slice(0, 300) || 'non-OK response');
      throw new Error(`vision: ${config.provider} returned ${res.status}: ${detail}`);
    }
    const described = readText(json);
    if (!described) throw new Error(`vision: ${config.provider} returned no description${raw.trim() ? `: ${raw.trim().slice(0, 300)}` : ''}`);
    const model = isRecord(json) && typeof json.model === 'string' ? json.model : undefined;
    const costUsd = isRecord(json) && isRecord(json.usage) && typeof json.usage.cost === 'number' ? json.usage.cost : undefined;
    return { text: described, model, costUsd };
  } catch (e) {
    if ((e as Error | undefined)?.name === 'AbortError') throw new Error(`vision: the request timed out after ${config.timeoutMs} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * The launcher to name in a prompt, so a task session can invoke the tool from the project root.
 * Built with `String.raw` so the Windows backslashes survive as written.
 */
export function visionCommand(): string {
  const launcher = process.platform === 'win32' ? String.raw`.\.symphony\symphony.cmd` : './.symphony/symphony';
  return `${launcher} vision <image>`;
}

/**
 * One line added to a task prompt when the vision tool is enabled, so the session knows it can look
 * at an image rather than guessing from context. Kept to a single sentence on purpose.
 */
export function visionPromptNote(): string {
  return `Image analysis is available: if you ever need to read or analyze an image (a screenshot you capture, a photo, a diagram, chart or mockup), save it to a file and run \`${visionCommand()}\` — it sends the image to a vision model and prints a text description you can use. Add \`--context "<what you are looking for>"\` to focus the description.`;
}