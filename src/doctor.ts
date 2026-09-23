import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolveVerify, type Config, type SessionSpec } from './config.js';
import { dirtyFiles, gitAvailable, gitToplevel } from './git.js';
import { jevProblem } from './jev.js';
import { rel, stopPresent, type Paths } from './paths.js';
import { opencodeVersionWarning } from './providers/opencode.js';
import type { Provider } from './providers/types.js';
import { haltResumeHint, liveLock, type State } from './state.js';
import { resolveSpawn } from './spawn.js';
import { isPathLike, resolveBinary } from './util.js';

export interface Check { name: string; level: 'ok' | 'warn' | 'fail'; detail: string }

/** A provider used by some task's front matter, checked alongside the primary provider. */
export interface ExtraProvider { spec: SessionSpec; provider: Provider; label?: string }

export interface DoctorInput {
  paths: Paths;
  config: Config;
  state: State;
  spec?: SessionSpec;
  provider?: Provider;
  /** Additional providers this run will launch (per-task front matter overrides). */
  extraProviders?: ExtraProvider[];
  taskCount?: number;
  roadmapError?: string;
  /** `run --clear-halt` clears before checking. */
  ignoreHalt?: boolean;
  skipAuth?: boolean;
  /** `prepare` repairs the roadmap, so its absence is not a preflight failure there. */
  skipRoadmap?: boolean;
}

function probe(bin: string, args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): { ok: boolean; enoent: boolean; timedOut: boolean; out: string } {
  const launch = resolveSpawn(bin, args, { cwd: opts.cwd });
  const r = spawnSync(launch.command, launch.args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 15_000,
    env: process.env,
    cwd: opts.cwd,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });
  const enoent = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  const timedOut = r.error !== undefined && /ETIMEDOUT/.test(String((r.error as NodeJS.ErrnoException).code ?? ''));
  const all = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  let out = all.split('\n').filter(Boolean).slice(-1)[0] ?? '';
  try {
    const j = JSON.parse((r.stdout ?? '').trim()) as Record<string, unknown>;
    const pick = ['loggedIn', 'authenticated', 'status', 'authMethod', 'apiProvider'].filter((k) => j[k] !== undefined && typeof j[k] !== 'object');
    if (pick.length) out = pick.map((k) => `${k}=${String(j[k])}`).join(' ');
  } catch { /* not JSON */ }
  return { ok: r.status === 0, enoent, timedOut, out };
}

