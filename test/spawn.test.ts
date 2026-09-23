import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { escapeCmdArgument, escapeCmdCommand, resolveSpawn, type LaunchSpec } from '../src/spawn.js';
import { resolveBinary } from '../src/util.js';

function runLaunch(launch: LaunchSpec): Promise<string> {
  return new Promise((res, rej) => {
    let out = '';
    let err = '';
    const c = spawn(launch.command, launch.args, { windowsVerbatimArguments: launch.windowsVerbatimArguments });
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', rej);
    c.on('close', () => res((out || err).trim()));
  });
}

test('escapeCmdArgument: quotes and caret-escapes cmd meta characters for the child', () => {
  // cmd consumes the caret but passes the quotes through, so the shim's argv parser sees them.
  assert.equal(escapeCmdArgument('json'), '^"json^"');
  assert.equal(escapeCmdArgument('hello world'), '^"hello^ world^"');
  assert.equal(escapeCmdArgument('a&b'), '^"a^&b^"');
});

test('escapeCmdCommand: caret-escapes meta characters without adding quotes', () => {
  assert.equal(escapeCmdCommand('C:\\Program Files\\a.cmd'), 'C:\\Program^ Files\\a.cmd');
});

test('resolveBinary: an explicit path wins over PATH and is made absolute', () => {
  assert.equal(resolveBinary(process.execPath), process.execPath);
  assert.equal(resolveBinary('./relative-tool', { cwd: '/proj' }), resolve('/proj', './relative-tool'));
  assert.equal(resolveBinary('~/tool'), join(homedir(), 'tool'));
  // A bare name that is not on PATH is returned unchanged so the error still names what was asked for.
  assert.equal(resolveBinary('symphony-no-such-bin-xyz'), 'symphony-no-such-bin-xyz');
});

test('resolveSpawn: a native binary is spawned directly', () => {
  const launch = resolveSpawn(process.execPath, ['--version']);
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, ['--version']);
  assert.equal(launch.windowsVerbatimArguments, undefined);
});

test('resolveSpawn: a Windows .cmd shim goes through cmd.exe and keeps argv intact', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony spawn ')); // the space exercises command/arg quoting
  writeFileSync(join(dir, 'probe.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  writeFileSync(join(dir, 'probe.cmd'), '@echo off\r\nnode "%~dp0probe.js" %*\r\n');
  const args = ['--flag', 'a b', 'amp & sand', 'paren (x) 100%', join(dir, 'prompt with spaces.md')];
  const launch = resolveSpawn(join(dir, 'probe.cmd'), args);
  assert.match(launch.command, /cmd\.exe$/i);
  assert.equal(launch.windowsVerbatimArguments, true);
  const out = await runLaunch(launch);
  assert.deepEqual(JSON.parse(out), args);
});