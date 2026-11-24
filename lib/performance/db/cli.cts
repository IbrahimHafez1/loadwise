import fs from 'node:fs';
import { parseArgs } from 'node:util';
import * as drivers from './drivers.cjs';
import { describeError, createRedactor } from './redact.cjs';
import { createGateway, GatewayRefusal } from './gateway.cjs';
import * as checks from './checks.cjs';
import * as planEstimates from './plan-estimates.cjs';
import * as hypopg from './hypopg.cjs';
import * as measure from './measure.cjs';
import * as snapshot from './snapshot.cjs';
import { formatImpact } from '../impact.cjs';
import { assignFindingIds } from '../finding-ids.cjs';
import { findingLabel } from '../finding-text.cjs';
import type { Finding } from '../../shared/types.cjs';
import type {
  DbAdapter,
  DbConnection,
  DbEngine,
  MongoAdapter,
  Redactor,
  RelationalGateway,
  SignalSource,
} from '../types/db-connection.cjs';
import type {
  DbFinding,
  ExtensionRow,
  MysqlRedundantIndexRow,
  MysqlUnusedIndexRow,
  SchemaModel,
} from '../types/db-model.cjs';
import type { PlanDocument } from '../types/db-plan.cjs';
import type {
  HypotheticalResult,
  Measurement,
  MysqlFullScan,
  SeqScanCandidate,
  SourceLocation,
} from '../types/db-plan-findings.cjs';
import type { RoundTrip, SnapshotTables } from '../types/db-snapshot.cjs';
import * as parser from '../sql/pg-parser.cjs';
import { parseMysqlStatements } from '../sql/mysql-tokens.cjs';
import { minimumGenericPlanVersion } from './pg-catalog.cjs';
import { inspectPlan } from '../plans.cjs';
import { createMongoGateway, inspectMongo } from './mongo.cjs';

const usage = `Usage: loadwise perf db [options]

Inspects a live or staging database read-only. The connection comes from an environment variable, never a flag:
DATABASE_URL (or the variable named by --url-env), else DB_HOST, DB_PORT, DB_USER|DB_USERNAME, DB_PASSWORD and
DB_NAME|DB_DATABASE. The driver is the project's own pg, mysql2 or mongodb package.

Options:
  --url-env NAME              Variable holding the connection URL (default DATABASE_URL)
  --env-file FILE             Read the variables from FILE only, without loading it into the environment
  --engine postgres|mysql|mongo
                              Needed with DB_HOST-style variables when DB_PORT is not the engine default
  --schema-snapshot FILE      Write a version 1 schema snapshot for --schema
  --top N                     Slowest statements to explain (default 20)
  --queries FILE              Concrete SELECT statements to explain
  --analyze                   Run EXPLAIN ANALYZE on --queries SELECTs inside rolled-back read-only transactions
  --measure --i-understand-this-locks-tables
                              PostgreSQL staging only: time each suggested index for --queries by building it
                              inside a rolled-back transaction (blocks writes to that table meanwhile)
  --runs N                    EXPLAIN ANALYZE runs per side for --measure (default 5)
  --include-contextual        Show findings held back as contextual
  --ignore RULE               Skip a rule (repeatable)
  --json                      Print JSON`;

const engines = new Set(['postgres', 'mysql', 'mongo']);
const defaultTop = 20;
const defaultRuns = 5;
const maxTop = 1000;
const maxRuns = 50;
const dmlStart = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;

class CliUsageError extends Error {}

/** The options of `loadwise perf db` after validation. */
interface DbOptions {
  'url-env'?: string;
  'env-file'?: string;
  engine?: DbEngine;
  'schema-snapshot'?: string;
  top: number;
  queries?: string;
  analyze?: boolean;
  measure?: boolean;
  'i-understand-this-locks-tables'?: boolean;
  runs: number;
  'include-contextual'?: boolean;
  ignore: Set<string>;
  json?: boolean;
  help?: boolean;
}

