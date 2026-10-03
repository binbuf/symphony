import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { docsContract } from '../src/contract.js';
import type { LintReport } from '../src/lint.js';
import { resolvePaths, type Paths } from '../src/paths.js';
import { buildContinuePrompt, buildNudgePrompt, buildResumePrompt, buildTaskPrompt, buildWrapUpPrompt, taskFileBody, type PromptCtx } from '../src/prompt.js';
import { buildPreparePrompt } from '../src/prepare.js';
import type { RunContext } from '../src/runner.js';
import type { State } from '../src/state.js';
import type { Task } from '../src/tasks.js';
import { visionPromptNote } from '../src/vision.js';

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
    providerName: 'claude', model: 'opus', maxProgressBytes: 0, designDocs: true,
  };
  const noFile: PromptCtx = { ...base, task: t2, attempt: 1, continuation: 2, model: undefined, designDocs: false };
  return { paths, ctx: base, noFile };
}

test('buildTaskPrompt points at files by path and inlines only the task by default', () => {
  const { paths, ctx, noFile } = fixture();
  const text = buildTaskPrompt(ctx);
  assert.doesNotMatch(text, PLACEHOLDER);
  assert.match(text, /Task: T01 — First task/);
  assert.match(text, /## Where things are/);
  assert.match(text, /## How to work/);
  assert.match(text, /SYMPHONY_RESULT/);
  assert.match(text, /--- TASK FILE \(docs\/tasks\/01-first\.md\) ---/);
  assert.match(text, /## Goal\nDo it\./);
  // Lean default: the main docs are named by path, not pasted in.
  assert.match(text, /docs\/PROGRESS\.md/);
  assert.match(text, /docs\/design/);
  assert.match(text, /docs\/design\/adr/);
  assert.match(text, /docs\/INDEX\.md/);
  assert.doesNotMatch(text, /--- PROGRESS \(docs\/PROGRESS\.md\) ---/);
  assert.doesNotMatch(text, /--- DESIGN DOCS NAMED BY THIS TASK ---/);
  assert.doesNotMatch(text, /--- PROJECT INDEX \(docs\/INDEX\.md\) ---/);
  assert.doesNotMatch(text, /Key facts \(maintained by symphony/);

  const noTask = buildTaskPrompt(noFile);
  assert.doesNotMatch(noTask, PLACEHOLDER);
  assert.match(noTask, /Task file: \(none\)/);
  assert.match(noTask, /create docs\/tasks\/02-second-task\.md/);
  assert.match(noTask, /\(no task file — the roadmap bullet is the whole task/);
  void paths;
});

test('taskFileBody tolerates a task file that has disappeared, so the run fails cleanly', () => {
  const { ctx } = fixture();
  const gone: Task = { ...ctx.task, taskFile: join(ctx.paths.root, 'docs', 'tasks', 'missing.md'), taskFileRel: 'docs/tasks/missing.md' };
  assert.equal(taskFileBody(gone), undefined);
  assert.doesNotThrow(() => taskFileBody(gone, 100));
  // The prompt falls back to the roadmap bullet instead of throwing an ENOENT.
  const text = buildTaskPrompt({ ...ctx, task: gone });
  assert.doesNotMatch(text, PLACEHOLDER);
  assert.match(text, /\(no task file — the roadmap bullet is the whole task/);
});

test('the full profile inlines PROGRESS, the named design docs and the index', () => {
  const { ctx } = fixture();
  writeFileSync(ctx.paths.progress, '# Progress\n\n' + Array.from({ length: 5 }, (_, i) => `## T0${i + 1}\n- fact ${i + 1}`).join('\n\n'));
  const text = buildTaskPrompt({ ...ctx, maxProgressBytes: 4096, inlineDesignDocs: true, maxIndexBytes: 16384 });
  assert.match(text, /--- PROGRESS \(docs\/PROGRESS\.md\) ---/);
  assert.match(text, /Key facts \(maintained by symphony/);
  assert.match(text, /--- DESIGN DOCS NAMED BY THIS TASK ---/);
  assert.match(text, /### docs\/design\/overview\.md/);
  assert.match(text, /--- PROJECT INDEX \(docs\/INDEX\.md\) ---/);
  assert.ok(text.trimEnd().endsWith('END_SYMPHONY_RESULT'), 'the result contract follows all context');
});

test('execution rules remain bounded as the roadmap grows', () => {
  const { ctx } = fixture();
  const small = buildTaskPrompt(ctx);
  const tasks = Array.from({ length: 2000 }, (_, i) => ({ ...ctx.task, id: `T${i + 1}`, order: i }));
  const state: State = { version: 1, tasks: Object.fromEntries(tasks.map((t) => [t.id, { ...ctx.state.tasks.T01, status: 'done' }])) };
  const large = buildTaskPrompt({ ...ctx, tasks, state });
  assert.match(large, /Progress: 2000 completed/);
  assert.doesNotMatch(large, /T1999/);
  assert.ok(Buffer.byteLength(large) - Buffer.byteLength(small) < 100);
  assert.ok(Buffer.byteLength(small) < 4000, 'keep the baseline execution contract compact');
});

test('fresh continuations retain execution rules without pasting context again', () => {
  const { ctx } = fixture();
  const text = buildContinuePrompt({ ...ctx, continuation: 2, lastError: 'verify failed', maxProgressBytes: 4096, maxIndexBytes: 4096, inlineDesignDocs: true });
  assert.match(text, /Continuation 2 of T01/);
  assert.match(text, /verify failed/);
  assert.match(text, /Never push, switch branches/);
  assert.match(text, /Update affected docs/);
  assert.match(text, /Run the acceptance checks/);
  assert.match(text, /Write your reusable facts .* docs\/progress\/T01\.md/s);
  assert.doesNotMatch(text, /--- TASK FILE|--- PROGRESS|--- DESIGN DOCS|--- PROJECT INDEX/);
  assert.ok(text.trimEnd().endsWith('END_SYMPHONY_RESULT'));
  assert.doesNotMatch(buildTaskPrompt({ ...ctx, designDocs: false }).split('--- TASK FILE')[0], /docs\/design/);
});

test('dry-run and saved index obey the same cap, including omission notices', () => {
  const { ctx } = fixture();
  const index = '# Project index\n' + '- `src/app.ts` — 描述 🥭\n'.repeat(300);
  writeFileSync(ctx.paths.index, index);
  const disk = buildTaskPrompt({ ...ctx, maxIndexBytes: 512 });
  const preview = buildTaskPrompt({ ...ctx, maxIndexBytes: 512, indexBody: index });
  assert.equal(preview, disk);
  const body = /--- PROJECT INDEX \([^\n]+\) ---\n([\s\S]*?)\n--- END PROJECT INDEX ---/.exec(preview)![1];
  assert.ok(Buffer.byteLength(body) <= 512);
  assert.match(body, /read docs\/INDEX.md/);
  assert.doesNotMatch(body, /�/);
});

test('task budget includes the full-file warning and preserves Unicode boundaries', () => {
  const { ctx } = fixture();
  writeFileSync(ctx.task.taskFile!, '# Goal\n' + '描述 🥭'.repeat(300));
  const body = taskFileBody(ctx.task, 256)!;
  assert.ok(Buffer.byteLength(body) <= 256);
  assert.doesNotMatch(body, /�/);
  assert.match(body, /read docs\/tasks\/01-first.md for the full text before implementing/);
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

test('buildWrapUpPrompt closes the task out, with context only for a fresh session', () => {
  const { ctx } = fixture();
  const resumed = buildWrapUpPrompt(ctx, { resumed: true, verify: { command: 'npm run build' } });
  assert.doesNotMatch(resumed, PLACEHOLDER);
  assert.match(resumed, /close-out turn/);
  assert.match(resumed, /You have been resumed with the full context/);
  assert.match(resumed, /`npm run build`/, 'the verify command is named as the build check');
  assert.match(resumed, /docs\/PROGRESS\.md/);
  assert.match(resumed, /docs\/tasks\/01-first\.md/);
  assert.match(resumed, /SYMPHONY_RESULT/);
  assert.match(resumed, /SYMPHONY_RESULT[\s\S]*END_SYMPHONY_RESULT/, 'the result block is present');
  assert.doesNotMatch(resumed, /## Context for this fresh session/, 'a resumed session needs no inlined context');

  const fresh = buildWrapUpPrompt(ctx, { resumed: false });
  assert.doesNotMatch(fresh, PLACEHOLDER);
  assert.match(fresh, /This is a fresh session/);
  assert.match(fresh, /## Goal\nDo it\./, 'the task file is inlined for a fresh close-out');
  assert.match(fresh, /--- PROGRESS \(docs\/PROGRESS\.md\) ---/);
  assert.match(fresh, /the project's build\/test command/, 'no verify command means a generic build hint');
  assert.ok(fresh.indexOf('--- END PROGRESS ---') < fresh.indexOf('Do only this'), 'context precedes the instructions');
});

test('a very large task file is truncated with a pointer to the full path', () => {
  const { ctx } = fixture();
  writeFileSync(ctx.task.taskFile!, '# T01 — First task\n\n## Goal\n' + 'x'.repeat(4000) + '\n');
  const text = buildTaskPrompt({ ...ctx, maxTaskBytes: 200 });
  assert.match(text, /task file truncated: showing the first/);
  assert.match(text, /read docs\/tasks\/01-first\.md for the full text/);
  assert.ok(!text.includes('x'.repeat(500)), 'the body tail should not be inlined');
});

test('an explicit indexBody is inlined instead of the on-disk INDEX.md in the full profile', () => {
  const { ctx } = fixture();
  const text = buildTaskPrompt({ ...ctx, maxIndexBytes: 16384, indexBody: '# Project index\n\n## Source map\n- `src/app.ts` — main' });
  assert.match(text, /--- PROJECT INDEX \(docs\/INDEX\.md\) ---/);
  assert.match(text, /src\/app\.ts/);
  assert.doesNotMatch(text, /not generated yet/);
});

test('enabled vision is discoverable in every task prompt without displacing the final result block', () => {
  const { ctx } = fixture();
  const note = visionPromptNote();
  assert.doesNotMatch(buildTaskPrompt(ctx), /Image analysis tool/);
  const task = buildTaskPrompt({ ...ctx, visionNote: note });
  assert.match(task, /## Image analysis tool \(enabled\)/);
  assert.ok(task.indexOf('Attempt:') < task.indexOf('## Image analysis tool'));
  assert.ok(task.indexOf('## Image analysis tool') < task.indexOf('## Where things are'));
  for (const prompt of [
    buildContinuePrompt({ ...ctx, visionNote: note }),
    buildNudgePrompt({ ...ctx, visionNote: note }, 'Keep the visual regression result'),
    buildResumePrompt({ ...ctx, visionNote: note }, 'boom'),
  ]) {
    assert.match(prompt, /## Image analysis tool \(enabled\)/);
    assert.ok(prompt.indexOf('## Image analysis tool') < prompt.search(/SYMPHONY_RESULT\r?\nstatus:/), 'tool instructions precede the result format');
    assert.ok(prompt.trimEnd().endsWith('END_SYMPHONY_RESULT'), 'the result block remains the last instruction');
  }
});

test('the generated operating frame reaches nudge and resume sessions, before the result format', () => {
  const { ctx } = fixture();
  const frame = '## Operating frame (generated by symphony — do not edit)\n\n- Blocking now: waiting on prerequisite T02.';
  for (const prompt of [
    buildNudgePrompt({ ...ctx, operatingFrame: frame }, 'Keep going'),
    buildResumePrompt({ ...ctx, operatingFrame: frame }, 'boom'),
  ]) {
    assert.match(prompt, /## Operating frame \(generated by symphony/);
    assert.ok(prompt.indexOf('## Operating frame') < prompt.search(/SYMPHONY_RESULT\r?\nstatus:/), 'the frame precedes the result format');
    assert.ok(prompt.trimEnd().endsWith('END_SYMPHONY_RESULT'));
  }
});
