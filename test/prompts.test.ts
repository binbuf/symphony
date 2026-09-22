import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { docsContract } from '../src/contract.js';
import type { LintReport } from '../src/lint.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import { buildTaskPrompt, type PromptCtx } from '../src/prompt.js';
import { buildPreparePrompt } from '../src/prepare.js';
import type { RunContext } from '../src/runner.js';
import type { State } from '../src/state.js';
import type { Task } from '../src/tasks.js';

const PLACEHOLDER = /\{[a-zA-Z_]\w*\}/;

function fixture(): { paths: Paths; ctx: PromptCtx; noFile: PromptCtx } {
  const root = mkdtempSync(join(tmpdir(), 'symphony-prompts-'));
  mkdirSync(join(root, 'docs', 'tasks'), { recursive: true });
  mkdirSync(join(root, 'docs', 'design', 'adr'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ROADMAP.md'), '# Roadmap\n\n## Phase 1\n- [ ] T01 — First task → [tasks/01-first.md](tasks/01-first.md)\n');
  writeFileSync(join(root, 'docs', 'PROGRESS.md'), '# Progress notes\n\n## T01 — First task\nDid the thing.\n');
  writeFileSync(join(root, 'docs', 'tasks', '01-first.md'), '---\nprovider: claude\n---\n# T01 — First task\n\n## Goal\nDo it.\n\n## Context (read first)\n- `docs/design/overview.md` — the design this implements\n');
  writeFileSync(join(root, 'docs', 'design', 'overview.md'), '# Overview\n');
  writeFileSync(join(root, 'docs', 'design', 'adr', '0001-choice.md'), '# 0001 — Choice\n');

  const paths = resolvePaths(root);
  const t1: Task = {
    id: 'T01', num: 1, title: 'First task', phase: 'Phase 1', order: 0,
    taskFile: join(root, 'docs', 'tasks', '01-first.md'), taskFileRel: 'docs/tasks/01-first.md', meta: { provider: 'claude' },
  };
  const t2: Task = { id: 'T02', num: 2, title: 'Second task', phase: 'Phase 1', order: 1, meta: {} };
  const state: State = {
    version: 1,
    tasks: {
      T01: { title: 'First task', status: 'done', attempts: 1, durationS: 1, logs: [] },
      T02: { title: 'Second task', status: 'blocked', attempts: 1, durationS: 1, logs: [] },
      T03: { title: 'Third task', status: 'failed', attempts: 1, durationS: 1, logs: [] },
    },
  };
  const base: PromptCtx = {
    paths, task: t1, tasks: [t1, t2], state, attempt: 2, continuation: 0,
    providerName: 'claude', model: 'opus', maxProgressBytes: 4096, designDocs: true,
  };
  const noFile: PromptCtx = { ...base, task: t2, attempt: 1, continuation: 2, model: undefined, designDocs: false };
  return { paths, ctx: base, noFile };
}

test('buildTaskPrompt renders from the template with no leftover placeholders', () => {
  const { paths, ctx, noFile } = fixture();
  const text = buildTaskPrompt(ctx);
  assert.doesNotMatch(text, PLACEHOLDER);
  assert.match(text, /Task: T01 — First task/);
  assert.match(text, /## The planning contract/);
  assert.match(text, /## How to work/);
  assert.match(text, /SYMPHONY_RESULT/);
  assert.match(text, /--- PROGRESS \(docs\/PROGRESS\.md\) ---/);
  assert.match(text, /--- TASK FILE \(docs\/tasks\/01-first\.md\) ---/);
  assert.match(text, /## Goal\nDo it\./);
  // The design doc the task names is inlined, and the generated index is included.
  assert.match(text, /--- DESIGN DOCS NAMED BY THIS TASK ---/);
  assert.match(text, /### docs\/design\/overview\.md/);
  assert.match(text, /--- PROJECT INDEX \(docs\/INDEX\.md\) ---/);
  assert.match(text, /Key facts \(maintained by symphony/);

  const noTask = buildTaskPrompt(noFile);
  assert.doesNotMatch(noTask, PLACEHOLDER);
  assert.match(noTask, /Task file: \(none\)/);
  assert.match(noTask, /create docs\/tasks\/02-second-task\.md/);
  assert.match(noTask, /\(no task file — the roadmap bullet is the whole task/);
  assert.doesNotMatch(noTask, /Design docs present:/);
  void paths;
});

test('docsContract renders the numbered rules, with design rules only when enabled', () => {
  const { paths } = fixture();
  const withDesign = docsContract(paths);
  assert.doesNotMatch(withDesign, PLACEHOLDER);
  assert.match(withDesign, /^1\. docs\/ROADMAP\.md/m);
  assert.match(withDesign, /symphony:status/);
  assert.match(withDesign, /docs\/design\/adr\/NNNN-<slug>\.md/);
  assert.match(withDesign, /^7\. \.gitignore for the target repo/m);

  const noDesign = docsContract(paths, { design: false });
  assert.doesNotMatch(noDesign, PLACEHOLDER);
  assert.doesNotMatch(noDesign, /design\/adr/);
  assert.match(noDesign, /^5\. \.gitignore for the target repo/m);
});

test('buildPreparePrompt renders from the template with no leftover placeholders', () => {
  const { paths } = fixture();
  const ctx = { paths, config: { designDocs: true } } as unknown as RunContext;
  const report = { findings: [{ level: 'warn', code: 'x', message: 'm' }], candidates: ['notes/idea.md'] } as unknown as LintReport;
  const text = buildPreparePrompt(ctx, report);
  assert.doesNotMatch(text, PLACEHOLDER);
  assert.match(text, /## Required layout and formats/);
  assert.match(text, /## Rules/);
  assert.match(text, /- notes\/idea\.md/);
  assert.match(text, /SYMPHONY_RESULT/);
});

test('a very large task file is truncated with a pointer to the full path', () => {
  const { ctx } = fixture();
  writeFileSync(ctx.task.taskFile!, '# T01 — First task\n\n## Goal\n' + 'x'.repeat(4000) + '\n');
  const text = buildTaskPrompt({ ...ctx, maxTaskBytes: 200 });
  assert.match(text, /task file truncated: showing the first/);
  assert.match(text, /read docs\/tasks\/01-first\.md for the full text/);
  assert.ok(!text.includes('x'.repeat(500)), 'the body tail should not be inlined');
});

test('an explicit indexBody is inlined instead of the on-disk INDEX.md', () => {
  const { ctx } = fixture();
  const text = buildTaskPrompt({ ...ctx, indexBody: '# Project index\n\n## Source map\n- `src/app.ts` — main' });
  assert.match(text, /--- PROJECT INDEX \(docs\/INDEX\.md\) ---/);
  assert.match(text, /src\/app\.ts/);
  assert.doesNotMatch(text, /not generated yet/);
});
