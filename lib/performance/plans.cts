import type { Finding } from '../shared/types.cjs';

// An EXPLAIN document is untrusted JSON, so its parts are checked with these guards before they are
// read.
type JsonRecord = Record<string, unknown>;

interface PlanInspection {
  engine: 'postgresql' | 'mongodb';
  findings: Finding[];
}

// A stage still to inspect; `parent` is the stage it hangs under, when that matters.
interface StageEntry {
  stage: unknown;
  path: string;
  parent?: JsonRecord;
}

// A skip or offset page: how many records it walked, how many it returned, and where in the plan
// that happened.
interface PageReport {
  findings: Finding[];
  ruleId: string;
  node: string;
  path: string;
  walked: number;
  returned: number;
}

const MIN_EXAMINED = 1_000;
const MIN_SCAN_RATIO = 100;
const MIN_DISK_KIB = 1_024;
const MIN_SKIPPED = 10_000;
const MIN_PAGE_RATIO = 10;
const MIN_SPILL_BYTES = 1_048_576;
const MIN_SPILLS = 8;
const STAGE_CHILDREN = [
  'inputStage',
  'thenStage',
  'elseStage',
  'innerStage',
  'outerStage',
  'child',
  'leftChild',
  'rightChild',
];

function object(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown, label: string, allowFraction = false): number {
  const numeric = allowFraction
    ? Number.isFinite(value) && typeof value === 'number' && value <= Number.MAX_SAFE_INTEGER
    : Number.isSafeInteger(value);
  if (typeof value !== 'number' || !numeric || value < 0) {
    throw new TypeError('Expected a nonnegative numeric execution statistic for ' + label + '.');
  }
  return value;
}

// The value at `key` of an object, or undefined when the parent is not an object.
function member(value: unknown, key: string): unknown {
  return object(value) ? value[key] : undefined;
}

function children(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('Invalid child plan array.');
  return value;
}

function inefficient(examined: number, returned: number) {
  return examined >= MIN_EXAMINED && examined >= MIN_SCAN_RATIO * Math.max(1, returned);
}

function reportPage({ findings, ruleId, node, path, walked, returned }: PageReport, loops = 1) {
  const skipped = walked - returned;
  if (skipped < MIN_SKIPPED * loops || walked < MIN_PAGE_RATIO * Math.max(1, returned)) return;
  findings.push({
    ruleId,
    node,
    path,
    walked,
    returned,
    skipped,
    loops,
    message:
      'This page walked and discarded many records before returning results, so deeper pages get slower. For sequential navigation use keyset pagination: `WHERE (sort_key, id) > ($1, $2) ORDER BY sort_key, id LIMIT n` instead of a large offset or skip.',
  });
}

function diskKiB(sort: unknown, incremental: boolean): number {
  if (!object(sort)) throw new TypeError('Invalid PostgreSQL sort statistics.');
  if (!incremental) return sort['Sort Space Type'] === 'Disk' ? count(sort['Sort Space Used'], 'Sort Space Used') : 0;
  let peak = 0;
  for (const name of ['Full-sort Groups', 'Pre-sorted Groups']) {
    const group = sort[name];
    if (!object(group)) continue;
    const disk = group['Sort Space Disk'];
    if (disk !== undefined && count(group['Group Count'], 'Group Count') > 0) {
      peak = Math.max(peak, count(member(disk, 'Peak Sort Space Used'), 'Peak Sort Space Used'));
    }
  }
  return peak;
}