/** A concrete statement from `--queries`, with where it was written. */
interface DbQuery extends SourceLocation {
  sql: string;
}

interface QueryLoad {
  queries: DbQuery[];
  notes: string[];
}

/**
 * What every inspection shares: the parsed options, the statements to explain and the notes
 * collected so far.
 */
interface InspectContext {
  options: DbOptions;
  queries: DbQuery[];
  notes: string[];
  redact: Redactor;
  stderr: (line: string) => unknown;
  measuredIndexNames: string[];
  nextIndexName: () => string;
}

interface PostgresContext extends InspectContext {
  model: SchemaModel;
  extensions: ExtensionRow[];
  versionNum: number;
  hasHypopg: boolean;
}

interface ServerInfoRow {
  version: string;
  database_name: string;
  version_num?: number;
  in_recovery?: boolean;
}

interface PgTopStatementRow {
  query: string | null;
  calls: number | string;
  mean_exec_time: number | string;
}

interface MysqlTopStatementRow {
  digest_text: string | null;
  sample_text: string | null;
  calls: number | string;
  mean_ms: number | string;
}

/** The outcome of inspecting one database, before findings are identified and filtered. */
interface Inspection {
  serverVersion: string;
  statsAgeDays?: number;
  findings: DbFinding[];
  tables: SnapshotTables;
  roundTrip: RoundTrip;
  notes: string[];
}

type InspectionWithoutNotes = Omit<Inspection, 'notes'>;

interface DbResult {
  engine: DbEngine;
  serverVersion: string;
  roundTrip?: RoundTrip;
  statsAgeDays?: number;
  findings: Finding[];
  contextualCount: number;
  notes: string[];
}

interface DbDependencies {
  env: Record<string, string | undefined>;
  cwd: string;
  stdout: (line: string) => unknown;
  stderr: (line: string) => unknown;
  loadDriver: typeof drivers.loadDriver;
  connect: typeof drivers.connect;
  signals: SignalSource;
  exit: (code: number) => unknown;
}

interface MysqlScanRequest {
  sql: string;
  subject: string;
  location?: SourceLocation;
  model: SchemaModel;
}

interface PlanRequest {
  query: DbQuery;
  candidate: SeqScanCandidate;
}

function readArguments(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'url-env': { type: 'string' },
        'env-file': { type: 'string' },
        engine: { type: 'string' },
        'schema-snapshot': { type: 'string' },
        top: { type: 'string' },
        queries: { type: 'string' },
        analyze: { type: 'boolean' },
        measure: { type: 'boolean' },
        'i-understand-this-locks-tables': { type: 'boolean' },
        runs: { type: 'string' },
        'include-contextual': { type: 'boolean' },
        ignore: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch {
    // The parser's message can quote the argument, which might be a pasted URL.
    throw new CliUsageError('Unknown or incomplete option for db. Run `loadwise perf db --help`.');
  }
}

function isDbEngine(value: string): value is DbEngine {
  return engines.has(value);
}

function parseOptions(argv: string[]): DbOptions {
  const { values, positionals } = readArguments(argv);
  if (positionals.length) {
    const looksLikeUrl = positionals.some((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes('@'));
    throw new CliUsageError(
      looksLikeUrl
        ? 'db never takes a connection URL as an argument; pass the variable name: --url-env NAME.'
        : 'db takes no positional arguments. Run `loadwise perf db --help`.',
    );
  }
  if (values.engine !== undefined && !isDbEngine(values.engine)) {
    throw new CliUsageError('--engine must be postgres, mysql or mongo.');
  }
  if (values.measure && !values.queries) throw new CliUsageError('--measure needs --queries with concrete SELECTs.');
  return {
    ...values,
    engine: values.engine,
    top: positiveInteger(values.top, defaultTop, maxTop, '--top'),
    runs: positiveInteger(values.runs, defaultRuns, maxRuns, '--runs'),
    ignore: new Set(values.ignore ?? []),
  };
}

function positiveInteger(text: string | undefined, fallback: number, maximum: number, flag: string) {
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new CliUsageError(`${flag} must be a whole number from 1 to ${maximum}.`);
  }
  return value;
}

