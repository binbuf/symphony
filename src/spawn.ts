import { resolveBinary } from './util.js';

/**
 * Escaping for launching through `cmd.exe`. Ported from cross-spawn (MIT), which follows
 * <https://qntm.org/cmd>, so a Windows `.cmd`/`.bat` shim receives exactly the argv it was given.
 */
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCmdCommand(arg: string): string {
  return arg.replace(META_CHARS, '^$1');
}

export function escapeCmdArgument(arg: string, doubleEscape = false): string {
  let s = `${arg}`;
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  s = s.replace(/(?=(\\+?)?)\1$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(META_CHARS, '^$1');
  if (doubleEscape) s = s.replace(META_CHARS, '^$1');
  return s;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  /** True when the command line is already escaped for `cmd.exe` and must be passed verbatim. */
  windowsVerbatimArguments?: boolean;
}

export interface ResolveSpawnOpts {
  /** Environment used for PATH/PATHEXT lookup; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Base directory for a relative `bin` path; defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Turn a configured provider binary plus argv into something that can actually be spawned here.
 *
 * - A bare command name is resolved on PATH; an explicit path the user set (`~`, absolute, or
 *   relative to the project root) is used as-is, so a chosen install always wins.
 * - Unix runs the binary directly.
 * - Windows cannot launch a `.cmd`/`.bat` shim with `spawn` (npm installs one for most agent CLIs),
 *   so it is run through `cmd.exe` with the argv escaped for cmd. A native `.exe` runs directly.
 */
export function resolveSpawn(bin: string, args: string[], opts: ResolveSpawnOpts = {}): LaunchSpec {
  const env = opts.env ?? process.env;
  const target = resolveBinary(bin, opts);
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(target)) {
    return { command: target, args };
  }
  const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.(?:cmd|bat)$/i.test(target);
  const line = [escapeCmdCommand(target), ...args.map((a) => escapeCmdArgument(a, doubleEscape))].join(' ');
  return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}