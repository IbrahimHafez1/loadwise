const assert = require('node:assert/strict');
const test = require('node:test');
const { inspectPlan } = require('../lib/plans.cjs');

function postgres(type, rows, loops, extra = {}) {
  return { 'Node Type': type, 'Actual Rows': rows, 'Actual Loops': loops, ...extra };
}

function mongo(stage, extra = {}) {
  return { executionStats: { executionSuccess: true, nReturned: 5, totalDocsExamined: 1_000, executionStages: stage }, ...extra };
}

test('PostgreSQL totals the per-loop actuals on each sequential scan', () => {
  const plan = [{ Plan: postgres('Nested Loop', 6, 1, { Plans: [
    postgres('Seq Scan', 2, 5, { 'Rows Removed by Filter': 198, 'Relation Name': 'private_table', Filter: 'private_predicate' }),
    postgres('Seq Scan', 0, 0, { 'Rows Removed by Filter': 1_000 }),
    postgres('Index Scan', 1, 1, { 'Rows Removed by Filter': 10_000 }),
  ] }) }];
  const { engine, findings } = inspectPlan(plan);
  assert.equal(engine, 'postgresql');
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding.ruleId, 'pg-sequential-scan');
  assert.equal(finding.path, 'Plan.Plans[0]');
  assert.deepEqual([finding.examined, finding.returned, finding.loops], [1_000, 10, 5]);
  assert.doesNotMatch(JSON.stringify(findings), /private_/);
});

test('selective small scans, bulk reads, and in-memory or small disk sorts pass', () => {
  for (const node of [
    postgres('Seq Scan', 0, 1, { 'Rows Removed by Filter': 999 }),
    postgres('Seq Scan', 11, 1, { 'Rows Removed by Filter': 989 }),
    postgres('Seq Scan', 1_000_000, 1),
    postgres('Sort', 10_000, 1, { 'Sort Space Type': 'Memory', 'Sort Space Used': 2_048 }),
    postgres('Sort', 10_000, 1, { 'Sort Space Type': 'Disk', 'Sort Space Used': 1_023 }),
  ]) assert.deepEqual(inspectPlan({ Plan: node }).findings, []);
  assert.equal(inspectPlan({ Plan: postgres('Seq Scan', 0, 1, { 'Rows Removed by Filter': 1_000 }) }).findings.length, 1);
});

test('PostgreSQL reports the largest measured disk spill per sort node', () => {
  const leader = { 'Sort Space Type': 'Disk', 'Sort Space Used': 1_024, 'Sort Method': 'external merge' };
  const plan = { Plan: postgres('Gather Merge', 10_000, 1, { Plans: [
    postgres('Sort', 5_000, 2, { ...leader, Workers: [
      { 'Worker Number': 0, 'Sort Space Type': 'Disk', 'Sort Space Used': 2_048 },
    ] }),
  ] }) };
  const [finding] = inspectPlan(plan).findings;
  assert.equal(finding.ruleId, 'pg-disk-sort');
  assert.equal(finding.maxDiskKiB, 2_048);
});

test('PostgreSQL incremental sorts report their peak measured disk group across leader and workers', () => {
  const disk = peak => ({ 'Group Count': 4, 'Sort Space Disk': { 'Peak Sort Space Used': peak } });
  const stage = postgres('Incremental Sort', 15_000, 1, {
    'Full-sort Groups': { 'Group Count': 20, 'Sort Space Memory': { 'Peak Sort Space Used': 10_000 } },
    'Pre-sorted Groups': disk(1_024),
    Workers: [{ 'Pre-sorted Groups': disk(4_096) }, { 'Full-sort Groups': disk(2_048) }],
  });
  const [finding] = inspectPlan({ Plan: stage }).findings;
  assert.deepEqual([finding.ruleId, finding.node, finding.maxDiskKiB], ['pg-disk-sort', 'Incremental Sort', 4_096]);
  assert.deepEqual(inspectPlan({ Plan: { ...stage, 'Pre-sorted Groups': disk(200), Workers: [] } }).findings, []);
  assert.deepEqual(inspectPlan({ Plan: { ...stage, 'Actual Loops': 0 } }).findings, []);
});

test('MongoDB checks local executed-stage counters and skips rejected plans', () => {
  const collectionScan = { stage: 'COLLSCAN', nReturned: 5, docsExamined: 1_000, filter: { private_field: 42 } };
  const plan = mongo({ stage: 'FETCH', inputStages: [
    collectionScan, { stage: 'IXSCAN' }, { ...collectionScan, opens: 0 },
  ] }, { queryPlanner: { rejectedPlans: [collectionScan] } });
  plan.executionStats.allPlansExecution = [{ executionStages: collectionScan }];
  const result = inspectPlan(plan);
  assert.equal(result.engine, 'mongodb');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, 'mongo-collection-scan');
  assert.equal(result.findings[0].examined, 1_000);
  assert.equal(result.findings[0].path, 'executionStats.executionStages.inputStages[0]');
  assert.doesNotMatch(JSON.stringify(result), /private_field/);
  assert.deepEqual(inspectPlan(mongo({ stage: 'GROUP', nReturned: 1, inputStage:
    { stage: 'COLLSCAN', nReturned: 1_000, docsExamined: 1_000 },
  })).findings, []);
});

