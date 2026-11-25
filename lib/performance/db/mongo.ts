import { formatCount, minimumStatsAgeDays, sinceEvent, tableKey } from './checks.js';
import type { MongoAdapter, MongoCommand } from '../types/db-connection.js';
import type { DbFinding, IndexKey } from '../types/db-model.js';
import type { SnapshotIndex, SnapshotTables } from '../types/db-snapshot.js';

// The parts of MongoDB's command replies that `db` reads.
interface MongoIndexSpec {
  name: string;
  key?: Record<string, number | string>;
  unique?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: unknown;
  hidden?: boolean;
  sparse?: boolean;
  collation?: unknown;
}

interface MongoIndexStat {
  name: string;
  accesses?: { ops?: number | string; since?: string | number | Date };
}

interface MongoProfiledOperation {
  ns?: string;
  docsExamined?: number | string;
  nreturned?: number | string;
}

interface MongoCollectionEntry {
  name: string;
}

interface MongoCollectionStats {
  storageStats?: { count?: number | string; size?: number | string };
}

interface MongoCursorResult<Item> {
  cursor?: { firstBatch?: Item[] };
}

interface MongoGateway {
  engine: 'mongo';
  databaseName: string;
  command<Result>(document: MongoCommand): Promise<Result>;
  close(): Promise<void>;
  destroy(): Promise<void>;
}

interface ScanGroup {
  count: number;
  examined: number;
  returned: number;
}

const maxTimeMs = 5000;
const cursorBatchSize = 10_000;
const profiledOperationLimit = 200;
const millisecondsPerDay = 86_400_000;
const statisticsStages = new Set(['$indexStats', '$collStats']);

class MongoRefusal extends Error {}

function onlyKeys(document: MongoCommand, allowed: readonly string[]) {
  return Object.keys(document).every((key) => allowed.includes(key));
}

// The command allowlist of design 4.2. Anything else is refused before it reaches the driver.
function hasStringFind(value: unknown) {
  return typeof value === 'object' && value !== null && 'find' in value && typeof value.find === 'string';
}

function validateCommand(document: MongoCommand): void {
  const name = Object.keys(document)[0];
  const value = document[name];
  switch (name) {
    case 'ping':
    case 'buildInfo':
      if (value === 1 && onlyKeys(document, [name])) return;
      break;
    case 'listCollections':
      if (value === 1 && onlyKeys(document, [name, 'filter', 'nameOnly', 'cursor'])) return;
      break;
    case 'listIndexes':
      if (typeof value === 'string' && onlyKeys(document, [name, 'cursor'])) return;
      break;
    case 'aggregate': {
      const { pipeline } = document;
      const stage = Array.isArray(pipeline) && pipeline.length === 1 ? Object.keys(pipeline[0] ?? {}) : [];
      if (
        stage.length === 1 &&
        statisticsStages.has(stage[0]) &&
        onlyKeys(document, [name, 'pipeline', 'cursor', 'maxTimeMS'])
      ) {
        return;
      }
      break;
    }
    case 'find':
      if (
        value === 'system.profile' &&
        onlyKeys(document, [name, 'filter', 'projection', 'sort', 'limit', 'maxTimeMS'])
      )
        return;
      break;
    case 'profile':
      // Reading the level is -1; any other value would change it.
      if (value === -1 && onlyKeys(document, [name])) return;
      break;
    case 'explain':
      if (document.verbosity === 'queryPlanner' && hasStringFind(value) && onlyKeys(document, [name, 'verbosity']))
        return;
      break;
    default:
  }
  throw new MongoRefusal(`MongoDB command ${String(name)} is not on the read-only allowlist.`);
}

function createMongoGateway(adapter: MongoAdapter): MongoGateway {
  return {
    engine: 'mongo',
    databaseName: adapter.databaseName,
    async command<Result>(document: MongoCommand) {
      validateCommand(document);
      return adapter.command<Result>(document);
    },
    close: () => adapter.close(),
    destroy: () => adapter.destroy(),
  };
}

function firstBatch<Item>(result: MongoCursorResult<Item> | undefined): Item[] {
  return result?.cursor?.firstBatch ?? [];
}

function keyEntries(index: Pick<MongoIndexSpec, 'key'>) {
  return Object.entries(index.key ?? {});
}

function isPlainKey(index: MongoIndexSpec) {
  return keyEntries(index).every(([, direction]) => direction === 1 || direction === -1);
}

