import { EventEmitter } from 'node:events';
import { ensureLoaded, parseExplainCandidate } from '../../lib/performance/sql/pg-parser.cjs';
import * as pgCatalog from '../../lib/performance/db/pg-catalog.cjs';
import type { RelationalAdapter } from '../../lib/performance/types/db-connection.cjs';
import type { TableModel } from '../../lib/performance/types/db-model.cjs';
import type { SizedTable } from '../../lib/performance/types/db-plan-findings.cjs';
import type { RecordedStatement, RecordingAdapterOptions, StatementCatalog } from '../types/db-fake.cjs';

interface RecordingAdapter extends RelationalAdapter {
  sent: RecordedStatement[];
  destroyed: boolean;
  closed: boolean;
}

interface RecordingSignals extends EventEmitter {
  exitCodes: number[];
  exit(code: number): number;
}

const explainPrefixes = [
  'EXPLAIN (FORMAT JSON) ',
  'EXPLAIN (GENERIC_PLAN, FORMAT JSON) ',
  'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ',
];

function catalogIdOf(catalog: StatementCatalog, text: string): string | undefined {
  return Object.entries(catalog.statements).find(([, statement]) => statement === text)?.[0];
}

/**
 * A driver adapter that records every statement. `responses` maps a catalog id (or 'explain') to
 * rows or to a function (params, text) => rows; a thrown error simulates a server error.
 */
function createRecordingAdapter({
  engine = 'postgres',
  catalog = pgCatalog,
  responses = {},
}: RecordingAdapterOptions = {}): RecordingAdapter {
  const adapter: RecordingAdapter = {
    engine,
    sent: [],
    destroyed: false,
    closed: false,
    async query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]> {
      adapter.sent.push(params === undefined ? { text } : { text, params });
      const id = catalogIdOf(catalog, text) ?? (text.startsWith('EXPLAIN') ? 'explain' : text);
      const response = responses[id];
      // The fake cannot know the caller's `Row`; the recorded response is trusted to match it.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- the fake trusts the recorded response to match the caller
      return (typeof response === 'function' ? response(params, text) : (response ?? [])) as Row[];
    },
    async destroy() {
      adapter.destroyed = true;
    },
    async close() {
      adapter.closed = true;
    },
  };
  return adapter;
}

function createSignals(): RecordingSignals {
  const exitCodes: number[] = [];
  const signals: RecordingSignals = Object.assign(new EventEmitter(), {
    exitCodes,
    exit: (code: number) => exitCodes.push(code),
  });
  return signals;
}

// 4.2 (a): each statement is a catalog constant, a fixed control statement, or a validated EXPLAIN.
async function disallowedPostgresStatements(
  sent: readonly RecordedStatement[],
  { allowMeasure = false }: { allowMeasure?: boolean } = {},
): Promise<string[]> {
  await ensureLoaded();
  const fixed = new Set<string>([...Object.values(pgCatalog.statements), ...Object.values(pgCatalog.control)]);
  if (allowMeasure) for (const statement of Object.values(pgCatalog.measureControl)) fixed.add(statement);
  return sent
    .map(({ text }) => text)
    .filter((text: string) => {
      if (fixed.has(text)) return false;
      if (allowMeasure && /^CREATE INDEX "backend_perf_check_\w+" ON "[^"]+"\."[^"]+" \(.+\)$/.test(text)) return false;
      const prefix = explainPrefixes.find((candidate) => text.startsWith(candidate));
      if (!prefix) return true;
      const parsed = parseExplainCandidate(text.slice(prefix.length));
      return 'error' in parsed || !['SelectStmt', 'InsertStmt', 'UpdateStmt', 'DeleteStmt'].includes(parsed.kind ?? '');
    });
}

// 4.2 (d): every BEGIN is matched by a ROLLBACK before the next BEGIN or the end.
function unbalancedTransactions(sent: readonly RecordedStatement[]): boolean {
  let open = false;
  for (const { text } of sent) {
    if (text.startsWith('BEGIN') || text.startsWith('START TRANSACTION')) {
      if (open) return true;
      open = true;
    } else if (text === 'ROLLBACK') open = false;
  }
  return open;
}

// A table model with the structural members a test does not care about left empty.
function createTable(schema: string, name: string, overrides: Partial<TableModel> = {}): TableModel {
  return { schema, name, columns: [], indexes: [], foreignKeys: [], ...overrides };
}

function createSizedTable(
  schema: string,
  name: string,
  rowEstimate: number,
  overrides: Partial<TableModel> = {},
): SizedTable {
  return { ...createTable(schema, name, overrides), rowEstimate };
}

export {
  createTable,
  createSizedTable,
  createRecordingAdapter,
  createSignals,
  disallowedPostgresStatements,
  unbalancedTransactions,
};
