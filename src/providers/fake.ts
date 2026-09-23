import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClaudeParser } from './claude.js';
import type { Provider } from './types.js';

/**
 * Test double. Replays a Claude-format NDJSON fixture through a tiny Node script so the whole
 * pipeline (spawn, streaming, parsing, commit, retry, halt) runs without an LLM.
 *
 * Fixture directory: SYMPHONY_FAKE_FIXTURES (default <cwd>/.symphony/fixtures). Lookup order:
 *   <taskId>.<kind>.jsonl  →  <taskId>.jsonl  →  default.<kind>.jsonl  →  default.jsonl
 * where kind is task | resume | nudge | continue | escalate. Control lines the fake agent
 * interprets instead of echoing:
 *   {"type":"fake_write","path":"rel/file","content":"..."}   write a file (simulated work)
 *   {"type":"fake_rm","path":"rel/file-or-dir"}                   delete a file or directory
 *   {"type":"fake_run","command":"git checkout -b other"}      run a shell command in the project
 *   {"type":"fake_stderr","text":"..."}                        print to stderr
 *   {"type":"fake_sleep","ms":1500}                            pause
 *   {"type":"fake_exit","code":1}                              exit code at the end
 */
export const fakeProvider: Provider = {
  name: 'fake',
  supportsBudget: true,
  supportsResume: true,
  supportsVariant: false,
  buildCommand(o) {
    const dir = process.env.SYMPHONY_FAKE_FIXTURES ?? join(o.cwd, '.symphony', 'fixtures');
    const candidates = [`${o.taskId}.${o.kind}.jsonl`, `${o.taskId}.jsonl`, `default.${o.kind}.jsonl`, 'default.jsonl'];
    const fixture = candidates.map((c) => join(dir, c)).find((p) => existsSync(p)) ?? join(dir, candidates[0]);
    // Prefer the compiled script; fall back to the TypeScript source (via tsx) when running from src.
    let script = join(import.meta.dirname, 'fake-agent.js');
    const loader: string[] = [];
    if (!existsSync(script)) {
      const ts = join(import.meta.dirname, 'fake-agent.ts');
      if (existsSync(ts)) {
        script = ts;
        try { loader.push('--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href); } catch { /* let it fail loudly */ }
      }
    }
    return {
      bin: process.execPath,
      args: [...loader, script, fixture],
      stdinPayload: o.prompt,
      env: { SYMPHONY_FAKE_TASK: o.taskId, SYMPHONY_FAKE_KIND: o.kind, SYMPHONY_FAKE_RESUME: o.resumeId ?? '' },
    };
  },
  createParser: () => new ClaudeParser(),
};