function isKeyPrefix(shorter: MongoIndexSpec, longer: MongoIndexSpec) {
  const shorterKeys = keyEntries(shorter);
  const longerKeys = keyEntries(longer);
  return (
    shorterKeys.length <= longerKeys.length &&
    shorterKeys.every(([field, direction], position) => {
      const [otherField, otherDirection] = longerKeys[position];
      return field === otherField && direction === otherDirection;
    })
  );
}

function describeKey(index: MongoIndexSpec) {
  return '`' + JSON.stringify(index.key) + '`';
}

function isRemovable(index: MongoIndexSpec) {
  return (
    index.name !== '_id_' && !index.unique && index.expireAfterSeconds === undefined && !index.partialFilterExpression
  );
}

function dropIndexFix(collection: string, index: MongoIndexSpec) {
  return `db.getCollection(${JSON.stringify(collection)}).dropIndex(${JSON.stringify(index.name)})`;
}

function unusedIndexFindings(
  target: string,
  collection: string,
  indexStats: MongoIndexStat[],
  specs: MongoIndexSpec[],
  now: number,
) {
  const findings: DbFinding[] = [];
  // The first spec of a name wins, as with find().
  const specByName = new Map<string, MongoIndexSpec>();
  for (const candidate of specs) {
    if (!specByName.has(candidate.name)) specByName.set(candidate.name, candidate);
  }
  for (const stat of indexStats) {
    const spec = specByName.get(stat.name);
    if (!spec || !isRemovable(spec) || Number(stat.accesses?.ops) !== 0) continue;
    const since = stat.accesses?.since ? new Date(stat.accesses.since) : undefined;
    const days = since ? Math.max(0, (now - since.getTime()) / millisecondsPerDay) : undefined;
    const fix = dropIndexFix(collection, spec);
    const finding: DbFinding = {
      target,
      ruleId: 'db-unused-index',
      message:
        `Index \`${spec.name}\` ${describeKey(spec)} on \`${collection}\` had 0 accesses (measured by $indexStats) ` +
        sinceEvent(days, 'index statistics began') +
        ` on the node that answered; other replica set members keep their own counters. It slows every write. ` +
        `If no member uses it, drop it: \`${fix}\``,
      suggestion: fix,
    };
    if (days === undefined || days < minimumStatsAgeDays) {
      finding.contextualReason = `Index statistics cover less than ${minimumStatsAgeDays} days; weekly or monthly jobs may still use this index.`;
    }
    findings.push(finding);
  }
  return findings;
}

// A hidden index serves no query, a sparse one skips documents, and another collation compares
// strings differently.
function servesQueriesOf(longer: MongoIndexSpec, shorter: MongoIndexSpec) {
  return (
    !longer.hidden &&
    (!longer.sparse || Boolean(shorter.sparse)) &&
    JSON.stringify(longer.collation ?? null) === JSON.stringify(shorter.collation ?? null)
  );
}

function duplicateIndexFindings(target: string, collection: string, specs: MongoIndexSpec[]) {
  const findings: DbFinding[] = [];
  const reported = new Set<string>();
  const plain = specs.filter((spec) => isPlainKey(spec) && !spec.partialFilterExpression);
  for (const shorter of plain) {
    if (!isRemovable(shorter) || reported.has(shorter.name)) continue;
    const longer = plain.find(
      (candidate) =>
        candidate !== shorter &&
        isKeyPrefix(shorter, candidate) &&
        servesQueriesOf(candidate, shorter) &&
        (keyEntries(candidate).length > keyEntries(shorter).length ||
          !isRemovable(candidate) ||
          candidate.name < shorter.name),
    );
    if (!longer) continue;
    reported.add(shorter.name);
    const fix = dropIndexFix(collection, shorter);
    findings.push({
      target,
      ruleId: 'db-duplicate-index',
      message:
        `Index \`${shorter.name}\` ${describeKey(shorter)} is a prefix of \`${longer.name}\` ${describeKey(longer)}, ` +
        `which serves the same queries, so it only slows writes. Drop it: \`${fix}\``,
      suggestion: fix,
    });
  }
  return findings;
}