async function readQueries(filename: string, engine: DbEngine): Promise<QueryLoad> {
  let text: string;
  try {
    text = await fs.promises.readFile(filename, 'utf8');
  } catch {
    throw new CliUsageError('Could not read the --queries file.');
  }
  const notes: string[] = [];
  const queries: DbQuery[] = [];
  if (engine === 'mongo') throw new CliUsageError('--queries supports PostgreSQL and MySQL.');
  if (engine === 'postgres') {
    await parser.ensureLoaded();
    for (const statement of parser.parseStatements(text)) {
      if (statement.error) notes.push(`${filename}:${statement.line} does not parse and was skipped.`);
      else if (statement.kind !== 'SelectStmt')
        notes.push(`${filename}:${statement.line} is not a SELECT and was skipped.`);
      else queries.push({ sql: statement.text, file: filename, line: statement.line, column: statement.column });
    }
  } else {
    for (const statement of parseMysqlStatements(text)) {
      if (/^\s*SELECT\b/i.test(statement.text)) {
        queries.push({ sql: statement.text, file: filename, line: statement.line, column: statement.column });
      } else notes.push(`${filename}:${statement.line} is not a SELECT and was skipped.`);
    }
  }
  return { queries, notes };
}

function formatMs(value: number | string) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: Number(value) < 10 ? 1 : 0 });
}

