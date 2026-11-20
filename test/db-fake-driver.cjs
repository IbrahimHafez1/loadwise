'use strict';

const { EventEmitter } = require('node:events');
const { ensureLoaded, parseExplainCandidate } = require('../lib/sql/pg-parser.cjs');
const pgCatalog = require('../lib/db/pg-catalog.cjs');

const explainPrefixes = [
  'EXPLAIN (FORMAT JSON) ',
  'EXPLAIN (GENERIC_PLAN, FORMAT JSON) ',
  'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ',
];

function catalogIdOf(catalog, text) {
  return Object.entries(catalog.statements).find(([, statement]) => statement === text)?.[0];
}

/**
 * A driver adapter that records every statement. `responses` maps a catalog id (or 'explain') to rows or to a
 * function (params, text) => rows; a thrown error simulates a server error.
 */
function createRecordingAdapter({ engine = 'postgres', catalog = pgCatalog, responses = {} } = {}) {
  const adapter = {
    engine,
    sent: [],
    destroyed: false,
    closed: false,
    async query(text, params) {
      adapter.sent.push(params === undefined ? { text } : { text, params });
      const id = catalogIdOf(catalog, text) ?? (text.startsWith('EXPLAIN') ? 'explain' : text);
      const response = responses[id];
      return typeof response === 'function' ? response(params, text) : (response ?? []);
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

function createSignals() {
  const signals = new EventEmitter();
  signals.exitCodes = [];
  signals.exit = (code) => signals.exitCodes.push(code);
  return signals;
}

// 4.2 (a): each statement is a catalog constant, a fixed control statement, or a validated EXPLAIN.
async function disallowedPostgresStatements(sent, { allowMeasure = false } = {}) {
  await ensureLoaded();
  const fixed = new Set([...Object.values(pgCatalog.statements), ...Object.values(pgCatalog.control)]);
  if (allowMeasure) for (const statement of Object.values(pgCatalog.measureControl)) fixed.add(statement);
  return sent
    .map(({ text }) => text)
    .filter((text) => {
      if (fixed.has(text)) return false;
      if (allowMeasure && /^CREATE INDEX "backend_perf_check_\w+" ON "[^"]+"\."[^"]+" \(.+\)$/.test(text)) return false;
      const prefix = explainPrefixes.find((candidate) => text.startsWith(candidate));
      if (!prefix) return true;
      const parsed = parseExplainCandidate(text.slice(prefix.length));
      return parsed.error || !['SelectStmt', 'InsertStmt', 'UpdateStmt', 'DeleteStmt'].includes(parsed.kind);
    });
}

// 4.2 (d): every BEGIN is matched by a ROLLBACK before the next BEGIN or the end.
function unbalancedTransactions(sent) {
  let open = false;
  for (const { text } of sent) {
    if (text.startsWith('BEGIN') || text.startsWith('START TRANSACTION')) {
      if (open) return true;
      open = true;
    } else if (text === 'ROLLBACK') open = false;
  }
  return open;
}

module.exports = { createRecordingAdapter, createSignals, disallowedPostgresStatements, unbalancedTransactions };
