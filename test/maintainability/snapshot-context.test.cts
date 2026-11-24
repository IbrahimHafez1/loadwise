import test from 'node:test';
import assert from 'node:assert/strict';
import { archivedCopies, sourceContext } from '../../lib/maintainability/snapshot-context.cjs';

test('an archive needs an independent source counterpart and cannot hide a live duplicate pair', () => {
  const archive = 'handoffs/release/before/src/accounts.ts';
  const live = 'backend/src/accounts.ts';
  const absent = 'snapshots/release/after/src/missing.ts';
  const ordinary = 'features/before/src/accounts.ts';
  const copies = archivedCopies([archive, live, absent, ordinary]);
  assert.deepEqual([...copies], [archive]);
  const finding = { file: archive, ruleId: 'duplicate-implementation', message: 'fixture', related: [{ file: live }] };
  assert.ok(sourceContext(finding, copies, new Set()));
  finding.related.push({ file: ordinary });
  assert.equal(sourceContext(finding, copies, new Set()), undefined);
  assert.equal(
    sourceContext({ file: archive, ruleId: 'query-mutates-state', message: 'fixture' }, copies, new Set([archive])),
    undefined,
  );
});

test('test, seed and script sources are contextual for function-level rules only', () => {
  for (const file of [
    'test/helper.cjs',
    'src/users.spec.ts',
    'prisma/seed.ts',
    'seeds/bootstrap.ts',
    'scripts/run.ts',
    'db/users.seed.ts',
  ]) {
    assert.ok(
      sourceContext({ file, ruleId: 'high-branch-complexity', message: 'fixture' }, new Set(), new Set()),
      file,
    );
    assert.ok(sourceContext({ file, ruleId: 'query-mutates-state', message: 'fixture' }, new Set(), new Set()), file);
    assert.equal(
      sourceContext({ file, ruleId: 'dependency-cycle', message: 'fixture' }, new Set(), new Set()),
      undefined,
      file,
    );
  }
  assert.equal(
    sourceContext(
      { file: 'src/users.service.ts', ruleId: 'deep-control-flow', message: 'fixture' },
      new Set(),
      new Set(),
    ),
    undefined,
  );
});