function collectionScanFindings(databaseName: string, operations: MongoProfiledOperation[]): DbFinding[] {
  const byNamespace = new Map<string, ScanGroup>();
  for (const operation of operations) {
    if (typeof operation.ns !== 'string') continue;
    const group = byNamespace.get(operation.ns) ?? { count: 0, examined: 0, returned: 0 };
    group.count += 1;
    group.examined = Math.max(group.examined, Number(operation.docsExamined) || 0);
    group.returned = Math.max(group.returned, Number(operation.nreturned) || 0);
    byNamespace.set(operation.ns, group);
  }
  return [...byNamespace].map(([namespace, group]) => ({
    target: namespace.startsWith(databaseName + '.') ? namespace : tableKey(databaseName, namespace),
    ruleId: 'mongo-collection-scan-observed',
    message:
      `${formatCount(group.count)} profiled operations on \`${namespace}\` scanned the whole collection (COLLSCAN, ` +
      `measured by the profiler), examining up to ${formatCount(group.examined)} documents (measured) to return up ` +
      `to ${formatCount(group.returned)}. Index the fields those queries filter on, and confirm with ` +
      '`explain("executionStats")` and `loadwise perf plan`.',
  }));
}

async function profiledCollectionScans(gateway: MongoGateway, notes: string[]) {
  const level = await gateway.command<{ was?: number | string } | undefined>({ profile: -1 });
  if (!(Number(level?.was) > 0)) {
    notes.push('The MongoDB profiler is off; `db` never enables it, so observed collection scans are not reported.');
    return [];
  }
  const result = await gateway.command<MongoCursorResult<MongoProfiledOperation>>({
    find: 'system.profile',
    filter: { planSummary: 'COLLSCAN' },
    projection: { ns: 1, docsExamined: 1, nreturned: 1 },
    sort: { ts: -1 },
    limit: profiledOperationLimit,
    maxTimeMS: maxTimeMs,
  });
  return firstBatch(result);
}

async function collectionInfo(gateway: MongoGateway, collection: string) {
  const cursor = { batchSize: cursorBatchSize };
  const [stats, specs, indexStats] = await Promise.all([
    gateway.command<MongoCursorResult<MongoCollectionStats>>({
      aggregate: collection,
      pipeline: [{ $collStats: { storageStats: {} } }],
      cursor,
      maxTimeMS: maxTimeMs,
    }),
    gateway.command<MongoCursorResult<MongoIndexSpec>>({ listIndexes: collection, cursor }),
    gateway.command<MongoCursorResult<MongoIndexStat>>({
      aggregate: collection,
      pipeline: [{ $indexStats: {} }],
      cursor,
      maxTimeMS: maxTimeMs,
    }),
  ]);
  return {
    storage: firstBatch(stats)[0]?.storageStats ?? {},
    specs: firstBatch(specs),
    indexStats: firstBatch(indexStats),
  };
}

function snapshotIndex(spec: MongoIndexSpec): SnapshotIndex {
  const keys = keyEntries(spec).map(([field, direction]): IndexKey =>
    typeof direction === 'number'
      ? { column: field, direction: direction === -1 ? 'desc' : 'asc' }
      : { column: field, opclass: String(direction) },
  );
  const index: SnapshotIndex = {
    name: spec.name,
    keys,
    unique: Boolean(spec.unique),
    primary: spec.name === '_id_',
    method: isPlainKey(spec) ? 'btree' : 'other',
  };
  if (spec.partialFilterExpression) index.predicate = JSON.stringify(spec.partialFilterExpression);
  return index;
}

async function inspectMongo(gateway: MongoGateway, { now = Date.now() }: { now?: number } = {}) {
  const notes = [
    'MongoDB has no transactional index builds, so `db` reports planner and counter data only, no measured before/after.',
  ];
  const databaseName = gateway.databaseName;
  const build = await gateway.command<{ version?: string } | undefined>({ buildInfo: 1 });
  const listed = await gateway.command<MongoCursorResult<MongoCollectionEntry>>({
    listCollections: 1,
    nameOnly: true,
    filter: { type: 'collection' },
    cursor: { batchSize: cursorBatchSize },
  });
  const collections = firstBatch(listed)
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('system.'))
    .sort();
  const findings: DbFinding[] = [];
  const tables: SnapshotTables = {};
  for (const collection of collections) {
    const target = tableKey(databaseName, collection);
    const { storage, specs, indexStats } = await collectionInfo(gateway, collection);
    findings.push(...unusedIndexFindings(target, collection, indexStats, specs, now));
    findings.push(...duplicateIndexFindings(target, collection, specs));
    tables[target] = {
      rowEstimate: Number(storage.count) || 0,
      sizeBytes: Number(storage.size) || 0,
      indexes: specs.map(snapshotIndex),
      foreignKeys: [],
    };
  }
  findings.push(...collectionScanFindings(databaseName, await profiledCollectionScans(gateway, notes)));
  return { serverVersion: String(build?.version ?? ''), findings, notes, tables };
}

export { createMongoGateway, validateCommand, MongoRefusal, inspectMongo, isKeyPrefix };
