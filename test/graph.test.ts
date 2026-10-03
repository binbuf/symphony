import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkAutoCreatedTasks, contractsFor, dependencyClosure, findDuplicateTask, isLandedSubset, parseAcceptance,
  parseContract, splitDepth, summarizeAcceptance, topoOrder, validateContracts,
} from '../src/graph.js';
import type { Task } from '../src/tasks.js';

const task = (id: string, meta: Record<string, string> = {}): Task => ({
  id, num: Number(id.slice(1)), title: id, phase: 'P', order: 0, meta,
});

const named = (id: string, title: string, meta: Record<string, string> = {}): Task => ({
  ...task(id, meta), title,
});

test('parseAcceptance defaults to blocking and understands deferrable tags', () => {
  const body = [
    '## Done when',
    '- [x] core lands',
    '- [ ] docs [blocking]',
    '- [ ] telemetry [deferrable]',
    '- [ ] sfx hook [deferrable: unity-audio]',
    '- [ ] diagram (deferrable: renderer)',
  ].join('\n');
  const items = parseAcceptance(body);
  assert.deepEqual(items.map((i) => [i.checked, i.blocking, i.capability]), [
    [true, true, undefined],
    [false, true, undefined],
    [false, false, undefined],
    [false, false, 'unity-audio'],
    [false, false, 'renderer'],
  ]);
  assert.equal(items[3].text, 'sfx hook');
});

test('parseContract reads dependsOn/blockedBy and blocks aliases', () => {
  assert.deepEqual(parseContract({ dependsOn: 'T03, T04 T05' }, '').dependsOn, ['T03', 'T04', 'T05']);
  assert.deepEqual(parseContract({ blockedBy: 'T02' }, '').dependsOn, ['T02']);
  assert.deepEqual(parseContract({ blocks: 'T07, T08' }, '').blocks, ['T07', 'T08']);
});

test('contractsFor folds blocks edges into the blocked task dependsOn', () => {
  const tasks = [task('T05', { blocks: 'T07' }), task('T07')];
  const c = contractsFor(tasks, new Map());
  assert.deepEqual(c.get('T05')?.blocks, ['T07']);
  assert.deepEqual(c.get('T07')?.dependsOn, ['T05']);
});

test('validateContracts reports unknown references and cycles', () => {
  const tasks = [task('T01', { dependsOn: 'T02' }), task('T02', { dependsOn: 'T01' })];
  const c = contractsFor(tasks, new Map());
  const issues = validateContracts(tasks, c);
  assert.ok(issues.some((i) => /cycle/.test(i.message)), issues.map((i) => i.message).join('|'));
  const unknown = contractsFor([task('T01', { dependsOn: 'T99' })], new Map());
  assert.ok(validateContracts([task('T01', { dependsOn: 'T99' })], unknown).some((i) => /not in ROADMAP/.test(i.message)));
});

test('topoOrder puts prerequisites before consumers and preserves order otherwise', () => {
  const tasks = [task('T02', { dependsOn: 'T03' }), task('T01'), task('T03')];
  const c = contractsFor(tasks, new Map());
  const ordered = topoOrder(tasks, c).map((t) => t.id);
  assert.ok(ordered.indexOf('T03') < ordered.indexOf('T02'), ordered.join(','));
  assert.equal(ordered.indexOf('T01'), 0);
});

test('dependencyClosure walks transitive dependsOn edges', () => {
  const tasks = [task('T01'), task('T02', { dependsOn: 'T01' }), task('T03', { dependsOn: 'T02' })];
  const c = contractsFor(tasks, new Map());
  assert.deepEqual([...dependencyClosure(['T03'], c)].sort(), ['T01', 'T02', 'T03']);
});

test('splitDepth and findDuplicateTask bound auto-created tickets', () => {
  assert.equal(splitDepth('T10'), 0);
  assert.equal(splitDepth('T10a'), 1);
  assert.equal(splitDepth('T10a1'), 2);
  const tasks = [task('T01'), { ...task('T05'), title: 'Wire the organ router' }];
  assert.equal(findDuplicateTask({ title: 'wire the organ router' }, tasks)?.id, 'T05');
  assert.equal(findDuplicateTask({ id: 'T01', title: 'anything' }, tasks)?.id, 'T01');
  assert.equal(findDuplicateTask({ title: 'a genuinely new thing' }, tasks), undefined);
});

test('acceptance summary and landed-subset detection', () => {
  const items = parseAcceptance('- [x] a\n- [ ] b [blocking]\n- [ ] c [deferrable]\n- [ ] d [deferrable: cap]');
  const s = summarizeAcceptance(items);
  assert.equal(s.checked, 1);
  assert.equal(s.unmetBlocking.length, 1);
  assert.equal(s.unmetDeferrable.length, 2);
  assert.equal(isLandedSubset(items), false, 'an unmet blocking item blocks subset acceptance');

  const landed = parseAcceptance('- [x] a\n- [ ] c [deferrable]\n- [ ] d [deferrable: cap]');
  assert.equal(isLandedSubset(landed), true);
  assert.equal(isLandedSubset(parseAcceptance('- [x] a\n- [x] b')), false, 'fully checked is done, not a subset');
});

test('checkAutoCreatedTasks rejects a duplicate, an over-deep split and a broken DAG', () => {
  const before = [named('T01', 'Wire the organ router')];
  const opts = { maxSplitDepth: 1 };

  const dup = checkAutoCreatedTasks(before, [...before, named('T02', 'wire  the ORGAN router')], new Map(), opts);
  assert.ok(dup.some((i) => /duplicates existing T01/.test(i.message)), dup.map((i) => i.message).join('|'));
  assert.equal(dup.length, 1);

  const deep = checkAutoCreatedTasks(before, [...before, { ...named('T05a1', 'deeper still') }], new Map(), opts);
  assert.ok(deep.some((i) => /split depth 2.*maxSplitDepth \(1\)/.test(i.message)), deep.map((i) => i.message).join('|'));

  const bodies = new Map<string, string | undefined>();
  const unknown = checkAutoCreatedTasks(before, [...before, named('T02', 'fresh', { dependsOn: 'T99' })], bodies, opts);
  assert.ok(unknown.some((i) => /depends on T99/.test(i.message)), unknown.map((i) => i.message).join('|'));

  const cyclic = checkAutoCreatedTasks(
    before,
    [...before, named('T02', 'a', { dependsOn: 'T03' }), named('T03', 'b', { dependsOn: 'T02' })],
    bodies,
    opts,
  );
  assert.ok(cyclic.some((i) => /cycle/.test(i.message)), cyclic.map((i) => i.message).join('|'));

  const clean = checkAutoCreatedTasks(before, [...before, named('T02', 'a genuinely new thing')], bodies, { maxSplitDepth: 3 });
  assert.deepEqual(clean, []);
});

test('checkAutoCreatedTasks ignores pre-existing duplicate titles and dangling edges', () => {
  const before = [named('T01', 'Same title'), named('T02', 'Same title', { dependsOn: 'T99' })];
  assert.deepEqual(checkAutoCreatedTasks(before, before, new Map(), { maxSplitDepth: 3 }), []);
});
