'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const drivers = require('./drivers.cjs');
const { describeError, createRedactor } = require('./redact.cjs');
const { createGateway, GatewayRefusal } = require('./gateway.cjs');
const checks = require('./checks.cjs');
const planEstimates = require('./plan-estimates.cjs');
const hypopg = require('./hypopg.cjs');
const measure = require('./measure.cjs');
const snapshot = require('./snapshot.cjs');
const { formatImpact } = require('../impact.cjs');
const { assignFindingIds } = require('../finding-ids.cjs');
const { findingLabel } = require('../finding-text.cjs');

const usage = `Usage: warden-backend db [options]

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

function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
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
    throw new CliUsageError('Unknown or incomplete option for db. Run `warden-backend db --help`.');
  }
  const { values, positionals } = parsed;
  if (positionals.length) {
    const looksLikeUrl = positionals.some((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes('@'));
    throw new CliUsageError(
      looksLikeUrl
        ? 'db never takes a connection URL as an argument; pass the variable name: --url-env NAME.'
        : 'db takes no positional arguments. Run `warden-backend db --help`.',
    );
  }
  if (values.engine !== undefined && !engines.has(values.engine)) {
    throw new CliUsageError('--engine must be postgres, mysql or mongo.');
  }
  if (values.measure && !values.queries) throw new CliUsageError('--measure needs --queries with concrete SELECTs.');
  return {
    ...values,
    top: positiveInteger(values.top, defaultTop, maxTop, '--top'),
    runs: positiveInteger(values.runs, defaultRuns, maxRuns, '--runs'),
    ignore: new Set(values.ignore ?? []),
  };
}

function positiveInteger(text, fallback, maximum, flag) {
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new CliUsageError(`${flag} must be a whole number from 1 to ${maximum}.`);
  }
  return value;
}

async function readQueries(filename, engine) {
  let text;
  try {
    text = fs.readFileSync(filename, 'utf8');
  } catch {
    throw new CliUsageError('Could not read the --queries file.');
  }
  const notes = [];
  const queries = [];
  if (engine === 'mongo') throw new CliUsageError('--queries supports PostgreSQL and MySQL.');
  if (engine === 'postgres') {
    const parser = require('../sql/pg-parser.cjs');
    await parser.ensureLoaded();
    for (const statement of parser.parseStatements(text)) {
      if (statement.error) notes.push(`${filename}:${statement.line} does not parse and was skipped.`);
      else if (statement.kind !== 'SelectStmt')
        notes.push(`${filename}:${statement.line} is not a SELECT and was skipped.`);
      else queries.push({ sql: statement.text, file: filename, line: statement.line, column: statement.column });
    }
  } else {
    const { parseMysqlStatements } = require('../sql/mysql-tokens.cjs');
    for (const statement of parseMysqlStatements(text)) {
      if (/^\s*SELECT\b/i.test(statement.text)) {
        queries.push({ sql: statement.text, file: filename, line: statement.line, column: statement.column });
      } else notes.push(`${filename}:${statement.line} is not a SELECT and was skipped.`);
    }
  }
  return { queries, notes };
}

function formatMs(value) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: Number(value) < 10 ? 1 : 0 });
}

function dedupe(findings) {
  const seen = new Set();
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

async function roundTripInUnit(gateway) {
  return gateway.unit(() => snapshot.measureRoundTrip(() => gateway.catalog('roundTrip')));
}

// A HypoPG failure (privileges, an old version) downgrades to an unvalidated suggestion with one note.
async function tryHypothetical(gateway, context, request) {
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

async function topStatementFindings(gateway, context) {
  const { model, extensions, versionNum, options, notes } = context;
  if (!extensions.some((row) => row.name === 'pg_stat_statements')) {
    notes.push(
      'pg_stat_statements is not installed in this database, so slow statements are not listed. On staging, add it ' +
        'to shared_preload_libraries and run `CREATE EXTENSION pg_stat_statements;`.',
    );
    return [];
  }
  if (versionNum < require('./pg-catalog.cjs').minimumGenericPlanVersion) {
    notes.push('Slow statements are not explained: EXPLAIN (GENERIC_PLAN) needs PostgreSQL 16 or newer.');
    return [];
  }
  let rows;
  try {
    rows = await gateway.catalog('topStatements', [options.top]);
  } catch (error) {
    notes.push(`pg_stat_statements could not be read (${describeError(error, context.redact)}).`);
    return [];
  }
  const findings = [];
  let unexplained = 0;
  for (const row of rows) {
    // Utility statements (ALTER USER ...) are never explained or printed.
    if (!dmlStart.test(row.query ?? '')) continue;
    let plan;
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

async function measureQuery(gateway, context, { query, candidate }) {
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

function analyzeFindings(query, plan) {
  const { inspectPlan } = require('../plans.cjs');
  return inspectPlan(plan).findings.map((finding) => ({
    file: query.file,
    line: query.line,
    column: query.column,
    ruleId: finding.ruleId,
    message: finding.message + ' (EXPLAIN ANALYZE, measured, rolled back)',
  }));
}

async function postgresQueryFindings(gateway, context, queries) {
  const { model, options, notes } = context;
  const findings = [];
  for (const query of queries) {
    const location = { file: query.file, line: query.line, column: query.column };
    let plan;
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

async function inspectPostgres(gateway, context) {
  const { options, notes } = context;
  await gateway.open();
  const [info] = await gateway.catalog('serverInfo');
  if (options.measure) {
    const reasons = measure.serverRefusals({ databaseName: info.database_name, inRecovery: info.in_recovery });
    if (reasons.length) throw new measure.MeasureRefusal(reasons.join(' '));
  }
  const extensions = await gateway.catalog('extensions');
  const [age] = await gateway.catalog('statsAge');
  const statsAgeDays = age ? Number(age.stats_age_days) : undefined;
  const model = checks.buildPostgresModel({
    tables: await gateway.catalog('tables'),
    columns: await gateway.catalog('columns'),
    indexes: await gateway.catalog('indexes'),
    foreignKeys: await gateway.catalog('foreignKeys'),
  });
  const hasHypopg = hypopg.hypopgAvailable(extensions);
  if (!hasHypopg) notes.push(hypopg.missingNote);
  const shared = { ...context, model, extensions, versionNum: Number(info.version_num), hasHypopg };
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

async function readOptional(gateway, id, notes, note, params) {
  try {
    return await gateway.catalog(id, params);
  } catch {
    notes.push(note);
    return [];
  }
}

function mysqlScanFinding({ subject, location, scan, queryCost }) {
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

async function mysqlPlanFindings(gateway, { sql, subject, location, model }) {
  let plan;
  try {
    plan = await gateway.explain(sql);
  } catch {
    return [];
  }
  const { scans, queryCost } = planEstimates.mysqlFullScans(plan, model);
  return scans.map((scan) => mysqlScanFinding({ subject, location, scan, queryCost }));
}

async function inspectMysql(gateway, context) {
  const { options, notes } = context;
  if (options.analyze) notes.push('--analyze is ignored on MySQL: EXPLAIN ANALYZE executes the statement.');
  await gateway.open();
  const [info] = await gateway.catalog('serverInfo');
  const performanceNote = 'performance_schema or the sys schema is not readable, so index usage is not reported.';
  const [uptime] = await readOptional(gateway, 'uptime', notes, performanceNote);
  const uptimeDays = uptime ? Number(uptime.uptime_seconds) / 86_400 : undefined;
  const model = checks.buildMysqlModel({
    tables: await gateway.catalog('tables'),
    indexes: await gateway.catalog('indexes'),
    foreignKeys: await gateway.catalog('foreignKeys'),
  });
  const findings = checks.mysqlCatalogFindings(model, {
    uptimeDays,
    unusedIndexes: await readOptional(gateway, 'unusedIndexes', notes, performanceNote),
    redundantIndexes: await readOptional(gateway, 'redundantIndexes', notes, performanceNote),
  });
  const top = await readOptional(gateway, 'topStatements', notes, performanceNote, [options.top]);
  for (const row of top) {
    // Only the normalized digest is printed; the sample text may hold literals and is used for EXPLAIN only.
    if (!dmlStart.test(row.digest_text ?? '') || !/^\s*SELECT\b/i.test(row.sample_text ?? '')) continue;
    const subject =
      `\`${planEstimates.describeQuery(row.digest_text)}\` (${checks.formatCount(Number(row.calls))} calls, mean ` +
      `${formatMs(row.mean_ms)} ms measured by performance_schema)`;
    findings.push(...(await mysqlPlanFindings(gateway, { sql: row.sample_text, subject, model })));
  }
  for (const query of context.queries) {
    const location = { file: query.file, line: query.line, column: query.column };
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

async function inspectMongoEngine(adapter) {
  const { createMongoGateway, inspectMongo } = require('./mongo.cjs');
  const gateway = createMongoGateway(adapter);
  const result = await inspectMongo(gateway);
  const roundTrip = await snapshot.measureRoundTrip(() => gateway.command({ ping: 1 }));
  return { ...result, roundTrip };
}

function findingLocation(finding) {
  return finding.target ? `db:${finding.target}` : `${finding.file}:${finding.line}:${finding.column}`;
}

function printText(write, result, options) {
  for (const finding of result.findings) {
    const reason = finding.contextualReason ? ` (${finding.contextualReason})` : '';
    write(`${findingLocation(finding)} ${findingLabel(finding)} ${finding.message}${reason}`);
    const impact = formatImpact(finding.impact);
    if (impact) write('  ' + impact);
    if (finding.measurement) write('  Measured: ' + finding.measurement + '.');
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

function defaultDependencies() {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: (line) => process.stdout.write(line + '\n'),
    stderr: (line) => process.stderr.write(line + '\n'),
    loadDriver: drivers.loadDriver,
    connect: drivers.connect,
    signals: process,
    exit: process.exit,
  };
}

async function inspect(adapter, connection, options, dependencies, queries) {
  const context = {
    options,
    queries,
    notes: [],
    redact: connection.redact,
    stderr: (line) => dependencies.stderr(connection.redact(line)),
    measuredIndexNames: [],
    nextIndexName: measure.createIndexNamer(),
  };
  if (connection.engine === 'mongo') return inspectMongoEngine(adapter);
  const gateway = createGateway(adapter, {
    allowAnalyze: Boolean(options.analyze || options.measure),
    allowMeasure: Boolean(options.measure),
    signals: dependencies.signals,
    exit: dependencies.exit,
  });
  const inspected = await (connection.engine === 'postgres' ? inspectPostgres : inspectMysql)(gateway, context);
  return { ...inspected, notes: context.notes };
}

async function execute(argv, dependencies) {
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
    throw Object.assign(error, { redact: connection.redact });
  }
}

async function executeWithConnection(options, connection, dependencies) {
  if (options.measure) {
    const reasons = measure.preconnectRefusals({
      engine: connection.engine,
      confirmed: options['i-understand-this-locks-tables'],
      envVarNames: connection.envVarNames,
      databaseName: connection.databaseName,
    });
    if (reasons.length) throw new measure.MeasureRefusal(reasons.join(' '));
  }
  const loaded = options.queries ? await readQueries(options.queries, connection.engine) : { queries: [], notes: [] };
  const driver = dependencies.loadDriver(connection.engine, drivers.findProjectRoot(dependencies.cwd));
  const adapter = await dependencies.connect(driver, connection);
  let inspected;
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
  const all = identified.filter((finding) => !options.ignore.has(finding.ruleId));
  const shown = options['include-contextual'] ? all : all.filter((finding) => !finding.contextualReason);
  const result = {
    engine: connection.engine,
    serverVersion: inspected.serverVersion,
    roundTrip: inspected.roundTrip,
    statsAgeDays: inspected.statsAgeDays,
    findings: shown,
    contextualCount: all.length - all.filter((finding) => !finding.contextualReason).length,
    notes: [...loaded.notes, ...inspected.notes].map(connection.redact),
  };
  if (options.json) dependencies.stdout(JSON.stringify(result, null, 2));
  else printText(dependencies.stdout, result, options);
  return shown.some((finding) => !finding.contextualReason) ? 1 : 0;
}

/** Entry point for `warden-backend db`. Resolves to 0 (clean), 1 (findings) or 2 (usage or connection error). */
async function run(argv, overrides = {}) {
  const dependencies = { ...defaultDependencies(), ...overrides };
  try {
    return await execute(argv, dependencies);
  } catch (error) {
    const redact = error?.redact ?? createRedactor();
    const known =
      error instanceof CliUsageError ||
      error instanceof drivers.DbUsageError ||
      error instanceof GatewayRefusal ||
      error instanceof measure.MeasureRefusal;
    dependencies.stderr(redact(known ? error.message : `db failed: ${describeError(error, redact)}`));
    return 2;
  }
}

module.exports = { run, usage };