test('MongoDB reads executed sharded classic stages without exposing shard names', () => {
  const result = inspectPlan(mongo({ stage: 'SHARD_MERGE', shards: [
    { shardName: 'sensitive-shard', executionSuccess: true,
      executionStages: { stage: 'COLLSCAN', nReturned: 0, docsExamined: 1_200 } },
  ] }));
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].returned, 0);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-shard/);
});

test('correlates a slot-based physical scan and filter to a winning logical COLLSCAN', () => {
  const scan = { stage: 'scan', planNodeId: 1, opens: 1, nReturned: 1_500 };
  const stage = { stage: 'filter', planNodeId: 1, nReturned: 1, inputStage: scan };
  const winning = { queryPlan: { stage: 'COLLSCAN', planNodeId: 1, filter: { private_field: true } } };
  const plan = mongo(stage, { queryPlanner: { winningPlan: winning } });
  const [finding] = inspectPlan(plan).findings;
  assert.deepEqual([finding.examined, finding.returned], [1_500, 1]);
  stage.planNodeId++;
  assert.throws(() => inspectPlan(plan), /Unsupported/);
  assert.throws(() => inspectPlan(mongo(scan)), /Unsupported/);
});

test('rejects estimate-only, failed, unsupported and malformed inputs', () => {
  for (const example of [
    null, [], {}, { stages: [] }, { Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 20_000 } },
    { Plan: postgres('Seq Scan', 1, 1, { 'Rows Removed by Filter': '1500' }) },
    { Plan: postgres('Append', 1, 1, { Plans: [{}] }) },
    { Plan: postgres('Sort', 1_000, 1, { 'Sort Space Type': 'Disk' }) },
    { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } },
    { executionStats: { executionSuccess: false, executionStages: {} } },
    mongo({ stage: 'COLLSCAN', nReturned: 5 }), mongo({ stage: 'FETCH', inputStage: null }),
  ]) assert.throws(() => inspectPlan(example), TypeError);
});

test('PostgreSQL identifies deep OFFSET at the Limit boundary and ignores normal early stopping', () => {
  const plan = (walked, returned, loops = 1) => ({ Plan: postgres('Limit', returned, loops, {
    Plans: [postgres('Index Only Scan', walked, loops, { 'Parent Relationship': 'Outer' })],
  }) });
  const [finding] = inspectPlan(plan(15_010, 10, 2)).findings;
  assert.deepEqual([finding.ruleId, finding.walked, finding.skipped, finding.returned, finding.loops],
    ['pg-deep-offset', 30_020, 30_000, 20, 2]);
  assert.deepEqual(inspectPlan(plan(10, 10)).findings, []);
  assert.deepEqual(inspectPlan(plan(50, 10, 1_000)).findings, []);
  assert.deepEqual(inspectPlan(plan(100_000, 80_000)).findings, []);
  const init = plan(15_010, 10);
  init.Plan.Plans[0]['Parent Relationship'] = 'InitPlan';
  assert.deepEqual(inspectPlan(init).findings, []);
});

test('MongoDB counts physical SKIP input and return values at the same stage', () => {
  const skip = { stage: 'SKIP', nReturned: 10, inputStage: { stage: 'IXSCAN', nReturned: 15_010 } };
  const [finding] = inspectPlan(mongo(skip)).findings;
  assert.deepEqual([finding.ruleId, finding.walked, finding.returned], ['mongo-deep-skip', 15_010, 10]);
  assert.equal(inspectPlan(mongo({ ...skip, stage: 'limitskip', skip: 15_000 })).findings.length, 1);
  assert.deepEqual(inspectPlan(mongo({ ...skip, stage: 'limitskip', skip: 1, opens: 1 })).findings, []);
  assert.deepEqual(inspectPlan(mongo({ ...skip, opens: 1, inputStage: { ...skip.inputStage, opens: 4 } })).findings, []);
  assert.deepEqual(inspectPlan(mongo({ ...skip, stage: 'limitskip', skip: 0 })).findings, []);
  assert.throws(() => inspectPlan(mongo({ ...skip, inputStage: null })), /Unsupported/);
});

test('MongoDB requires measured spill volume or repeated spills on an executed sort', () => {
  const sort = { stage: 'SORT', usedDisk: true, spills: 2, spilledDataStorageSize: 1_048_576 };
  const [finding] = inspectPlan(mongo(sort)).findings;
  assert.deepEqual([finding.ruleId, finding.spills, finding.spilledStorageBytes],
    ['mongo-disk-sort', 2, 1_048_576]);
  assert.deepEqual(inspectPlan(mongo({ stage: 'SORT', usedDisk: true })).findings, []);
  assert.deepEqual(inspectPlan(mongo({ ...sort, stage: 'GROUP' })).findings, []);
  assert.deepEqual(inspectPlan(mongo({ ...sort, spilledDataStorageSize: 1_023 })).findings, []);
  assert.equal(inspectPlan(mongo({ stage: 'sort', spills: 8 })).findings.length, 1);
  assert.throws(() => inspectPlan(mongo({ ...sort, usedDisk: false })), /Inconsistent/);
  assert.throws(() => inspectPlan(mongo({ ...sort, spills: 2.5 })), /statistic/);
});
