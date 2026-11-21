'use strict';

const { quoteIdent } = require('./pg-catalog.cjs');

// Below this many rows a scan is cheap, so size-dependent findings become contextual. Named for design 2.4 and 4.4.
const sizeGateRows = 10_000;
const minimumStatsAgeDays = 7;
// A table read in full at least this many times over is scanned as a habit, not by one maintenance job.
const heavyScanMultiple = 10;
const maxIdentifierLength = 63;
const bytesPerKilobyte = 1024;

function formatCount(value) {
  return Math.round(value).toLocaleString('en-US');
}

function formatBytes(bytes) {
  const units = ['bytes', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= bytesPerKilobyte && unit < units.length - 1) {
    value /= bytesPerKilobyte;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function formatDays(days) {
  return days < 1 ? 'less than a day' : `${formatCount(Math.floor(days))} day${Math.floor(days) === 1 ? '' : 's'}`;
}

// "in the 12 days since statistics were reset", "since statistics were reset less than a day ago".
function sinceEvent(days, event) {
  if (days === undefined) return `since ${event}`;
  if (days < 1) return `since ${event} less than a day ago`;
  return `in the ${formatDays(days)} since ${event}`;
}

function toNumber(value) {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function tableKey(schema, name) {
  return `${schema}.${name}`;
}

function qualified(schema, name) {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

function generatedIndexName(table, columns) {
  return `${table}_${columns.join('_')}_idx`.slice(0, maxIdentifierLength);
}

function createIndexSql(table, columns) {
  const name = quoteIdent(generatedIndexName(table.name, columns));
  return `CREATE INDEX CONCURRENTLY ${name} ON ${qualified(table.schema, table.name)} (${columns.map(quoteIdent).join(', ')});`;
}

function normalizeIndex(row) {
  const keys = row.key_definitions.map((definition, position) => {
    const column = row.key_columns[position];
    const key = column ? { column } : { expression: definition };
    if (row.key_opclasses?.[position]) key.opclass = row.key_opclasses[position];
    if (row.key_descending?.[position]) key.direction = 'desc';
    if (row.key_semantics?.[position]) key.semantics = row.key_semantics[position];
    return key;
  });
  const index = {
    name: row.index_name,
    keys,
    unique: Boolean(row.is_unique),
    primary: Boolean(row.is_primary),
    method: row.method,
    backsConstraint: Boolean(row.backs_constraint),
    protected: Boolean(row.is_protected),
    usable: row.is_usable !== false,
    duplicateComparable: row.duplicate_comparable !== false,
    scans: toNumber(row.idx_scan),
    sizeBytes: toNumber(row.size_bytes),
  };
  if (row.predicate) index.predicate = row.predicate;
  return index;
}

// pg_class.reltuples is -1 until the first ANALYZE; the live-tuple counter is the fallback estimate.
function rowEstimateOf(row) {
  const reltuples = toNumber(row.row_estimate);
  if (reltuples !== undefined && reltuples >= 0) return reltuples;
  return toNumber(row.n_live_tup);
}

function buildPostgresModel({ tables = [], columns = [], indexes = [], foreignKeys = [] }) {
  const model = new Map();
  for (const row of tables) {
    model.set(tableKey(row.schema_name, row.table_name), {
      schema: row.schema_name,
      name: row.table_name,
      rowEstimate: rowEstimateOf(row),
      sizeBytes: toNumber(row.size_bytes),
      seqScan: toNumber(row.seq_scan),
      seqTupRead: toNumber(row.seq_tup_read),
      idxScan: toNumber(row.idx_scan),
      liveTuples: toNumber(row.n_live_tup),
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
  }
  const tableOf = (row) => model.get(tableKey(row.schema_name, row.table_name));
  for (const row of columns) tableOf(row)?.columns.push(row.column_name);
  for (const row of indexes) tableOf(row)?.indexes.push(normalizeIndex(row));
  for (const row of foreignKeys) {
    tableOf(row)?.foreignKeys.push({
      name: row.constraint_name,
      columns: row.columns,
      references: { table: tableKey(row.referenced_schema, row.referenced_table), columns: row.referenced_columns },
    });
  }
  return model;
}

function sizeNote(table) {
  if (table.rowEstimate === undefined) return 'Table size is unknown (not yet analyzed).';
  return `Table has about ${formatCount(table.rowEstimate)} rows (estimated from planner statistics).`;
}

// Small tables keep the finding visible under --include-contextual without failing the run.
function sizeGate(table) {
  if (table.rowEstimate === undefined || table.rowEstimate >= sizeGateRows) return {};
  return {
    contextualReason: `Table has about ${formatCount(table.rowEstimate)} rows (estimated), below the ${formatCount(sizeGateRows)}-row threshold.`,
  };
}

function leadingColumns(index, count) {
  return index.keys.slice(0, count).map((key) => key.column);
}

function servesLookupsOn(index, columns) {
  if (index.usable === false || index.predicate || index.method !== 'btree' || index.keys.length < columns.length)
    return false;
  const leading = new Set(leadingColumns(index, columns.length));
  return columns.every((column) => leading.has(column));
}

function unindexedForeignKeys(model) {
  const findings = [];
  for (const table of model.values()) {
    for (const foreignKey of table.foreignKeys) {
      if (table.indexes.some((index) => servesLookupsOn(index, foreignKey.columns))) continue;
      const fix = createIndexSql(table, foreignKey.columns);
      const columnList = foreignKey.columns.map((column) => `\`${column}\``).join(', ');
      findings.push({
        target: tableKey(table.schema, table.name),
        ruleId: 'db-unindexed-foreign-key',
        message:
          `Foreign key \`${foreignKey.name}\` (${columnList}) references \`${foreignKey.references.table}\` and no ` +
          `index starts with it, so joins on it scan \`${table.name}\` and every delete or key update on the ` +
          `referenced table scans it too. Add \`${fix}\` ${sizeNote(table)}`,
        suggestion: fix,
        ...sizeGate(table),
      });
    }
  }
  return findings;
}

function isRemovable(index) {
  return index.usable !== false && !index.protected && !index.unique && !index.primary && !index.backsConstraint;
}

function dropIndexSql(table, index) {
  return `DROP INDEX CONCURRENTLY ${qualified(table.schema, index.name)};`;
}

function unusedIndexes(model, statsAgeDays) {
  const findings = [];
  for (const table of model.values()) {
    for (const index of table.indexes) {
      if (index.scans !== 0 || !isRemovable(index)) continue;
      const fix = dropIndexSql(table, index);
      const size = index.sizeBytes === undefined ? '' : ` It takes ${formatBytes(index.sizeBytes)} (measured) and`;
      const age = sinceEvent(statsAgeDays, 'statistics were reset');
      const finding = {
        target: tableKey(table.schema, table.name),
        ruleId: 'db-unused-index',
        message:
          `Index \`${index.name}\` on \`${table.name}\` was scanned 0 times (measured) ${age} on this server; ` +
          `replicas keep their own counters and are not counted.${size || ' It'} slows every write to the table. ` +
          `If no replica uses it, drop it: \`${fix}\``,
        suggestion: fix,
      };
      if (statsAgeDays === undefined || statsAgeDays < minimumStatsAgeDays) {
        finding.contextualReason = `Statistics cover ${statsAgeDays === undefined ? 'an unknown period' : formatDays(statsAgeDays)}, less than ${minimumStatsAgeDays} days; weekly or monthly jobs may still use this index.`;
      }
      findings.push(finding);
    }
  }
  return findings;
}

function keySignature(key) {
  return JSON.stringify([
    key.column ?? null,
    key.expression ?? null,
    key.opclass ?? null,
    key.direction ?? 'asc',
    key.semantics ?? null,
  ]);
}

function isPrefix(shorter, longer) {
  return shorter.keys.every((key, position) => keySignature(key) === keySignature(longer.keys[position]));
}

function describeKeys(index) {
  return index.keys.map((key) => `\`${key.column ?? key.expression}\``).join(', ');
}

// Returns [redundant, kept] or undefined. Identical indexes keep the one a constraint depends on.
function redundantPair(first, second) {
  if ([first, second].some((index) => index.duplicateComparable === false || index.usable === false)) return;
  if (first.method !== second.method || (first.predicate ?? '') !== (second.predicate ?? '')) return;
  if (first.keys.length === second.keys.length) {
    if (!isPrefix(first, second)) return;
    if (isRemovable(second)) return [second, first];
    if (isRemovable(first)) return [first, second];
    return;
  }
  // Only btree serves lookups on a leading prefix.
  if (first.method !== 'btree') return;
  const [shorter, longer] = first.keys.length < second.keys.length ? [first, second] : [second, first];
  if (isRemovable(shorter) && isPrefix(shorter, longer)) return [shorter, longer];
}

function tableDuplicateIndexes(table) {
  const findings = [];
  const reported = new Set();
  for (const [position, first] of table.indexes.entries()) {
    for (let next = position + 1; next < table.indexes.length; next++) {
      const pair = redundantPair(first, table.indexes[next]);
      if (!pair || reported.has(pair[0].name)) continue;
      const [redundant, kept] = pair;
      reported.add(redundant.name);
      const fix = dropIndexSql(table, redundant);
      const relation = redundant.keys.length === kept.keys.length ? 'has the same keys as' : 'is a leading prefix of';
      findings.push({
        target: tableKey(table.schema, table.name),
        ruleId: 'db-duplicate-index',
        message:
          `Index \`${redundant.name}\` (${describeKeys(redundant)}) ${relation} \`${kept.name}\` ` +
          `(${describeKeys(kept)}), which serves the same lookups, so it only slows writes. Drop it: \`${fix}\``,
        suggestion: fix,
      });
    }
  }
  return findings;
}

function duplicateIndexes(model) {
  return Array.from(model.values()).flatMap(tableDuplicateIndexes);
}

function seqScanHeavyTables(model, statsAgeDays) {
  const findings = [];
  for (const table of model.values()) {
    const { seqScan, seqTupRead, idxScan, liveTuples } = table;
    if (seqScan === undefined || seqTupRead === undefined || liveTuples === undefined) continue;
    if (liveTuples < sizeGateRows || seqScan <= (idxScan ?? 0)) continue;
    if (seqTupRead < heavyScanMultiple * liveTuples) continue;
    const period = sinceEvent(statsAgeDays, 'statistics were reset');
    findings.push({
      target: tableKey(table.schema, table.name),
      ruleId: 'db-seq-scan-heavy-table',
      message:
        `\`${table.name}\` had ${formatCount(seqScan)} sequential scans reading ${formatCount(seqTupRead)} rows ` +
        `against ${formatCount(idxScan ?? 0)} index scans ${period} (measured counters), and holds about ` +
        `${formatCount(liveTuples)} live rows (estimated). Index the columns its frequent queries filter on; ` +
        'enable pg_stat_statements or pass `--queries` so `db` can name them.',
    });
  }
  return findings;
}

function postgresCatalogFindings(model, { statsAgeDays } = {}) {
  return [
    ...unindexedForeignKeys(model),
    ...unusedIndexes(model, statsAgeDays),
    ...duplicateIndexes(model),
    ...seqScanHeavyTables(model, statsAgeDays),
  ];
}

function buildMysqlModel({ tables = [], indexes = [], foreignKeys = [] }) {
  const model = new Map();
  for (const row of tables) {
    model.set(tableKey(row.schema_name, row.table_name), {
      schema: row.schema_name,
      name: row.table_name,
      rowEstimate: toNumber(row.row_estimate),
      sizeBytes: toNumber(row.size_bytes),
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
  }
  for (const row of indexes) {
    const table = model.get(tableKey(row.schema_name, row.table_name));
    if (!table) continue;
    let index = table.indexes.find((candidate) => candidate.name === row.index_name);
    if (!index) {
      index = {
        name: row.index_name,
        keys: [],
        unique: Number(row.non_unique) === 0,
        primary: row.index_name === 'PRIMARY',
        method: String(row.index_type).toLowerCase(),
      };
      table.indexes.push(index);
    }
    const key = row.column_name ? { column: row.column_name } : { expression: row.expression };
    if (row.collation === 'D') key.direction = 'desc';
    index.keys.push(key);
  }
  // KEY_COLUMN_USAGE has one row per column, ordered by constraint and position.
  for (const row of foreignKeys) {
    const table = model.get(tableKey(row.schema_name, row.table_name));
    if (!table) continue;
    let foreignKey = table.foreignKeys.find((candidate) => candidate.name === row.constraint_name);
    if (!foreignKey) {
      foreignKey = {
        name: row.constraint_name,
        columns: [],
        references: { table: tableKey(row.referenced_schema, row.referenced_table), columns: [] },
      };
      table.foreignKeys.push(foreignKey);
    }
    foreignKey.columns.push(row.column_name);
    foreignKey.references.columns.push(row.referenced_column);
  }
  return model;
}

function mysqlQuote(identifier) {
  return '`' + String(identifier).replaceAll('`', '``') + '`';
}

function mysqlDropIndexSql(table, indexName) {
  return `ALTER TABLE ${mysqlQuote(table.name)} DROP INDEX ${mysqlQuote(indexName)}, ALGORITHM=INPLACE, LOCK=NONE;`;
}

function removableMysqlIndex(model, schema, tableName, indexName) {
  const table = model.get(tableKey(schema, tableName));
  const index = table?.indexes.find((candidate) => candidate.name === indexName);
  return table && index && !index.unique && !index.primary ? { table, index } : undefined;
}

function mysqlUnusedIndexes(model, rows, uptimeDays) {
  const findings = [];
  for (const row of rows) {
    const found = removableMysqlIndex(model, row.schema_name, row.table_name, row.index_name);
    if (!found) continue;
    const fix = mysqlDropIndexSql(found.table, found.index.name);
    const age = sinceEvent(uptimeDays, 'the server started');
    const finding = {
      target: tableKey(found.table.schema, found.table.name),
      ruleId: 'db-unused-index',
      message:
        `Index \`${found.index.name}\` on \`${found.table.name}\` had 0 reads (measured by performance_schema) ` +
        `${age}; replicas keep their own counters and are not counted. It slows every write to the table. ` +
        `If no replica uses it, drop it: \`${fix}\``,
      suggestion: fix,
    };
    if (uptimeDays === undefined || uptimeDays < minimumStatsAgeDays) {
      const period = uptimeDays === undefined ? 'an unknown period' : formatDays(uptimeDays);
      finding.contextualReason = `The server has run for ${period}, less than ${minimumStatsAgeDays} days; weekly or monthly jobs may still use this index.`;
    }
    findings.push(finding);
  }
  return findings;
}

function mysqlRedundantIndexes(model, rows) {
  const findings = [];
  for (const row of rows) {
    const found = removableMysqlIndex(model, row.schema_name, row.table_name, row.redundant_index_name);
    if (!found) continue;
    const fix = mysqlDropIndexSql(found.table, found.index.name);
    findings.push({
      target: tableKey(found.table.schema, found.table.name),
      ruleId: 'db-duplicate-index',
      message:
        `Index \`${row.redundant_index_name}\` (${row.redundant_index_columns}) is covered by ` +
        `\`${row.dominant_index_name}\` (${row.dominant_index_columns}), which serves the same lookups, so it ` +
        `only slows writes. Drop it: \`${fix}\``,
      suggestion: fix,
    });
  }
  return findings;
}

// InnoDB indexes foreign keys itself, so MySQL has no unindexed-FK check.
function mysqlCatalogFindings(model, { unusedIndexes: unusedRows = [], redundantIndexes = [], uptimeDays } = {}) {
  return [...mysqlUnusedIndexes(model, unusedRows, uptimeDays), ...mysqlRedundantIndexes(model, redundantIndexes)];
}

module.exports = {
  buildMysqlModel,
  mysqlCatalogFindings,
  sizeGateRows,
  minimumStatsAgeDays,
  formatCount,
  sinceEvent,
  formatBytes,
  tableKey,
  generatedIndexName,
  createIndexSql,
  buildPostgresModel,
  redundantPair,
  sizeGate,
  sizeNote,
  postgresCatalogFindings,
};
