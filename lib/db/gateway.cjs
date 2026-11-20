'use strict';

const { ensureLoaded, parseExplainCandidate } = require('../sql/pg-parser.cjs');
const pgCatalog = require('./pg-catalog.cjs');

const explainableKinds = new Set(['SelectStmt', 'InsertStmt', 'UpdateStmt', 'DeleteStmt']);
const interruptExitCode = 130;

// The gateway refused to send something. Messages never quote the refused SQL.
class GatewayRefusal extends Error {}

function catalogFor(engine) {
  // MySQL support is loaded only for MySQL connections.
  return engine === 'mysql' ? require('./mysql-catalog.cjs') : pgCatalog;
}

function stripTerminator(sql) {
  return sql.trim().replace(/;\s*$/, '');
}

async function validatePostgresExplain(sql, { analyze }) {
  if (typeof sql !== 'string' || sql.trim() === '') throw new GatewayRefusal('EXPLAIN needs a statement.');
  await ensureLoaded();
  const candidate = parseExplainCandidate(sql);
  if (candidate.error) throw new GatewayRefusal(`The statement does not parse: ${candidate.error.message}`);
  if (!explainableKinds.has(candidate.kind)) {
    throw new GatewayRefusal('Only SELECT, INSERT, UPDATE and DELETE statements can be explained.');
  }
  if (!analyze) return;
  // EXPLAIN ANALYZE executes the statement, so only a plain SELECT may reach it.
  if (candidate.kind !== 'SelectStmt' || candidate.hasInto || candidate.hasLockingClause) {
    throw new GatewayRefusal('EXPLAIN ANALYZE runs only plain SELECT statements (no INTO, FOR UPDATE or writes).');
  }
  if (candidate.hasDataModifyingCte) {
    throw new GatewayRefusal('EXPLAIN ANALYZE refuses a SELECT whose WITH clause modifies data.');
  }
}

function postgresExplainPrefix({ generic, analyze }) {
  if (analyze) return 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ';
  return generic ? 'EXPLAIN (GENERIC_PLAN, FORMAT JSON) ' : 'EXPLAIN (FORMAT JSON) ';
}

function firstPlanDocument(rows) {
  const value = rows?.[0]?.['QUERY PLAN'] ?? rows?.[0]?.EXPLAIN;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * The only code that talks to the driver. It exposes catalog(id), explain(validated SQL) and unit(); nothing that
 * takes free SQL. `allowAnalyze` is set only by --analyze or --measure, `allowMeasure` only by --measure.
 */
function createGateway(adapter, options = {}) {
  const { allowAnalyze = false, allowMeasure = false, signals = process, exit = process.exit } = options;
  const engine = adapter.engine;
  const catalog = catalogFor(engine);
  let depth = 0;
  let broken = false;

  async function send(text, params) {
    if (broken) throw new GatewayRefusal('The connection was closed after an error.');
    return adapter.query(text, params);
  }

  async function destroy() {
    broken = true;
    await adapter.destroy();
  }

  async function rollbackOrDestroy(rollbackStatement) {
    try {
      await send(rollbackStatement);
    } catch {
      await destroy();
    }
  }

  // Ctrl+C mid-transaction still rolls back, then ends the session so nothing can stay open.
  async function withInterruptGuard(rollbackStatement, body) {
    const onInterrupt = () => {
      rollbackOrDestroy(rollbackStatement)
        .then(() => destroy())
        .catch(() => {})
        .finally(() => exit(interruptExitCode));
    };
    signals.on('SIGINT', onInterrupt);
    try {
      return await body();
    } finally {
      signals.off('SIGINT', onInterrupt);
    }
  }

  async function open() {
    for (const statement of catalog.sessionSetup) await send(statement);
  }

  async function unit(body) {
    if (depth > 0) return body();
    depth += 1;
    try {
      return await withInterruptGuard(catalog.control.rollback, async () => {
        await send(catalog.control.begin);
        try {
          for (const statement of catalog.unitSetup) {
            await send(statement);
          }
          return await body();
        } finally {
          await rollbackOrDestroy(catalog.control.rollback);
        }
      });
    } finally {
      depth -= 1;
    }
  }

  async function catalogQuery(id, params) {
    if (!Object.hasOwn(catalog.statements, id)) throw new GatewayRefusal(`Unknown catalog statement ${id}.`);
    return unit(() => send(catalog.statements[id], params));
  }

  async function explain(sql, { generic = false, analyze = false } = {}) {
    if (analyze && !allowAnalyze) throw new GatewayRefusal('EXPLAIN ANALYZE needs --analyze or --measure.');
    if (engine === 'mysql') {
      if (analyze) throw new GatewayRefusal('EXPLAIN ANALYZE is never run on MySQL.');
      catalog.validateExplain(sql);
      return firstPlanDocument(await unit(() => send(catalog.explainPrefix + stripTerminator(sql))));
    }
    await validatePostgresExplain(sql, { analyze });
    const text = postgresExplainPrefix({ generic, analyze }) + stripTerminator(sql);
    return firstPlanDocument(await unit(() => send(text)));
  }

  // --measure only: one read-write transaction that builds the index and is always rolled back.
  async function measureTransaction(body) {
    if (!allowMeasure || engine !== 'postgres') throw new GatewayRefusal('Index measurement needs --measure.');
    if (depth > 0) throw new GatewayRefusal('A measurement cannot run inside another transaction.');
    const { measureControl } = pgCatalog;
    depth += 1;
    let failed = false;
    try {
      return await withInterruptGuard(measureControl.rollback, async () => {
        await send(measureControl.begin);
        try {
          await send(measureControl.localLockTimeout);
          await send(measureControl.localStatementTimeout);
          return await body({
            createIndex: (index) => send(pgCatalog.indexDefinition(index)),
            readOnly: () => send(measureControl.readOnly),
            explainAnalyze: async (sql) => {
              await validatePostgresExplain(sql, { analyze: true });
              return firstPlanDocument(await send(postgresExplainPrefix({ analyze: true }) + stripTerminator(sql)));
            },
          });
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          await rollbackOrDestroy(measureControl.rollback);
          // On any error the session is destroyed, not reused, so a half-finished transaction cannot linger.
          if (failed && !broken) await destroy();
        }
      });
    } finally {
      depth -= 1;
    }
  }

  return {
    engine,
    open,
    unit,
    catalog: catalogQuery,
    explain,
    measureTransaction,
    close: () => (broken ? undefined : adapter.close()),
    destroy,
  };
}

module.exports = { createGateway, GatewayRefusal, interruptExitCode };