function inspectPostgres(root: unknown): PlanInspection {
  const findings: Finding[] = [];
  const pending: { node: unknown; path: string }[] = [{ node: root, path: 'Plan' }];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    const { node, path } = entry;
    if (!object(node) || typeof node['Node Type'] !== 'string') throw new TypeError('Invalid PostgreSQL plan node.');
    const loops = count(node['Actual Loops'], 'Actual Loops (EXPLAIN ANALYZE required)');
    const averageRows = count(node['Actual Rows'], 'Actual Rows (EXPLAIN ANALYZE required)', true);
    if (!loops) continue;
    if (node['Node Type'] === 'Seq Scan') {
      const removed = count(node['Rows Removed by Filter'] ?? 0, 'Rows Removed by Filter', true);
      const returned = count(Math.round(averageRows * loops), 'total returned rows');
      const examined = count(returned + Math.round(removed * loops), 'total examined rows');
      if (inefficient(examined, returned))
        findings.push({
          ruleId: 'pg-sequential-scan',
          node: 'Seq Scan',
          path,
          examined,
          returned,
          loops,
          message:
            'This sequential scan read many rows and discarded most of them. Add an index on the filtered columns, for example `CREATE INDEX ON table (column)`, and re-run EXPLAIN to confirm an index scan.',
        });
    }
    if (node['Node Type'] === 'Sort' || node['Node Type'] === 'Incremental Sort') {
      const incremental = node['Node Type'] === 'Incremental Sort';
      let maxDiskKiB = diskKiB(node, incremental);
      for (const worker of children(node.Workers ?? []))
        maxDiskKiB = Math.max(maxDiskKiB, diskKiB(worker, incremental));
      if (maxDiskKiB >= MIN_DISK_KIB)
        findings.push({
          ruleId: 'pg-disk-sort',
          node: node['Node Type'],
          path,
          maxDiskKiB,
          message:
            'This sort spilled to disk because it exceeded work_mem. Add an index matching the ORDER BY so no sort is needed, or reduce the rows sorted; raise `work_mem` only as a last resort.',
        });
    }
    const plans = children(node.Plans ?? []);
    const [onlyChild] = plans;
    const relationship = member(onlyChild, 'Parent Relationship');
    if (
      node['Node Type'] === 'Limit' &&
      plans.length === 1 &&
      object(onlyChild) &&
      onlyChild['Actual Loops'] === loops &&
      !(typeof relationship === 'string' && ['InitPlan', 'SubPlan'].includes(relationship))
    ) {
      const childAverage = count(onlyChild['Actual Rows'], 'limit child Actual Rows', true);
      const walked = count(Math.round(childAverage * loops), 'limit child total rows');
      const returned = count(Math.round(averageRows * loops), 'limit total rows');
      reportPage({ findings, ruleId: 'pg-deep-offset', node: 'Limit', path, walked, returned }, loops);
    }
    for (let index = plans.length - 1; index >= 0; index--) {
      pending.push({ node: plans[index], path: path + '.Plans[' + index + ']' });
    }
  }
  return { engine: 'postgresql', findings };
}

function stageChildren(stage: JsonRecord, path: string): StageEntry[] {
  const result: StageEntry[] = [];
  for (const key of STAGE_CHILDREN) {
    if (key in stage) result.push({ stage: stage[key], path: path + '.' + key });
  }
  for (const [index, child] of children(stage.inputStages ?? []).entries()) {
    result.push({ stage: child, path: path + '.inputStages[' + index + ']' });
  }
  return result;
}

function collectionNodes(logicalRoot: unknown): Map<number, JsonRecord> {
  const logical = new Map<number, JsonRecord>();
  if (!logicalRoot) return logical;
  const pending: unknown[] = [logicalRoot];
  while (pending.length) {
    const stage = pending.pop();
    if (!object(stage) || typeof stage.stage !== 'string') throw new TypeError('Invalid MongoDB winning plan.');
    if (stage.stage === 'COLLSCAN' && typeof stage.planNodeId === 'number' && Number.isInteger(stage.planNodeId)) {
      logical.set(stage.planNodeId, stage);
    }
    for (const child of stageChildren(stage, '')) pending.push(child.stage);
  }
  return logical;
}

function reportCollectionScan(findings: Finding[], path: string, examined: number, returned: number) {
  if (inefficient(examined, returned))
    findings.push({
      ruleId: 'mongo-collection-scan',
      node: 'COLLSCAN',
      path,
      examined,
      returned,
      message:
        'This collection scan examined many documents to return few. Create an index on the filtered fields, for example `db.collection.createIndex({ field: 1 })`, and re-run explain to confirm IXSCAN.',
    });
}

function checkMongoSort(findings: Finding[], stage: JsonRecord, path: string) {
  if ('usedDisk' in stage && typeof stage.usedDisk !== 'boolean')
    throw new TypeError('Invalid MongoDB usedDisk statistic.');
  const spilledBytes = count(stage.spilledBytes ?? 0, 'spilledBytes');
  const spilledStorageBytes = count(stage.spilledDataStorageSize ?? 0, 'spilledDataStorageSize');
  const spills = count(stage.spills ?? 0, 'spills');
  if (stage.usedDisk === false && (spilledBytes || spilledStorageBytes || spills))
    throw new TypeError('Inconsistent MongoDB sort spill statistics.');
  if (Math.max(spilledBytes, spilledStorageBytes) >= MIN_SPILL_BYTES || spills >= MIN_SPILLS) {
    findings.push({
      ruleId: 'mongo-disk-sort',
      node: 'SORT',
      path,
      spills,
      spilledBytes,
      spilledStorageBytes,
      message:
        'This sort spilled to disk because it exceeded the in-memory limit. Create an index matching the sort order so no in-memory sort is needed, or filter and project earlier to shrink the input.',
    });
  }
}

function isMongoSkip(stage: JsonRecord): boolean {
  return stage.stage === 'SKIP' || (stage.stage === 'limitskip' && typeof stage.skip === 'number' && stage.skip > 0);
}

