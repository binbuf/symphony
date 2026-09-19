export type ReportedStatus = 'done' | 'blocked' | 'failed';
export interface ResultBlock { status: ReportedStatus; summary: string }

const BLOCK_RE = /SYMPHONY_RESULT\s*([\s\S]*?)\s*END_SYMPHONY_RESULT/g;

/**
 * Find the SYMPHONY_RESULT block. Models sometimes echo the template from the prompt, so the
 * *last* block whose status is exactly one word from the allowed set wins.
 */
export function parseResultBlock(text: string | undefined): ResultBlock | undefined {
  if (!text) return undefined;
  const matches = [...text.matchAll(BLOCK_RE)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const body = matches[i][1];
    const st = /^\s*status:\s*([A-Za-z]+)\s*$/m.exec(body);
    if (!st) continue;
    const status = st[1].toLowerCase();
    if (status !== 'done' && status !== 'blocked' && status !== 'failed') continue;
    const sm = /^\s*summary:\s*(.+?)\s*$/m.exec(body);
    return { status, summary: sm ? sm[1] : '' };
  }
  return undefined;
}