export function runDoctor(i: DoctorInput): Check[] {
  const checks: Check[] = [];
  const add = (name: string, level: Check['level'], detail: string) => checks.push({ name, level, detail });

  const [major, minor] = process.versions.node.split('.').map(Number);
  add('node', major > 20 || (major === 20 && minor >= 11) ? 'ok' : 'fail', `node ${process.versions.node} (need >= 20.11)`);

  if (!gitAvailable()) add('git', 'fail', 'git not found on PATH');
  else {
    const top = gitToplevel(i.paths.root);
    if (!top) add('git', 'fail', `${i.paths.root} is not inside a git repository (run git init)`);
    else if (top !== i.paths.root) add('git', 'warn', `project root is inside a repo rooted at ${top}; commits go there`);
    else add('git', 'ok', `repository at ${top}`);
    const dirty = dirtyFiles(i.paths.root);
    if (dirty.length) add('worktree', 'warn', `${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'}; the first task's commit will sweep them in`);
    else if (top) add('worktree', 'ok', 'clean');
  }

  if (i.skipRoadmap) { /* prepare fixes the roadmap itself */ }
  else if (i.roadmapError) add('roadmap', 'fail', i.roadmapError);
  else if (!existsSync(i.paths.roadmap)) add('roadmap', 'fail', `${i.paths.roadmap} missing (run: symphony init)`);
  else if (i.taskCount === 0) add('roadmap', 'warn', 'ROADMAP.md has no task bullets yet');
  else add('roadmap', 'ok', `${i.taskCount ?? '?'} task${i.taskCount === 1 ? '' : 's'}`);

  const checkProvider = (spec: SessionSpec, provider: Provider, label?: string): void => {
    const where = label ? ` (${label})` : '';
    if (provider.name === 'fake') {
      add('provider', 'ok', `fake provider (fixture replay)${where}`);
      return;
    }
    const explicit = isPathLike(spec.bin);
    const target = resolveBinary(spec.bin, { cwd: i.paths.root });
    if (explicit && !existsSync(target)) {
      add('provider', 'fail', `configured binary ${spec.bin} not found at ${target} (provider ${provider.name}${where}); fix providers.${provider.name}.bin`);
      return;
    }
    const v = probe(spec.bin, ['--version'], { cwd: i.paths.root });
    if (v.enoent) {
      if (explicit) add('provider', 'fail', `configured binary ${spec.bin} could not be launched (provider ${provider.name}${where}); check providers.${provider.name}.bin`);
      else add('provider', 'fail', `${spec.bin} not found on PATH (provider ${provider.name}${where}); set providers.${provider.name}.bin to a path to choose a specific install`);
    } else if (v.timedOut) add('provider', 'warn', `${spec.bin} --version did not answer within 15 s`);
    else {
      const at = target !== spec.bin ? ` at ${target}` : '';
      add('provider', v.ok ? 'ok' : 'warn', `${provider.name} via ${spec.bin}${at}${v.out ? ` (${v.out})` : ''} · model ${spec.model ?? 'provider default'} [${spec.sources.model}]${spec.variant ? ` · variant ${spec.variant} [${spec.sources.variant}]` : ''}${where}`);
    }
    if (provider.name === 'opencode' && v.ok) {
      const versionWarning = opencodeVersionWarning(v.out);
      if (versionWarning) add('opencode', 'warn', `${versionWarning}${where}`);
    }
    if (!v.enoent && !i.skipAuth) {
      if (provider.authCheckArgs) {
        const a = probe(spec.bin, provider.authCheckArgs, { cwd: i.paths.root });
        if (a.timedOut) add('auth', 'warn', `${spec.bin} ${provider.authCheckArgs.join(' ')} did not answer within 15 s`);
        else add('auth', a.ok ? 'ok' : 'fail', a.ok ? `authenticated${where}${a.out ? ` (${a.out.slice(0, 120)})` : ''}` : `not authenticated${where}: ${a.out || 'non-zero exit'}`);
      } else add('auth', 'warn', `${provider.name}${where}: no auth probe available; first session will tell`);
    }
  };

  if (i.spec && i.provider) {
    checkProvider(i.spec, i.provider);
    for (const extra of i.extraProviders ?? []) {
      if (extra.provider.name === i.provider.name && extra.spec.bin === i.spec.bin) continue;
      checkProvider(extra.spec, extra.provider, extra.label);
    }
    if (!i.spec.autoApprove) add('permissions', 'warn', 'safe mode: the agent may edit files but shell commands need approval nobody can give; expect blocked results');
  }

  const verify = resolveVerify(i.config, undefined, i.paths.root);
  if (verify) add('verify', 'ok', `${verify.command} [${verify.source}]`);
  else add('verify', 'warn', 'no verifyCommand and no package.json test script: a task that reports "done" is not independently checked');

  if (i.config.jev.enabled) {
    const j = i.config.jev;
    const workflows = [j.resultFallback ? 'resultFallback' : undefined, j.failureTriage ? 'failureTriage' : undefined, j.escalationDecision ? 'escalationDecision' : undefined].filter(Boolean);
    const problem = jevProblem(j, process.env);
    const detail = `Jev [${workflows.join(', ') || 'no workflows'}] via ${j.provider} · ${j.model} (key from ${j.apiKeyEnv})`;
    add('jev', problem ? 'warn' : 'ok', problem ? `Jev is on but ${problem}; run halts until this is fixed (set ${j.apiKeyEnv}, or jev.enabled=false). ${detail}` : detail);
  }

  if (stopPresent(i.paths)) add('stop', 'warn', `${rel(i.paths.root, i.paths.stop)} present; run pauses until it is removed`);
  if (i.state.halted && !i.ignoreHalt) add('halt', 'fail', `halted at ${i.state.halted.at}${i.state.halted.taskId ? ` on ${i.state.halted.taskId}` : ''} (${i.state.halted.category}): ${i.state.halted.reason}. ${haltResumeHint(i.state.halted)}`);
  const lock = liveLock(i.paths);
  if (lock) add('lock', 'fail', `another run is active (pid ${lock.pid}, since ${lock.startedAt})`);

  return checks;
}

export function formatChecks(checks: Check[]): string[] {
  const mark = { ok: '✓', warn: '!', fail: '✗' } as const;
  return checks.map((c) => `${mark[c.level]} ${c.name.padEnd(11)} ${c.detail}`);
}