function dedupe(findings: DbFinding[]) {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = [
      finding.target ?? `${finding.file}:${finding.line}`,
      finding.ruleId,
      finding.suggestion ?? finding.message,
    ].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function roundTripInUnit(gateway: RelationalGateway) {
  return gateway.unit(() => snapshot.measureRoundTrip(() => gateway.catalog('roundTrip')));
}

// A HypoPG failure (privileges, an old version) downgrades to an unvalidated suggestion with one
// note.
async function tryHypothetical(
  gateway: RelationalGateway,
  context: PostgresContext,
  request: { sql: string; generic: boolean; candidate: SeqScanCandidate },
): Promise<HypotheticalResult | undefined> {
  if (!context.hasHypopg) return;
  try {
    return await hypopg.evaluateHypotheticalIndex(gateway, request);
  } catch (error) {
    context.hasHypopg = false;
    context.notes.push(
      `HypoPG could not be used (${describeError(error, context.redact)}); suggestions are not validated.`,
    );
  }
}

async function topStatementFindings(gateway: RelationalGateway, context: PostgresContext) {
  const { model, extensions, versionNum, options, notes } = context;
  if (!extensions.some((row) => row.name === 'pg_stat_statements')) {
    notes.push(
      'pg_stat_statements is not installed in this database, so slow statements are not listed. On staging, add it ' +
        'to shared_preload_libraries and run `CREATE EXTENSION pg_stat_statements;`.',
    );
    return [];
  }
  if (versionNum < minimumGenericPlanVersion) {
    notes.push('Slow statements are not explained: EXPLAIN (GENERIC_PLAN) needs PostgreSQL 16 or newer.');
    return [];
  }
  let rows: PgTopStatementRow[];
  try {
    rows = await gateway.catalog<PgTopStatementRow>('topStatements', [options.top]);
  } catch (error) {
    notes.push(`pg_stat_statements could not be read (${describeError(error, context.redact)}).`);
    return [];
  }
  const findings: DbFinding[] = [];
  let unexplained = 0;
  for (const row of rows) {
    // Utility statements (ALTER USER ...) are never explained or printed.
    if (!row.query || !dmlStart.test(row.query)) continue;
    let plan: PlanDocument;
    try {
      plan = await gateway.explain(row.query, { generic: true });
    } catch {
      unexplained += 1;
      continue;
    }
    const subject =
      `\`${planEstimates.describeQuery(row.query)}\` (${checks.formatCount(Number(row.calls))} calls, mean ` +
      `${formatMs(row.mean_exec_time)} ms measured by pg_stat_statements)`;
    for (const candidate of planEstimates.seqScanCandidates(plan, model)) {
      const fix = checks.createIndexSql(candidate.table, candidate.columns);
      const hypothetical = await tryHypothetical(gateway, context, { sql: row.query, generic: true, candidate });
      findings.push(planEstimates.planFinding({ subject, candidate, fix, hypothetical }));
    }
  }
  if (unexplained)
    notes.push(`${unexplained} statement(s) from pg_stat_statements could not be explained and were skipped.`);
  return findings;
}

async function measureQuery(
  gateway: RelationalGateway,
  context: InspectContext,
  { query, candidate }: PlanRequest,
): Promise<Measurement | undefined> {
  const refusal = measure.tableRefusal(candidate.table);
  if (refusal) {
    context.notes.push(refusal);
    return;
  }
  context.stderr(measure.lockWarning(candidate.table));
  const indexName = context.nextIndexName();
  context.measuredIndexNames.push(indexName);
  return measure.measureCandidate(gateway, { sql: query.sql, candidate, runs: context.options.runs, indexName });
}

function analyzeFindings(query: DbQuery, plan: PlanDocument): DbFinding[] {
  return inspectPlan(plan).findings.map((finding) => ({
    file: query.file,
    line: query.line,
    column: query.column,
    ruleId: finding.ruleId,
    message: finding.message + ' (EXPLAIN ANALYZE, measured, rolled back)',
  }));
}

async function postgresQueryFindings(gateway: RelationalGateway, context: PostgresContext, queries: DbQuery[]) {
  const { model, options, notes } = context;
  const findings: DbFinding[] = [];
  for (const query of queries) {
    const location: SourceLocation = { file: query.file, line: query.line, column: query.column };
    let plan: PlanDocument;
    try {
      if (options.analyze || options.measure) {
        findings.push(...analyzeFindings(query, await gateway.explain(query.sql, { analyze: true })));
      }
      plan = await gateway.explain(query.sql);
    } catch (error) {
      if (error instanceof GatewayRefusal) throw error;
      notes.push(`${query.file}:${query.line} could not be explained (${describeError(error, context.redact)}).`);
      continue;
    }
    for (const candidate of planEstimates.seqScanCandidates(plan, model)) {
      const fix = checks.createIndexSql(candidate.table, candidate.columns);
      const hypothetical = await tryHypothetical(gateway, context, { sql: query.sql, generic: false, candidate });
      const measured = options.measure ? await measureQuery(gateway, context, { query, candidate }) : undefined;
      const finding = planEstimates.planFinding({
        subject: 'This query',
        location,
        candidate,
        fix,
        hypothetical,
        measured: measured?.impact,
      });
      if (measured) finding.measurement = measure.describeMeasurement(measured);
      findings.push(finding);
    }
  }
  return findings;
}

async function inspectPostgres(gateway: RelationalGateway, context: InspectContext): Promise<InspectionWithoutNotes> {
  const { options, notes } = context;
  await gateway.open();
  const [info] = await gateway.catalog<ServerInfoRow>('serverInfo');
  if (options.measure) {
    const reasons = measure.serverRefusals({ databaseName: info.database_name, inRecovery: info.in_recovery });
    if (reasons.length) throw new measure.MeasureRefusal(reasons.join(' '));
  }
  const extensions = await gateway.catalog<ExtensionRow>('extensions');
  const [age] = await gateway.catalog<{ stats_age_days: number | string }>('statsAge');
  const statsAgeDays = age ? Number(age.stats_age_days) : undefined;
  const model = checks.buildPostgresModel({
    tables: await gateway.catalog('tables'),
    // loadwise-reviewed serial-awaits-in-literal -- gateway.catalog runs each read in its own transaction on one shared connection, so overlapping them would interleave those transactions.
    columns: await gateway.catalog('columns'),
    indexes: await gateway.catalog('indexes'),
    foreignKeys: await gateway.catalog('foreignKeys'),
  });
  const hasHypopg = hypopg.hypopgAvailable(extensions);
  if (!hasHypopg) notes.push(hypopg.missingNote);
  const shared: PostgresContext = { ...context, model, extensions, versionNum: Number(info.version_num), hasHypopg };
  const findings = [
    ...checks.postgresCatalogFindings(model, { statsAgeDays }),
    ...(await topStatementFindings(gateway, shared)),
    ...(await postgresQueryFindings(gateway, shared, context.queries)),
  ];
  await measure.assertNoIndexesLeft(gateway, context.measuredIndexNames);
  return {
    serverVersion: info.version,
    statsAgeDays,
    findings,
    tables: snapshot.snapshotTables(model),
    roundTrip: await roundTripInUnit(gateway),
  };
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

async function inspectMysql(gateway: RelationalGateway, context: InspectContext): Promise<InspectionWithoutNotes> {
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

async function inspectMongoEngine(adapter: MongoAdapter): Promise<Inspection> {
  const gateway = createMongoGateway(adapter);
  const result = await inspectMongo(gateway);
  const roundTrip = await snapshot.measureRoundTrip(() => gateway.command<unknown>({ ping: 1 }));
  return { ...result, roundTrip };
}

function findingLocation(finding: Finding) {
  return finding.target ? `db:${finding.target}` : `${finding.file}:${finding.line}:${finding.column}`;
}

function printText(write: (line: string) => unknown, result: DbResult, options: DbOptions) {
  for (const finding of result.findings) {
    const reason = finding.contextualReason ? ` (${finding.contextualReason})` : '';
    write(`${findingLocation(finding)} ${findingLabel(finding)} ${finding.message}${reason}`);
    const impact = formatImpact(finding.impact);
    if (impact) write('  ' + impact);
    if (finding.measurement) write(`  Measured: ${finding.measurement}.`);
  }
  for (const note of result.notes) write('Note: ' + note);
  const roundTrip = result.roundTrip
    ? ` Round trip ${formatMs(result.roundTrip.medianMs)} ms measured from this host (median of ` +
      `${result.roundTrip.runs}); the app server's latency can differ.`
    : '';
  write(`${result.engine} ${result.serverVersion}: ${result.findings.length} finding(s).${roundTrip}`);
  if (result.contextualCount && !options['include-contextual']) {
    write(`${result.contextualCount} contextual finding(s) available with --include-contextual.`);
  }
}

function defaultDependencies(): DbDependencies {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: (line: string) => process.stdout.write(line + '\n'),
    stderr: (line: string) => process.stderr.write(line + '\n'),
    loadDriver: drivers.loadDriver,
    connect: drivers.connect,
    signals: process,
    exit: process.exit,
  };
}

async function inspect(
  adapter: DbAdapter,
  connection: DbConnection,
  options: DbOptions,
  dependencies: DbDependencies,
  queries: DbQuery[],
): Promise<Inspection> {
  const context: InspectContext = {
    options,
    queries,
    notes: [],
    redact: connection.redact,
    stderr: (line: string) => dependencies.stderr(connection.redact(line)),
    measuredIndexNames: [],
    nextIndexName: measure.createIndexNamer(),
  };
  if (adapter.engine === 'mongo') return inspectMongoEngine(adapter);
  const gateway = createGateway(adapter, {
    allowAnalyze: Boolean(options.analyze || options.measure),
    allowMeasure: Boolean(options.measure),
    signals: dependencies.signals,
    exit: dependencies.exit,
  });
  const inspected = await (connection.engine === 'postgres' ? inspectPostgres : inspectMysql)(gateway, context);
  return { ...inspected, notes: context.notes };
}

async function execute(argv: string[], dependencies: DbDependencies): Promise<number> {
  const options = parseOptions(argv);
  if (options.help) {
    dependencies.stdout(usage);
    return 0;
  }
  const connection = drivers.resolveConnection({
    env: dependencies.env,
    urlEnv: options['url-env'],
    envFile: options['env-file'],
    engine: options.engine,
  });
  try {
    return await executeWithConnection(options, connection, dependencies);
  } catch (error) {
    const failure: object = Object(error);
    throw Object.assign(failure, { redact: connection.redact });
  }
}

async function executeWithConnection(
  options: DbOptions,
  connection: DbConnection,
  dependencies: DbDependencies,
): Promise<number> {
  if (options.measure) {
    const reasons = measure.preconnectRefusals({
      engine: connection.engine,
      confirmed: options['i-understand-this-locks-tables'],
      envVarNames: connection.envVarNames,
      databaseName: connection.databaseName,
    });
    if (reasons.length) throw new measure.MeasureRefusal(reasons.join(' '));
  }
  const loaded: QueryLoad = options.queries
    ? await readQueries(options.queries, connection.engine)
    : { queries: [], notes: [] };
  const driver = dependencies.loadDriver(connection.engine, drivers.findProjectRoot(dependencies.cwd));
  const adapter = await dependencies.connect(driver, connection);
  let inspected: Inspection;
  try {
    inspected = await inspect(adapter, connection, options, dependencies, loaded.queries);
  } catch (error) {
    await adapter.destroy().catch(() => {});
    throw error;
  }
  await adapter.close().catch(() => {});
  if (options['schema-snapshot']) {
    snapshot.writeSnapshot(
      options['schema-snapshot'],
      snapshot.buildSnapshot({ dialect: connection.engine, ...inspected }),
    );
  }
  // Table findings hash their target; findings from --queries hash their file and line text.
  const identified = assignFindingIds(dedupe(inspected.findings), drivers.findProjectRoot(dependencies.cwd));
  const all = identified.filter((finding: Finding) => !options.ignore.has(finding.ruleId));
  const shown = options['include-contextual'] ? all : all.filter((finding: Finding) => !finding.contextualReason);
  const result: DbResult = {
    engine: connection.engine,
    serverVersion: inspected.serverVersion,
    roundTrip: inspected.roundTrip,
    statsAgeDays: inspected.statsAgeDays,
    findings: shown,
    contextualCount: all.length - all.filter((finding: Finding) => !finding.contextualReason).length,
    notes: [...loaded.notes, ...inspected.notes].map(connection.redact),
  };
  if (options.json) dependencies.stdout(JSON.stringify(result, null, 2));
  else printText(dependencies.stdout, result, options);
  return shown.some((finding: Finding) => !finding.contextualReason) ? 1 : 0;
}

function hasRedactor(error: unknown): error is { redact: Redactor } {
  return typeof error === 'object' && error !== null && 'redact' in error && typeof error.redact === 'function';
}

function isKnownFailure(error: unknown): error is Error {
  return (
    error instanceof CliUsageError ||
    error instanceof drivers.DbUsageError ||
    error instanceof GatewayRefusal ||
    error instanceof measure.MeasureRefusal
  );
}

/**
 * Entry point for `loadwise perf db`. Resolves to 0 (clean), 1 (findings) or 2 (usage or connection
 * error).
 */
async function run(argv: string[], overrides: Partial<DbDependencies> = {}): Promise<number> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  try {
    return await execute(argv, dependencies);
  } catch (error) {
    const redact = hasRedactor(error) ? error.redact : createRedactor();
    dependencies.stderr(redact(isKnownFailure(error) ? error.message : `db failed: ${describeError(error, redact)}`));
    return 2;
  }
}

export { run, usage };
