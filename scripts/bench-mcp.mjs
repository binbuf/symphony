#!/usr/bin/env node
/**
 * MCP token benchmark. Runs one trivial, no-tool task per MCP profile and reports the token usage
 * each client reports for the session, so the cost of exposing (or hiding) MCP servers can be
 * compared per client and per profile.
 *
 *   node --import tsx scripts/bench-mcp.mjs --provider claude \
 *     --profile none \
 *     --profile "ghidra=--mcp-config .symphony/mcp/ghidra.json --strict-mcp-config" \
 *     --runs 3
 *
 * A profile is `name=args`, where `args` are appended exactly as `providers.<name>.extraArgs`
 * would be (split on whitespace; no shell quoting). `--env KEY=VAL` adds an environment variable
 * to every session (e.g. OpenCode 1.x's `OPENCODE_CONFIG`). By default the task runs in a
 * throwaway directory so project-local MCP config cannot contaminate the baseline; the CLI's own
 * user/global config still applies, which is what a real harness session inherits. `--root DIR`
 * runs in a chosen directory instead. `--dry-run` prints the exact commands and runs nothing.
 *
 * What is measured is provider-reported usage only. Tool-schema bytes and exposed tool counts are
 * not visible to the harness; compare profiles per client instead.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULTS } from '../src/config.js';
import { openRunSinks } from '../src/logger.js';
import { getProvider } from '../src/providers/index.js';
import { startSession } from '../src/session.js';

const DEFAULT_PROMPT = 'Reply with exactly: OK\nDo not use any tools.';
const argv = process.argv.slice(2);

const USAGE = `Usage: npm run bench:mcp -- [options]

  --provider NAME   claude | cursor | opencode | codex | gemini | antigravity (default claude)
  --bin PATH        provider binary (default: providers.<name>.bin)
  --model ID        model to run (default: the CLI's own default)
  --variant V       reasoning effort, where the provider has one
  --profile NAME=ARGS   MCP profile; ARGS land on the CLI like extraArgs (repeatable; default none)
  --env KEY=VAL     environment variable for every session (repeatable; e.g. OPENCODE_CONFIG)
  --runs N          sessions per profile (default 1)
  --timeout-min N   wall clock per session (default 10)
  --prompt TEXT     override the trivial task prompt
  --root DIR        run in DIR instead of a throwaway directory
  --dry-run         print the exact commands; run nothing
  --json            print raw rows instead of the table

The task is "reply OK, use no tools": it measures the fixed per-session MCP overhead each client
reports. Token usage comes from the provider's own stream; clients that report none stay blank.`;

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const die = (msg) => { process.stderr.write(`${msg}\n`); process.exit(2); };
const has = (flag) => argv.includes(flag);
function take(flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(`${flag} needs a value`);
  return v;
}
function takeAll(flag) {
  const out = [];
  argv.forEach((a, i) => { if (a === flag && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]); });
  return out;
}

const providerName = take('--provider', 'claude');
if (!Object.hasOwn(DEFAULTS.providers, providerName)) die(`--provider must be one of ${Object.keys(DEFAULTS.providers).join(', ')}`);
if (providerName === 'fake') die('the fake provider spends nothing; bench a real client');
const provider = getProvider(providerName);
const bin = take('--bin', DEFAULTS.providers[providerName].bin);
const model = take('--model', undefined);
const variant = take('--variant', undefined);
const runs = Math.max(1, Number(take('--runs', '1')) || 1);
const timeoutMin = Math.max(1, Number(take('--timeout-min', '10')) || 10);
const prompt = take('--prompt', DEFAULT_PROMPT);
const asJson = has('--json');
const dryRun = has('--dry-run');
const rootArg = take('--root', undefined);
const cwd = rootArg ? resolve(rootArg) : mkdtempSync(join(tmpdir(), 'symphony-bench-'));

const env = {};
for (const pair of takeAll('--env')) {
  const i = pair.indexOf('=');
  if (i <= 0) die(`--env expects KEY=VAL, got ${JSON.stringify(pair)}`);
  env[pair.slice(0, i)] = pair.slice(i + 1);
}

const rawProfiles = takeAll('--profile');
if (!rawProfiles.length) rawProfiles.push('none');
const profiles = rawProfiles.map((value) => {
  const i = value.indexOf('=');
  const name = i === -1 ? value : value.slice(0, i);
  const args = i === -1 ? [] : value.slice(i + 1).split(/\s+/).filter(Boolean);
  return { name, args };
});

const promptFile = join(cwd, 'bench.prompt.md');
writeFileSync(promptFile, prompt);

function describe(args) {
  return [bin, ...args].map((a) => (a.length > 80 ? `<${Buffer.byteLength(a, 'utf8')} bytes>` : /[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

async function runOnce(profile, run) {
  const sinks = openRunSinks(join(cwd, '.bench'), `${providerName}-${profile.name}-${run}`);
  writeFileSync(sinks.promptPath, prompt);
  const spec = provider.buildCommand({
    bin, prompt, promptFile: sinks.promptPath, taskId: 'BENCH', attempt: 1, kind: 'task',
    model, variant, autoApprove: true, extraArgs: profile.args, cwd,
  });
  if (Object.keys(env).length) spec.env = { ...(spec.env ?? {}), ...env };
  const started = Date.now();
  const outcome = dryRun
    ? undefined
    : await (async () => {
        const session = startSession({
          spec, provider, cwd, timeoutMs: timeoutMin * 60_000, idleTimeoutMs: 0, sinks,
          liveMaxChars: 400, logMaxChars: 4000, color: false, live: false,
        });
        return session.done;
      })();
  await sinks.close();
  return {
    profile: profile.name,
    run,
    command: describe(spec.args),
    status: dryRun ? 'dry-run' : outcome.result.ok ? 'ok' : outcome.result.errorSubtype ?? 'error',
    usage: outcome?.usage,
    costUsd: outcome?.costUsd,
    durationS: Math.round((Date.now() - started) / 1000),
    sessionId: outcome?.sessionId,
  };
}

const num = (n) => (n === undefined ? '-' : String(n));
const rows = [];
for (const profile of profiles) {
  for (let run = 1; run <= runs; run++) {
    process.stderr.write(`[bench] ${providerName} · profile ${profile.name} · run ${run}/${runs}\n`);
    rows.push(await runOnce(profile, run));
  }
}

if (asJson || dryRun) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  process.exit(0);
}

const head = ['profile', 'run', 'status', 'input', 'cached', 'output', 'reasoning', 'total', 'cost', 'dur'];
const cells = rows.map((r) => [
  r.profile, String(r.run), r.status,
  num(r.usage?.inputTokens), num(r.usage?.cachedInputTokens), num(r.usage?.outputTokens),
  num(r.usage?.reasoningTokens), num(r.usage?.totalTokens),
  r.costUsd === undefined ? '-' : `$${r.costUsd.toFixed(4)}`, `${r.durationS}s`,
]);
const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
process.stdout.write(`${head.map((h, i) => h.padEnd(widths[i])).join('  ')}\n`);
process.stdout.write(`${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
for (const c of cells) process.stdout.write(`${c.map((v, i) => v.padEnd(widths[i])).join('  ')}\n`);

const measured = rows.filter((r) => r.usage?.inputTokens !== undefined);
if (!measured.length) {
  process.stdout.write('\nNo token usage was reported. This client/stream does not expose it (or the session failed before a result).\n');
} else {
  process.stdout.write('\nprofile averages (sessions reporting input tokens)\n');
  const byProfile = new Map();
  for (const r of measured) {
    const agg = byProfile.get(r.profile) ?? { n: 0, input: 0, cached: 0, output: 0 };
    agg.n += 1;
    agg.input += r.usage.inputTokens;
    agg.cached += r.usage.cachedInputTokens ?? 0;
    agg.output += r.usage.outputTokens ?? 0;
    byProfile.set(r.profile, agg);
  }
  for (const [name, a] of byProfile) {
    process.stdout.write(`${name.padEnd(widths[0])}  n=${a.n}  input=${Math.round(a.input / a.n)}  cached=${Math.round(a.cached / a.n)}  output=${Math.round(a.output / a.n)}\n`);
  }
}
process.stdout.write(`\nraw session logs: ${join(cwd, '.bench')}\n`);