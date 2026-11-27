// The MySQL inspection of `loadwise perf db`: catalog reads, top statements and full-scan findings.
import * as checks from './checks.js';
import * as planEstimates from './plan-estimates.js';
import * as snapshot from './snapshot.js';
import { dmlStart, formatMs, roundTripInUnit } from './cli-format.js';
import type { RelationalGateway } from '../types/db-connection.js';
import type { MysqlRedundantIndexRow, MysqlUnusedIndexRow, DbFinding, SchemaModel } from '../types/db-model.js';
import type { PlanDocument } from '../types/db-plan.js';
import type { MysqlFullScan, SourceLocation } from '../types/db-plan-findings.js';
import type { InspectContext, InspectionWithoutNotes, ServerInfoRow } from '../types/db-cli.js';

interface MysqlTopStatementRow {
  digest_text: string | null;
  sample_text: string | null;
  calls: number | string;
  mean_ms: number | string;
}

interface MysqlScanRequest {
  sql: string;
  subject: string;
  location?: SourceLocation;
  model: SchemaModel;
}

async function readOptional<Row>(
  gateway: RelationalGateway,
  id: string,
  notes: string[],
  note: string,
  params?: readonly unknown[],
): Promise<Row[]> {
  try {
    return await gateway.catalog<Row>(id, params);
  } catch {
    notes.push(note);
    return [];
  }
}

function mysqlScanFinding({
  subject,
  location,
  scan,
  queryCost,
}: {
  subject: string;
  location?: SourceLocation;
  scan: MysqlFullScan;
  queryCost?: number;
}): DbFinding {
  const rows = scan.rowsPerScan ?? scan.table.rowEstimate;
  const cost = queryCost === undefined ? '' : `; query cost ${checks.formatCount(queryCost)}, estimated`;
  return {
    ...(location ?? { target: checks.tableKey(scan.table.schema, scan.table.name) }),
    ruleId: 'db-slow-query-plan',
    message:
      `${subject} reads \`${scan.table.name}\` with a full table scan (about ${checks.formatCount(rows)} rows per ` +
      `scan, estimated${cost}). Index the columns in its WHERE clause with ` +
      '`ALTER TABLE ... ADD INDEX ..., ALGORITHM=INPLACE, LOCK=NONE`. MySQL has no transactional DDL, so `db` ' +
      'cannot measure the gain before you add it.',
  };
}

async function mysqlPlanFindings(
  gateway: RelationalGateway,
  { sql, subject, location, model }: MysqlScanRequest,
): Promise<DbFinding[]> {
  let plan: PlanDocument;
  try {
    plan = await gateway.explain(sql);
  } catch {
    return [];
  }
  const { scans, queryCost } = planEstimates.mysqlFullScans(plan, model);
  return scans.map((scan) => mysqlScanFinding({ subject, location, scan, queryCost }));
}

export async function inspectMysql(
  gateway: RelationalGateway,
  context: InspectContext,
): Promise<InspectionWithoutNotes> {
  const { options, notes } = context;
  if (options.analyze) notes.push('--analyze is ignored on MySQL: EXPLAIN ANALYZE executes the statement.');
  await gateway.open();
  const [info] = await gateway.catalog<ServerInfoRow>('serverInfo');
  const performanceNote = 'performance_schema or the sys schema is not readable, so index usage is not reported.';
  const [uptime] = await readOptional<{ uptime_seconds: number | string }>(gateway, 'uptime', notes, performanceNote);
  const uptimeDays = uptime ? Number(uptime.uptime_seconds) / 86_400 : undefined;
  const model = checks.buildMysqlModel({
    tables: await gateway.catalog('tables'),
    // loadwise-reviewed serial-awaits-in-literal -- These gateway reads share one connection and its transaction guard, so they must run one after another.
    indexes: await gateway.catalog('indexes'),
    foreignKeys: await gateway.catalog('foreignKeys'),
  });
  const findings = checks.mysqlCatalogFindings(model, {
    uptimeDays,
    unusedIndexes: await readOptional<MysqlUnusedIndexRow>(gateway, 'unusedIndexes', notes, performanceNote),
    // loadwise-reviewed serial-awaits-in-literal -- These gateway reads share one connection and its transaction guard, so they must run one after another.
    redundantIndexes: await readOptional<MysqlRedundantIndexRow>(gateway, 'redundantIndexes', notes, performanceNote),
  });
  const top = await readOptional<MysqlTopStatementRow>(gateway, 'topStatements', notes, performanceNote, [options.top]);
  for (const row of top) {
    // Only the normalized digest is printed; the sample text may hold literals and is used for
    // EXPLAIN only.
    const digestText = row.digest_text ?? '';
    const sampleText = row.sample_text ?? '';
    if (!dmlStart.test(digestText) || !/^\s*SELECT\b/i.test(sampleText)) continue;
    const subject =
      `\`${planEstimates.describeQuery(digestText)}\` (${checks.formatCount(Number(row.calls))} calls, mean ` +
      `${formatMs(row.mean_ms)} ms measured by performance_schema)`;
    findings.push(...(await mysqlPlanFindings(gateway, { sql: sampleText, subject, model })));
  }
  for (const query of context.queries) {
    const location: SourceLocation = { file: query.file, line: query.line, column: query.column };
    findings.push(...(await mysqlPlanFindings(gateway, { sql: query.sql, subject: 'This query', location, model })));
  }
  return {
    serverVersion: info.version,
    statsAgeDays: uptimeDays,
    findings,
    tables: snapshot.snapshotTables(model),
    roundTrip: await roundTripInUnit(gateway),
  };
}
