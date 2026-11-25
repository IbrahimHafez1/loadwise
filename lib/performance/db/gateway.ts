import { ensureLoaded, parseExplainCandidate } from '../sql/pg-parser.js';
import * as pgCatalog from './pg-catalog.js';
import * as mysqlCatalog from './mysql-catalog.js';
import type {
  DbRow,
  ExplainOptions,
  IndexDefinitionParts,
  MeasureTransaction,
  RelationalAdapter,
  RelationalGateway,
  SignalSource,
} from '../types/db-connection.js';
import type { PlanDocument, PlanRow } from '../types/db-plan.js';

// The statements and transaction control of one engine's catalog module.
interface CatalogModule {
  statements: Readonly<Record<string, string>>;
  control: { readonly begin: string; readonly rollback: string };
  sessionSetup: readonly string[];
  unitSetup: readonly string[];
}

interface MysqlCatalogModule extends CatalogModule {
  validateExplain(sql: string): void;
  explainPrefix: string;
}

interface GatewayOptions {
  allowAnalyze?: boolean;
  allowMeasure?: boolean;
  signals?: SignalSource;
  exit?: (code: number) => unknown;
}

const explainableKinds = new Set(['SelectStmt', 'InsertStmt', 'UpdateStmt', 'DeleteStmt']);
const interruptExitCode = 130;

// The gateway refused to send something. Messages never quote the refused SQL.
class GatewayRefusal extends Error {}

function loadMysqlCatalog(): MysqlCatalogModule {
  return mysqlCatalog;
}

function stripTerminator(sql: string) {
  return sql.trim().replace(/;\s*$/, '');
}

async function validatePostgresExplain(sql: string, { analyze }: Pick<ExplainOptions, 'analyze'>) {
  if (typeof sql !== 'string' || sql.trim() === '') throw new GatewayRefusal('EXPLAIN needs a statement.');
  await ensureLoaded();
  const candidate = parseExplainCandidate(sql);
  if ('error' in candidate) throw new GatewayRefusal(`The statement does not parse: ${candidate.error.message}`);
  if (!explainableKinds.has(candidate.kind ?? '')) {
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

function postgresExplainPrefix({ generic, analyze }: ExplainOptions) {
  if (analyze) return 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ';
  return generic ? 'EXPLAIN (GENERIC_PLAN, FORMAT JSON) ' : 'EXPLAIN (FORMAT JSON) ';
}

function firstPlanDocument(rows: PlanRow[]): PlanDocument {
  const value = rows?.[0]?.['QUERY PLAN'] ?? rows?.[0]?.EXPLAIN;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * The only code that talks to the driver. It exposes catalog(id), explain(validated SQL) and
 * unit(); nothing that takes free SQL. `allowAnalyze` is set only by --analyze or --measure,
 * `allowMeasure` only by --measure.
 */
function createGateway(adapter: RelationalAdapter, options: GatewayOptions = {}): RelationalGateway {
  const { allowAnalyze = false, allowMeasure = false, signals = process, exit = process.exit } = options;
  const engine = adapter.engine;
  const mysqlCatalog = engine === 'mysql' ? loadMysqlCatalog() : undefined;
  const catalog: CatalogModule = mysqlCatalog ?? pgCatalog;
  let depth = 0;
  let broken = false;

  async function send<Row = DbRow>(text: string, params?: readonly unknown[]) {
    if (broken) throw new GatewayRefusal('The connection was closed after an error.');
    return adapter.query<Row>(text, params);
  }

  async function destroy() {
    broken = true;
    await adapter.destroy();
  }

  async function rollbackOrDestroy(rollbackStatement: string) {
    try {
      await send(rollbackStatement);
    } catch {
      await destroy();
    }
  }

  // Ctrl+C mid-transaction still rolls back, then ends the session so nothing can stay open.
  async function withInterruptGuard<Result>(rollbackStatement: string, body: () => Promise<Result>) {
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

  async function unit<Result>(body: () => Promise<Result> | Result) {
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

  async function catalogQuery<Row = DbRow>(id: string, params?: readonly unknown[]) {
    if (!Object.hasOwn(catalog.statements, id)) throw new GatewayRefusal(`Unknown catalog statement ${id}.`);
    return unit(() => send<Row>(catalog.statements[id], params));
  }

  async function explain(sql: string, { generic = false, analyze = false }: ExplainOptions = {}) {
    if (analyze && !allowAnalyze) throw new GatewayRefusal('EXPLAIN ANALYZE needs --analyze or --measure.');
    if (mysqlCatalog) {
      if (analyze) throw new GatewayRefusal('EXPLAIN ANALYZE is never run on MySQL.');
      try {
        mysqlCatalog.validateExplain(sql);
      } catch (error) {
        throw new GatewayRefusal(error instanceof Error ? error.message : String(error));
      }
      return firstPlanDocument(await unit(() => send<PlanRow>(mysqlCatalog.explainPrefix + stripTerminator(sql))));
    }
    await validatePostgresExplain(sql, { analyze });
    const text = postgresExplainPrefix({ generic, analyze }) + stripTerminator(sql);
    return firstPlanDocument(await unit(() => send<PlanRow>(text)));
  }

  // --measure only: one read-write transaction that builds the index and is always rolled back.
  async function measureTransaction<Result>(body: (transaction: MeasureTransaction) => Promise<Result>) {
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
            createIndex: (index: IndexDefinitionParts) => send(pgCatalog.indexDefinition(index)),
            readOnly: () => send(measureControl.readOnly),
            explainAnalyze: async (sql: string) => {
              await validatePostgresExplain(sql, { analyze: true });
              return firstPlanDocument(
                await send<PlanRow>(postgresExplainPrefix({ analyze: true }) + stripTerminator(sql)),
              );
            },
          });
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          await rollbackOrDestroy(measureControl.rollback);
          // On any error the session is destroyed, not reused, so a half-finished transaction
          // cannot linger.
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

export { createGateway, GatewayRefusal, interruptExitCode };
