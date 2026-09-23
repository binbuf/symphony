import { appendFileSync, createWriteStream, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureDir, fmtTime } from './util.js';

export interface Logger {
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
  /** Stdout only, no timestamp (tables, prompts). */
  plain(m: string): void;
  banner(title: string, lines: string[]): void;
}

const COLORS = { INFO: '\x1b[2m', WARN: '\x1b[33m', ERROR: '\x1b[31m' } as const;

/** Harness events go to stdout and, when `file` is set, are appended to symphony.log. */
export function createLogger(file?: string, color = process.stdout.isTTY === true): Logger {
  if (file) ensureDir(dirname(file));
  const write = (level: keyof typeof COLORS, m: string) => {
    const ts = fmtTime();
    const head = color ? `${COLORS[level]}${ts} ${level}\x1b[0m` : `${ts} ${level}`;
    process.stdout.write(`${head} ${m}\n`);
    if (file) { try { appendFileSync(file, `${ts} ${level} ${m}\n`); } catch { /* logging must never crash the run */ } }
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    plain: (m) => process.stdout.write(`${m}\n`),
    banner: (title, lines) => {
      const width = Math.max(title.length, ...lines.map((l) => l.length)) + 4;
      const bar = '═'.repeat(width);
      const body = [bar, `  ${title}`, ...lines.map((l) => `  ${l}`), bar].join('\n');
      process.stdout.write(`${color ? '\x1b[1;31m' : ''}${body}${color ? '\x1b[0m' : ''}\n`);
      if (file) { try { appendFileSync(file, `${fmtTime()} HALT ${title} | ${lines.join(' | ')}\n`); } catch { /* ignore */ } }
    },
  };
}

export interface RunSinks {
  base: string;
  jsonlPath: string;
  logPath: string;
  promptPath: string;
  jsonl: WriteStream;
  log: WriteStream;
  close(): Promise<void>;
}

/** Per-session files: raw NDJSON, rendered log, and the prompt that was sent. */
export function openRunSinks(runsDir: string, base: string): RunSinks {
  ensureDir(runsDir);
  const jsonlPath = join(runsDir, `${base}.jsonl`);
  const logPath = join(runsDir, `${base}.log`);
  const promptPath = join(runsDir, `${base}.prompt.md`);
  const jsonl = createWriteStream(jsonlPath, { flags: 'a' });
  const log = createWriteStream(logPath, { flags: 'a' });
  const end = (s: WriteStream) => new Promise<void>((res) => { if (s.closed || s.destroyed) return res(); s.end(() => res()); });
  return { base, jsonlPath, logPath, promptPath, jsonl, log, close: async () => { await Promise.all([end(jsonl), end(log)]); } };
}
