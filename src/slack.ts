import type { SlackConfig } from './config.js';
import { isRecord } from './util.js';

/** Lifecycle events the Slack integration can post, matching `slack.events` in the config. */
export type SlackEvent =
  | 'runStart'
  | 'taskStart'
  | 'taskSplit'
  | 'taskEscalated'
  | 'taskDone'
  | 'taskContinue'
  | 'taskFailed'
  | 'taskBlocked'
  | 'budgetClose'
  | 'budgetExceeded'
  | 'halt'
  | 'runEnd';

const API_BASE = 'https://slack.com/api';

/** A leading pictograph so a busy channel is scannable at a glance. */
const EMOJI: Record<SlackEvent, string> = {
  runStart: ':runner:',
  taskStart: ':rocket:',
  taskSplit: ':scissors:',
  taskEscalated: ':arrow_up:',
  taskDone: ':white_check_mark:',
  taskContinue: ':arrow_forward:',
  taskFailed: ':x:',
  taskBlocked: ':hand:',
  budgetClose: ':warning:',
  budgetExceeded: ':money_with_wings:',
  halt: ':octagonal_sign:',
  runEnd: ':checkered_flag:',
};

/** Upper bound on list pages walked when resolving a `#channel` or `@user` name. */
const MAX_PAGES = 20;

export interface SlackDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface SlackNotification {
  event: SlackEvent;
  /** Project label, shown as `[name]` so several repos can share one channel. Omitted when unknown. */
  project?: string;
  /** Headline, naming the task id where there is one. Rendered in Slack bold. */
  title: string;
  /** Optional detail lines (summary, provider/model, cost, …); empty lines are dropped. */
  lines?: string[];
}

/** The Slack Web API base for this config; `baseUrl` overrides the built-in one. */
export function slackBaseUrl(config: SlackConfig): string {
  return (config.baseUrl ?? API_BASE).replace(/\/+$/, '');
}

/** True when this event should post: the master switch is on and the event's own flag is set. */
export function slackEventEnabled(config: SlackConfig, event: SlackEvent): boolean {
  return config.enabled && config.events[event];
}

/** Why Slack notifications cannot run right now, or undefined when they can. Cheap: no network. */
export function slackProblem(config: SlackConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!config.enabled) return 'disabled';
  if (!config.channel && !config.user) return 'neither slack.channel nor slack.user is set';
  if (!env[config.apiKeyEnv]) return `no token in ${config.apiKeyEnv}`;
  return undefined;
}

/** The mrkdwn text posted for a notification: an emoji + bold `[project] title`, then detail lines. */
export function formatSlackMessage(n: SlackNotification): string {
  const tag = n.project ? `[${n.project}] ` : '';
  const head = `${EMOJI[n.event]} *${tag}${n.title}*`;
  const body = (n.lines ?? []).filter((l) => l.trim());
  return body.length ? `${head}\n${body.join('\n')}` : head;
}

