import { formatCount } from './checks.cjs';
import { walk, planRoot } from './plan-estimates.cjs';
import type { DbEngine, RelationalGateway } from '../types/db-connection.cjs';
import type { TableModel } from '../types/db-model.cjs';
import type { PlanDocument } from '../types/db-plan.cjs';
import type { Measurement, SeqScanCandidate } from '../types/db-plan-findings.cjs';

interface PreconnectGuards {
  engine: DbEngine;
  confirmed?: boolean;
  envVarNames?: readonly string[];
  databaseName?: string;
}

interface ServerGuards {
  databaseName?: string;
  inRecovery?: boolean;
}

interface RunStatistics {
  medianMs: number;
  rowsExamined: number;
  sharedHit: number;
  sharedRead: number;
}

interface MeasureRequest {
  sql: string;
  candidate: SeqScanCandidate;
  runs: number;
  indexName: string;
}

// The one mode that is not read-only. Everything here is opt-in and refused unless every guard
// passes.
const maxMeasureRows = 5_000_000;
const productionPattern = /prod/i;
const confirmationFlag = '--i-understand-this-locks-tables';
const indexNamePrefix = 'backend_perf_check_';

class MeasureRefusal extends Error {}

/**
 * Guards known before connecting: the confirmation flag and production-looking variable or database
 * names.
 */
function preconnectRefusals({ engine, confirmed, envVarNames = [], databaseName = '' }: PreconnectGuards) {
  const reasons: string[] = [];
  if (engine !== 'postgres')
    reasons.push('--measure supports PostgreSQL only (MySQL and MongoDB have no transactional index builds).');
  if (!confirmed) reasons.push(`--measure builds real indexes under a lock; pass ${confirmationFlag} to confirm.`);
  const productionVariable = envVarNames.find((name) => productionPattern.test(name));
  if (productionVariable)
    reasons.push(`--measure refuses connection variable \`${productionVariable}\`, whose name looks like production.`);
  if (productionPattern.test(databaseName))
    reasons.push('--measure refuses a database whose name looks like production.');
  return reasons;
}

/** Guards that need the server: its database name and whether it is a replica. */
function serverRefusals({ databaseName = '', inRecovery }: ServerGuards) {
  const reasons: string[] = [];
  if (productionPattern.test(databaseName))
    reasons.push('--measure refuses a database whose name looks like production.');
  if (inRecovery !== false) reasons.push('--measure refuses a replica (pg_is_in_recovery() is true).');
  return reasons;
}

function tableRefusal(table: TableModel) {
  if (table.rowEstimate === undefined) return `--measure skips \`${table.schema}.${table.name}\`: its size is unknown.`;
  if (table.rowEstimate > maxMeasureRows) {
    return (
      `--measure skips \`${table.schema}.${table.name}\`: about ${formatCount(table.rowEstimate)} rows (estimated) is ` +
      `above the ${formatCount(maxMeasureRows)}-row limit for building an index under a lock.`
    );
  }
}

function lockWarning(table: Pick<TableModel, 'schema' | 'name'>) {
  return (
    `--measure: CREATE INDEX inside a transaction holds a SHARE lock on \`${table.schema}.${table.name}\` that ` +
    'blocks writes to it until the rollback (at most 30 s statement timeout per statement).'
  );
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

// Rows each scan node read, including those its filter discarded, over all loops.
function rowsExamined(plan: PlanDocument) {
  let total = 0;
  for (const node of walk(planRoot(plan))) {
    if (!node['Relation Name']) continue;
    const perLoop =
      (node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0);
    total += perLoop * (node['Actual Loops'] ?? 1);
  }
  return Math.round(total);
}

function runStatistics(plans: PlanDocument[]): RunStatistics {
  const executionTimes = plans.map((plan) => {
    const time = (Array.isArray(plan) ? plan[0] : plan)?.['Execution Time'];
    if (typeof time !== 'number') throw new MeasureRefusal('EXPLAIN ANALYZE returned no execution time.');
    return time;
  });
  const roots = plans.map(planRoot);
  return {
    medianMs: round(median(executionTimes)),
    rowsExamined: median(plans.map(rowsExamined)),
    sharedHit: median(roots.map((root) => root?.['Shared Hit Blocks'] ?? 0)),
    sharedRead: median(roots.map((root) => root?.['Shared Read Blocks'] ?? 0)),
  };
}

// The impact keeps the shared finding shape; row and buffer counts travel beside it.
function measurement(runs: number, before: RunStatistics, after: RunStatistics): Measurement {
  return {
    impact: {
      kind: 'measured',
      before: before.medianMs,
      after: after.medianMs,
      unit: 'ms',
      method: `median of ${runs} EXPLAIN ANALYZE runs, index built inside a rolled-back transaction`,
    },
    rowsExamined: { before: before.rowsExamined, after: after.rowsExamined },
    sharedBuffers: {
      before: { hit: before.sharedHit, read: before.sharedRead },
      after: { hit: after.sharedHit, read: after.sharedRead },
    },
  };
}

/**
 * Before: `runs` EXPLAIN ANALYZE in read-only rolled-back transactions. After: one transaction that
 * builds the index, turns read-only, runs EXPLAIN ANALYZE `runs` times and is rolled back.
 */
async function measureCandidate(
  gateway: RelationalGateway,
  { sql, candidate, runs, indexName }: MeasureRequest,
): Promise<Measurement> {
  const beforePlans: PlanDocument[] = [];
  for (let run = 0; run < runs; run += 1) beforePlans.push(await gateway.explain(sql, { analyze: true }));
  const afterPlans = await gateway.measureTransaction(async (transaction) => {
    await transaction.createIndex({
      schema: candidate.table.schema,
      table: candidate.table.name,
      columns: candidate.columns,
      name: indexName,
    });
    await transaction.readOnly();
    const plans: PlanDocument[] = [];
    for (let run = 0; run < runs; run += 1) plans.push(await transaction.explainAnalyze(sql));
    return plans;
  });
  return measurement(runs, runStatistics(beforePlans), runStatistics(afterPlans));
}

// After the run: none of the indexes this process named may exist.
async function assertNoIndexesLeft(gateway: RelationalGateway, indexNames: readonly string[]) {
  if (indexNames.length === 0) return;
  const [row] = await gateway.catalog<{ remaining: number | string }>('indexesNamed', [indexNames]);
  if (Number(row?.remaining) !== 0) {
    throw new MeasureRefusal(
      `--measure left ${row?.remaining} index(es) named ${indexNamePrefix}*; drop them by hand.`,
    );
  }
}

function createIndexNamer(processId = process.pid) {
  let counter = 0;
  return () => `${indexNamePrefix}${processId}_${(counter += 1)}`;
}

function describeMeasurement({ rowsExamined: rows, sharedBuffers }: Measurement) {
  return (
    `rows examined ${formatCount(rows.before)} -> ${formatCount(rows.after)} (measured); shared buffers hit/read ` +
    `${formatCount(sharedBuffers.before.hit)}/${formatCount(sharedBuffers.before.read)} -> ` +
    `${formatCount(sharedBuffers.after.hit)}/${formatCount(sharedBuffers.after.read)} (measured)`
  );
}

export {
  maxMeasureRows,
  confirmationFlag,
  MeasureRefusal,
  preconnectRefusals,
  serverRefusals,
  tableRefusal,
  lockWarning,
  median,
  measureCandidate,
  assertNoIndexesLeft,
  createIndexNamer,
  describeMeasurement,
};
