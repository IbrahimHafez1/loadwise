import { splitStatementRanges, tokenizeRange } from '../sql/mysql-tokens.cjs';

// Every statement `db` may send to MySQL, apart from validated EXPLAIN text. ? placeholders are
// bound values.
const statements = Object.freeze({
  serverInfo: 'SELECT VERSION() AS version, DATABASE() AS database_name',
  roundTrip: 'SELECT 1',
  uptime: `SELECT VARIABLE_VALUE AS uptime_seconds FROM performance_schema.global_status
WHERE VARIABLE_NAME = 'Uptime'`,
  tables: `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, TABLE_ROWS AS row_estimate,
  DATA_LENGTH + INDEX_LENGTH AS size_bytes
FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_NAME`,
  indexes: `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, INDEX_NAME AS index_name,
  NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS position, COLUMN_NAME AS column_name, EXPRESSION AS expression,
  INDEX_TYPE AS index_type, COLLATION AS collation
FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
  foreignKeys: `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, CONSTRAINT_NAME AS constraint_name,
  COLUMN_NAME AS column_name, REFERENCED_TABLE_SCHEMA AS referenced_schema,
  REFERENCED_TABLE_NAME AS referenced_table, REFERENCED_COLUMN_NAME AS referenced_column
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
  unusedIndexes: `SELECT object_schema AS schema_name, object_name AS table_name, index_name
FROM sys.schema_unused_indexes WHERE object_schema = DATABASE()`,
  redundantIndexes: `SELECT table_schema AS schema_name, table_name, redundant_index_name, redundant_index_columns,
  dominant_index_name, dominant_index_columns
FROM sys.schema_redundant_indexes WHERE table_schema = DATABASE()`,
  // Timers are picoseconds; 1e9 converts to milliseconds. ? is the row limit.
  topStatements: `SELECT DIGEST AS digest, DIGEST_TEXT AS digest_text, QUERY_SAMPLE_TEXT AS sample_text,
  COUNT_STAR AS calls, SUM_TIMER_WAIT / 1e9 AS total_ms, AVG_TIMER_WAIT / 1e9 AS mean_ms,
  SUM_ROWS_EXAMINED AS rows_examined, SUM_NO_INDEX_USED AS no_index_used
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = DATABASE() AND DIGEST_TEXT IS NOT NULL
ORDER BY SUM_TIMER_WAIT DESC LIMIT ?`,
});

const control = Object.freeze({
  sessionReadOnly: 'SET SESSION TRANSACTION READ ONLY',
  sessionStatementTimeout: 'SET SESSION max_execution_time = 5000',
  begin: 'START TRANSACTION READ ONLY',
  rollback: 'ROLLBACK',
});

const sessionSetup = Object.freeze([control.sessionReadOnly, control.sessionStatementTimeout]);
const unitSetup: readonly string[] = Object.freeze([]);
const explainPrefix = 'EXPLAIN FORMAT=JSON ';

class MysqlExplainRefusal extends Error {}

// EXPLAIN without ANALYZE never executes on MySQL; this still keeps it to one plain SELECT.
function validateExplain(sql: string) {
  if (typeof sql !== 'string' || sql.trim() === '') throw new MysqlExplainRefusal('EXPLAIN needs a statement.');
  // Executable comments and DELIMITER directives are refused outright.
  if (sql.includes('/*!')) throw new MysqlExplainRefusal('Executable comments (/*! ... */) are not explained.');
  if (/^\s*delimiter\b/im.test(sql)) throw new MysqlExplainRefusal('DELIMITER directives are not allowed in EXPLAIN.');
  const ranges = splitStatementRanges(sql);
  if (ranges.length !== 1) throw new MysqlExplainRefusal(`Expected one statement, found ${ranges.length}.`);
  const [first] = tokenizeRange(sql, ranges[0].start, ranges[0].end);
  if (first?.upper !== 'SELECT') throw new MysqlExplainRefusal('Only SELECT statements are explained on MySQL.');
}

function quoteIdent(identifier: string) {
  return '`' + String(identifier).replaceAll('`', '``') + '`';
}

export {
  statements,
  control,
  sessionSetup,
  unitSetup,
  explainPrefix,
  validateExplain,
  MysqlExplainRefusal,
  quoteIdent,
};
