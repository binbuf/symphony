/* Replay an NDJSON log through a provider parser: counts per event kind and parse failures.
 *   node dist/tools/parse-check.js claude path/to/session.jsonl [--render]            */
import { readFileSync } from 'node:fs';
import { getProvider } from '../providers/index.js';
import type { ProviderName } from '../providers/types.js';
import { renderEvent } from '../render.js';

const [name, file, flag] = process.argv.slice(2);
if (!name || !file) { process.stderr.write('usage: parse-check <claude|cursor|opencode|codex> <file.jsonl> [--render]\n'); process.exit(2); }
const provider = getProvider(name as ProviderName);
const parser = provider.createParser();
const counts: Record<string, number> = {};
let lines = 0;
let jsonFailures = 0;
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  lines += 1;
  const events = parser.parse(line);
  if (line.trimStart().startsWith('{') && events.some((e) => e.kind === 'raw')) jsonFailures += 1;
  for (const ev of events) {
    counts[ev.kind] = (counts[ev.kind] ?? 0) + 1;
    if (flag === '--render') { const r = renderEvent(ev, { maxChars: 200, color: false }); if (r) process.stdout.write(`${r}\n`); }
  }
}
const h = parser.hints();
process.stdout.write(`${file}: ${lines} lines, ${jsonFailures} unparsable JSON lines, events ${JSON.stringify(counts)}, api_errors ${JSON.stringify(h.apiErrorCategories)}, cost ${h.costUsd ?? '-'}\n`);
process.exit(jsonFailures ? 1 : 0);