/** One typed Slack Web API call. Throws on a transport error or an `ok: false` answer. */
async function slackApi(
  config: SlackConfig,
  token: string,
  method: string,
  params: Record<string, string | number | boolean>,
  opts: { get?: boolean; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = new URL(`${slackBaseUrl(config)}/${method}`);
  const init: RequestInit = { method: opts.get ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}` } };
  if (opts.get) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  } else {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string])).toString();
  }
  const res = await doFetch(url, { ...init, signal: opts.signal });
  const raw = await res.text();
  let json: unknown;
  try { json = JSON.parse(raw); } catch { json = undefined; }
  if (!res.ok) {
    const detail = isRecord(json) && typeof json.error === 'string' ? json.error : (raw.trim().slice(0, 200) || 'non-OK response');
    throw new Error(`slack: ${method} returned ${res.status}: ${detail}`);
  }
  if (!isRecord(json) || json.ok !== true) {
    const err = isRecord(json) && typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
    throw new Error(`slack: ${method} failed: ${err}`);
  }
  return json;
}

type SlackApi = (method: string, params: Record<string, string | number | boolean>, get?: boolean) => Promise<Record<string, unknown>>;

/** Walk a cursor-paginated list response, returning every item. Stops on a missing/empty cursor. */
async function listAll(api: SlackApi, method: string, params: Record<string, string | number | boolean>, pick: (json: Record<string, unknown>) => unknown[]): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await api(method, cursor ? { ...params, cursor } : params, true);
    out.push(...pick(json));
    const meta = isRecord(json.response_metadata) ? json.response_metadata : {};
    cursor = typeof meta.next_cursor === 'string' ? meta.next_cursor : '';
    if (!cursor) break;
  }
  return out;
}

/** Resolve `slack.user` to an id: a literal `U…`/`W…`, else a `users.list` match on the handle. */
async function resolveUserId(config: SlackConfig, api: SlackApi): Promise<string> {
  const raw = config.user.trim().replace(/^@/, '').trim();
  if (/^[UW][A-Z0-9]{2,}$/.test(raw)) return raw;
  const members = await listAll(api, 'users.list', { limit: 200 }, (j) => (Array.isArray(j.members) ? j.members : []));
  const hit = members.find((m) => isRecord(m) && (
    (typeof m.name === 'string' && m.name.toLowerCase() === raw.toLowerCase()) ||
    (isRecord(m.profile) && typeof m.profile.display_name === 'string' && m.profile.display_name.toLowerCase() === raw.toLowerCase())
  ));
  if (isRecord(hit) && typeof hit.id === 'string') return hit.id;
  throw new Error(`slack: no user matching "${config.user}" (use a user id (U…) or the @handle; resolving a handle needs the users:read scope)`);
}

/** Resolve `slack.channel` to an id: a literal `C…`/`G…`/`D…`, else a `conversations.list` name match. */
async function resolveChannelId(config: SlackConfig, api: SlackApi): Promise<string> {
  const raw = config.channel.trim().replace(/^#/, '').trim();
  if (/^[CGD][A-Z0-9]{2,}$/.test(raw)) return raw;
  const channels = await listAll(api, 'conversations.list', { limit: 200, types: 'public_channel,private_channel' }, (j) => (Array.isArray(j.channels) ? j.channels : []));
  const hit = channels.find((c) => isRecord(c) && (
    (typeof c.name_normalized === 'string' && c.name_normalized.toLowerCase() === raw.toLowerCase()) ||
    (typeof c.name === 'string' && c.name.toLowerCase() === raw.toLowerCase())
  ));
  if (isRecord(hit) && typeof hit.id === 'string') return hit.id;
  throw new Error(`slack: no channel matching "${config.channel}" (use a channel id (C…/G…/D…) or #name; resolving a name needs a channels:read scope)`);
}

/**
 * Turn the configured channel/user into the `chat.postMessage` target. A `user` alone posts to the
 * user id directly (Slack opens the DM); a `channel` posts there, and with `mention` the user id is
 * prefixed as `<@id>` so the message pings them.
 */
async function resolveSlackTarget(config: SlackConfig, api: SlackApi): Promise<{ channel: string; mention?: string }> {
  const userId = config.user.trim() ? await resolveUserId(config, api) : undefined;
  if (config.channel.trim()) {
    const channel = await resolveChannelId(config, api);
    return { channel, mention: config.mention ? userId : undefined };
  }
  if (userId) return { channel: userId };
  throw new Error('slack: no channel or user configured');
}

/**
 * Post one message through the Slack Web API. Resolves the configured target first, then calls
 * `chat.postMessage`. Throws on any failure; `notifySlack` is the fire-and-forget wrapper.
 */
export async function sendSlackMessage(config: SlackConfig, text: string, deps: SlackDeps = {}): Promise<{ channel: string; ts?: string }> {
  const env = deps.env ?? process.env;
  const token = env[config.apiKeyEnv];
  if (!token) throw new Error(`slack: no token in ${config.apiKeyEnv}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const onAbort = () => controller.abort();
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener('abort', onAbort, { once: true });
  const api: SlackApi = (method, params, get) => slackApi(config, token, method, params, { get, fetchImpl: deps.fetchImpl, signal: controller.signal });
  try {
    const target = await resolveSlackTarget(config, api);
    const body = target.mention ? `<@${target.mention}> ${text}` : text;
    const res = await api('chat.postMessage', { channel: target.channel, text: body, unfurl_links: false, unfurl_media: false });
    return { channel: target.channel, ts: typeof res.ts === 'string' ? res.ts : undefined };
  } catch (e) {
    if ((e as Error | undefined)?.name === 'AbortError') throw new Error(`slack: the request timed out after ${config.timeoutMs} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fire-and-forget lifecycle notification: a no-op when the integration or this event is off. A
 * failure (no token, unknown target, API error, timeout) only reaches `warn`, never the run.
 */
export async function notifySlack(
  config: SlackConfig,
  n: SlackNotification,
  deps: SlackDeps = {},
  warn: (m: string) => void = () => {},
): Promise<void> {
  if (!slackEventEnabled(config, n.event)) return;
  try {
    await sendSlackMessage(config, formatSlackMessage(n), deps);
  } catch (e) {
    warn(`slack ${n.event}: ${(e as Error).message}`);
  }
}