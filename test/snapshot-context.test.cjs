'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {archivedCopies, sourceContext} = require('../lib/snapshot-context.cjs');

test('an archive needs an independent source counterpart and cannot hide a live duplicate pair', () => {
  const archive = 'handoffs/release/before/src/accounts.ts';
  const live = 'backend/src/accounts.ts';
  const absent = 'snapshots/release/after/src/missing.ts';
  const ordinary = 'features/before/src/accounts.ts';
  const copies = archivedCopies([archive,live,absent,ordinary]);
  assert.deepEqual([...copies],[archive]);
  const finding = {file:archive, ruleId:'duplicate-implementation', related:[{file:live}]};
  assert.ok(sourceContext(finding,copies,new Set()));
  finding.related.push({file:ordinary});
  assert.equal(sourceContext(finding,copies,new Set()),undefined);
  assert.equal(sourceContext({file:archive,ruleId:'query-mutates-state'},copies,new Set([archive])),undefined);
});