function checkMongoSkip(findings: Finding[], stage: JsonRecord, path: string): void {
  if (!object(stage.inputStage)) throw new TypeError('Unsupported MongoDB skip with no executed input stage.');
  const walked = count(stage.inputStage.nReturned, 'SKIP inputStage.nReturned');
  const returned = count(stage.nReturned, 'SKIP.nReturned');
  const opens = count(stage.opens ?? 1, 'SKIP opens');
  const matchingOpens = stage.inputStage.opens === undefined || stage.inputStage.opens === opens;
  // SBE records the last evaluated skip expression. At one open its value
  // bounds the skipped rows; across reopens the expression can change.
  const consistentSkip =
    stage.stage !== 'limitskip' || opens !== 1 || walked - returned <= count(stage.skip, 'limitskip skip');
  if (matchingOpens && consistentSkip)
    reportPage({ findings, ruleId: 'mongo-deep-skip', node: 'SKIP', path, walked, returned }, opens);
}

function checkMongoScan(
  findings: Finding[],
  stage: JsonRecord,
  path: string,
  parent: JsonRecord | undefined,
  logical: Map<number, JsonRecord>,
): void {
  // A physical SBE scan returns rows before filtering. Only pair it with
  // the executed filter for the same logical collection-scan node.
  const winning = typeof stage.planNodeId === 'number' ? logical.get(stage.planNodeId) : undefined;
  if (!winning) throw new TypeError('Unsupported MongoDB slot-based scan without a matching winning COLLSCAN.');
  const matchingFilter = parent?.stage === 'filter' && parent.planNodeId === stage.planNodeId;
  if (winning.filter !== undefined && !matchingFilter) {
    throw new TypeError('Unsupported MongoDB slot-based filter layout.');
  }
  if (matchingFilter) {
    reportCollectionScan(
      findings,
      path,
      count(stage.nReturned, 'scan.nReturned'),
      count(parent.nReturned, 'filter.nReturned'),
    );
  }
}

function shardEntries(stage: JsonRecord, path: string): StageEntry[] {
  const entries: StageEntry[] = [];
  for (const [index, shard] of children(stage.shards ?? []).entries()) {
    if (!object(shard) || shard.executionSuccess === false)
      throw new TypeError('Invalid or unsuccessful MongoDB shard execution.');
    entries.push({ stage: shard.executionStages, path: path + '.shards[' + index + '].executionStages' });
  }
  return entries;
}

function inspectMongo(document: JsonRecord): PlanInspection {
  const stats = document.executionStats;
  if (!object(stats) || !object(stats.executionStages))
    throw new TypeError('MongoDB executionStats with executed stages is required.');
  if (stats.executionSuccess === false) throw new TypeError('MongoDB reports an unsuccessful execution.');
  count(stats.nReturned, 'executionStats.nReturned');
  count(stats.totalDocsExamined, 'executionStats.totalDocsExamined');
  const findings: Finding[] = [];
  const logical = collectionNodes(member(member(document.queryPlanner, 'winningPlan'), 'queryPlan'));
  const pending: StageEntry[] = [{ stage: stats.executionStages, path: 'executionStats.executionStages' }];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    const { stage, path, parent } = entry;
    if (!object(stage) || typeof stage.stage !== 'string') throw new TypeError('Invalid MongoDB execution stage.');
    if (stage.opens === 0) continue;
    if (stage.stage === 'SORT' || stage.stage === 'sort') checkMongoSort(findings, stage, path);
    if (isMongoSkip(stage)) checkMongoSkip(findings, stage, path);
    if (stage.stage === 'COLLSCAN') {
      reportCollectionScan(
        findings,
        path,
        count(stage.docsExamined, 'docsExamined'),
        count(stage.nReturned, 'nReturned'),
      );
    } else if (stage.stage === 'scan') {
      checkMongoScan(findings, stage, path, parent, logical);
    }
    const nested = stageChildren(stage, path);
    nested.push(...shardEntries(stage, path));
    for (let index = nested.length - 1; index >= 0; index--) pending.push({ ...nested[index], parent: stage });
  }
  return { engine: 'mongodb', findings };
}

function inspectPlan(document: unknown): PlanInspection {
  if (Array.isArray(document) && document.length === 1) {
    const [entry]: unknown[] = document;
    if (object(entry) && object(entry.Plan)) return inspectPostgres(entry.Plan);
  }
  if (object(document) && object(document.Plan)) return inspectPostgres(document.Plan);
  if (object(document) && ('executionStats' in document || 'queryPlanner' in document)) return inspectMongo(document);
  throw new TypeError(
    'Expected PostgreSQL EXPLAIN (ANALYZE, FORMAT JSON) or MongoDB explain("executionStats") with a query-stage tree.',
  );
}

export { inspectPlan };
