'use strict';

const path = require('node:path');
const { syntax: ts } = require('./compiler.cjs');
const { coverage, fixFor, createIndex } = require('./schema/model.cjs');
const { currentSnapshot } = require('./schema/context.cjs');
const { querySite } = require('./schema/query-sites.cjs');
const { projectRootOf, projectDialect, migrationIndexes, tableKey } = require('./schema/project-indexes.cjs');
const { relativeFile } = require('./schema/ts-helpers.cjs');

// Below this many rows a scan is cheap; the snapshot's estimate turns a finding contextual.
const smallTableRows = 10_000;
const testSource = /(?:^|[/\\])(?:__tests__|tests?)[/\\]|\.(?:spec|test)\.[cm]?[jt]sx?$/i;
const candidateKinds = new Set(['eq', 'in', 'range']);
const selectiveTypes = new Set(['boolean', 'enum', 'bool']);
const tableInfos = new WeakMap();

function ordinal(position) {
  const suffixes = { 1: 'st', 2: 'nd', 3: 'rd' };
  return position + (position > 3 && position < 21 ? 'th' : (suffixes[position % 10] ?? 'th'));
}

function snapshotEntry(snapshot, table) {
  if (!snapshot || (table.dialect && snapshot.dialect !== table.dialect)) return;
  const name = table.dbName;
  return snapshot.tables[name] ?? snapshot.tables['public.' + name];
}

function migrationEntry(table, root) {
  const migrations = migrationIndexes(root);
  const keys = [tableKey(table.dbName), table.name.toLowerCase()];
  return keys.map((key) => migrations.get(key)).find(Boolean);
}

// The table as the rules see it: snapshot indexes win over code, migrations add what entities omit.
function describe(table) {
  const snapshot = currentSnapshot();
  const cached = tableInfos.get(table);
  if (cached && cached.snapshot === snapshot) return cached.info;
  const root = table.file ? projectRootOf(table.file) : undefined;
  const dialect = table.dialect ?? (root && projectDialect(root));
  const entry = snapshotEntry(snapshot, table);
  const effective = { ...table, dialect };
  if (entry?.indexes) effective.indexes = entry.indexes.map((index) => createIndex(index));
  const info = {
    table: effective,
    dialect,
    migration: root && table.dialect !== 'mongo' ? migrationEntry(table, root) : undefined,
    rows: entry?.rowEstimate,
    capturedOn: typeof snapshot?.capturedAt === 'string' ? snapshot.capturedAt.slice(0, 10) : undefined,
  };
  tableInfos.set(table, { snapshot, info });
  return info;
}

function lowerNames(table, column) {
  return new Set([column, table.columns.get(column)?.dbName].filter(Boolean).map((name) => name.toLowerCase()));
}

function migrationLeads(info, column) {
  const names = lowerNames(info.table, column);
  return info.migration?.indexes.some((index) => names.has(index.keys[0].column)) ?? false;
}

function migrationMentions(info, column) {
  const names = lowerNames(info.table, column);
  return [...names].some((name) => info.migration?.mentioned.has(name));
}

function hashLeads(table, column) {
  const names = lowerNames(table, column);
  return table.indexes.some(
    (index) => index.method === 'hash' && !index.predicate && names.has(index.keys[0]?.column?.toLowerCase()),
  );
}

// A partial index serves the query only when the query implies its predicate, which is not checked: stay silent.
function partialLeads(table, column) {
  const names = lowerNames(table, column);
  return table.indexes.some((index) => index.predicate && names.has(index.keys[0]?.column?.toLowerCase()));
}

// True when this conjunct can narrow the scan through an index, or might through one the model cannot read.
function isCovering(info, condition) {
  const { table } = info;
  const { column, kind } = condition;
  if (migrationMentions(info, column)) return true;
  if (kind === 'eq' || kind === 'in' || kind === 'null' || kind === 'range') {
    if (coverage(table, column) === 'leading' || migrationLeads(info, column)) return true;
    if (partialLeads(table, column)) return true;
    return kind !== 'range' && hashLeads(table, column);
  }
  if (kind === 'other') {
    const names = lowerNames(table, column);
    return table.indexes.some(
      (index) =>
        (index.method !== 'btree' || index.predicate) && index.keys.some((key) => names.has(key.column?.toLowerCase())),
    );
  }
  return false;
}

function isCandidate(info, condition) {
  if (!candidateKinds.has(condition.kind)) return false;
  return !selectiveTypes.has(info.table.columns.get(condition.column)?.type?.toLowerCase());
}

function noun(info) {
  return info.dialect === 'mongo' ? 'collection' : 'table';
}

function scanPhrase(info) {
  if (info.rows === undefined) return `so this lookup scans the ${noun(info)} as it grows`;
  const unit = info.dialect === 'mongo' ? 'documents' : 'rows';
  const source = info.capturedOn
    ? ` (estimated from the snapshot of ${info.capturedOn})`
    : ' (estimated from the snapshot)';
  return `so this lookup scans about ${info.rows.toLocaleString('en-US')} ${unit}${source}`;
}

function sizeCaveat(info) {
  if (info.rows !== undefined) return '';
  const label = noun(info) === 'table' ? 'Table' : 'Collection';
  return ` ${label} size is unknown; pass \`--schema\` to gate this rule by row count.`;
}

// Judged inside the owning project, so a project that itself sits under a `test/` folder is not a test source.
function isTestSource(filename) {
  const root = projectRootOf(filename);
  return testSource.test(root ? path.relative(root, filename) : filename);
}

function contextFor(info, node) {
  if (isTestSource(node.getSourceFile().fileName)) return 'Query in a test source.';
  if (info.rows !== undefined && info.rows < smallTableRows) {
    return `${noun(info) === 'table' ? 'Table' : 'Collection'} has about ${info.rows.toLocaleString('en-US')} rows.`;
  }
}

function place(table) {
  return `${relativeFile(table.file)}:${table.line}`;
}

function declarationLink(table) {
  const kind = { prisma: 'Model', typeorm: 'Entity', sequelize: 'Model', mongoose: 'Schema' }[table.orm] ?? 'Table';
  return {
    file: relativeFile(table.file),
    line: table.line,
    column: table.column ?? 1,
    message: `${kind} \`${table.name}\` is declared here.`,
  };
}

function quoted(columns) {
  return columns.map((column) => `'${column}'`).join(', ');
}

// The code to add, where to add it, and the DDL a live database needs.
function indexFix(info, columns, orm) {
  const { table } = info;
  const { suggestion: generated, sql } = fixFor(table, columns, orm === 'sql' ? 'sql' : 'prisma');
  const snippets = {
    prisma: () => generated,
    drizzle: () => fixFor(table, columns, 'drizzle').suggestion,
    typeorm: () => (columns.length === 1 ? '@Index()' : `@Index([${quoted(columns)}])`),
    sequelize: () => `{ fields: [${quoted(columns)}] }`,
    mongoose: () => `${table.schemaName ?? 'schema'}.index({ ${columns.map((column) => column + ': 1').join(', ')} })`,
    sql: () => sql,
  };
  const suggestion = snippets[orm]();
  const where = place(table);
  const targets = {
    prisma: `Add \`${suggestion}\` to model \`${table.name}\` (${where})`,
    drizzle: `Add \`${suggestion}\` to the indexes of table \`${table.name}\` (${where})`,
    typeorm:
      columns.length === 1
        ? `Add \`${suggestion}\` to the \`${columns[0]}\` property of entity \`${table.name}\` (${where})`
        : `Add \`${suggestion}\` to entity \`${table.name}\` (${where})`,
    sequelize: `Add \`${suggestion}\` to the \`indexes\` of model \`${table.name}\` (${where})`,
    mongoose: `Add \`${suggestion}\` (${where})`,
    sql: `Create it with \`${suggestion}\``,
  };
  const ddl =
    orm === 'sql' || info.dialect === 'mongo' || !info.dialect ? '' : `; on a live database build it with \`${sql}\``;
  return { suggestion, text: targets[orm] + ddl + '.' };
}

function nonLeadingIndex(table, column) {
  const names = lowerNames(table, column);
  for (const index of table.indexes) {
    if (index.method !== 'btree' || index.predicate) continue;
    const position = index.keys.findIndex((key) => names.has(key.column?.toLowerCase()));
    if (position > 0) return { index, position };
  }
}

function indexLabel(index) {
  return index.name ? `\`${index.name}\`` : `the index on (${index.keys.map((key) => `\`${key.column}\``).join(', ')})`;
}

function filterObservation(info, columns) {
  const labels = columns.map((column) => `\`${info.table.name}.${column}\``);
  if (columns.length === 1) {
    const partial = nonLeadingIndex(info.table, columns[0]);
    if (partial) {
      return `${labels[0]} is filtered here but is only the ${ordinal(partial.position + 1)} column of ${indexLabel(partial.index)}`;
    }
    return `${labels[0]} is filtered here and no index starts with it`;
  }
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)} are filtered here and no index starts with any of them`;
}

function labelList(columns) {
  const labels = columns.map((column) => `\`${column}\``);
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

function reportFilter(site, info, candidates, order, context) {
  const equality = candidates.filter((condition) => condition.kind !== 'range').map((condition) => condition.column);
  const range = candidates.find((condition) => condition.kind === 'range')?.column;
  const filtered = [...new Set([...equality, ...(range ? [range] : [])])];
  // One composite serves the filter and the sort when no range column sits between them.
  const sortColumns =
    order && order.info === info && !range ? order.sortColumns.filter((column) => !filtered.includes(column)) : [];
  const fix = indexFix(info, [...filtered, ...sortColumns], site.orm);
  const sortNote = sortColumns.length ? ` Ending it with ${labelList(sortColumns)} also serves the sort.` : '';
  const message = `${filterObservation(info, filtered)}, ${scanPhrase(info)}. ${fix.text}${sortNote}${sizeCaveat(info)}`;
  const node = candidates[0].node;
  context.report(node, 'index-missing-filter', message, contextFor(info, node), {
    suggestion: fix.suggestion,
    related: [declarationLink(info.table)],
  });
}

// Returns true when a finding was reported.
function evaluateFilter(site, infos, order, context) {
  if (!site.conditions.length) return false;
  // The planner narrows by any indexed conjunct first, so the others are filtered on few rows.
  if (site.conditions.some((condition) => isCovering(infos.get(condition.table), condition))) return false;
  let reported = false;
  for (const [table, info] of infos) {
    const candidates = site.conditions.filter((condition) => condition.table === table && isCandidate(info, condition));
    if (!candidates.length) continue;
    reportFilter(site, info, candidates, order, context);
    reported = true;
  }
  return reported;
}

function namesOf(table, columns) {
  return new Set(columns.flatMap((column) => [...lowerNames(table, column)]));
}

// Btree indexes from the model or snapshot plus those migrations create, as lower-case key names. Partial ones
// are included because the query might imply their predicate, which is not checked.
function orderableIndexes(info) {
  const declared = info.table.indexes
    .filter((index) => index.method === 'btree' && index.keys.every((key) => key.column))
    .map((index) => ({ index, keys: index.keys.map((key) => key.column.toLowerCase()) }));
  const migrated = [
    ...(info.migration?.indexes ?? []),
    ...(info.migration?.others ?? []).filter(
      (index) => index.method.toLowerCase() === 'btree' && index.keys.every((key) => key.column),
    ),
  ].map((index) => ({ index: { ...index, predicate: index.partial }, keys: index.keys.map((key) => key.column) }));
  return [...declared, ...migrated];
}

// A migration expression index over a sort column might serve it in a way the rules cannot read.
function expressionMentions(info, columns) {
  const names = namesOf(info.table, columns);
  return (info.migration?.others ?? []).some((index) =>
    index.keys.some((key) => key.columns?.some((column) => names.has(column))),
  );
}

// An index serves the sort when the sort columns follow a run of equality-filtered columns.
function servesOrder(keys, equality, sortNames) {
  for (let start = 0; start + sortNames.length <= keys.length; start++) {
    if (start > 0 && !equality.has(keys[start - 1])) return false;
    if (sortNames.every((names, offset) => names.has(keys[start + offset]))) return true;
  }
  return false;
}

// The existing index on exactly the equality columns, which an extended index would make redundant.
function redundantIndex(info, indexes, equalityColumns) {
  if (!equalityColumns.length) return;
  const prefix = namesOf(info.table, equalityColumns);
  return indexes.find(
    ({ index, keys }) =>
      !index.unique &&
      !index.primary &&
      !index.predicate &&
      keys.length === equalityColumns.length &&
      keys.every((key) => prefix.has(key)),
  )?.index;
}

// What a limited, sorted single-table read is missing, or undefined when an index (or doubt) covers it.
function orderGap(site, infos) {
  if (site.joins || !site.limited || !Array.isArray(site.order) || !site.order.length) return;
  const { table } = site.order[0];
  const tables = [...site.order, ...site.conditions].map((entry) => entry.table);
  if (tables.some((other) => other !== table)) return;
  const info = infos.get(table);
  const equalityColumns = [
    ...new Set(
      site.conditions
        .filter((condition) => condition.kind === 'eq' || condition.kind === 'null')
        .map((condition) => condition.column),
    ),
  ];
  const sortColumns = [...new Set(site.order.map((entry) => entry.column))].filter(
    (column) => !equalityColumns.includes(column),
  );
  if (!sortColumns.length) return;
  const columns = [...equalityColumns, ...sortColumns];
  if (expressionMentions(info, sortColumns)) return;
  const equality = namesOf(info.table, equalityColumns);
  const indexes = orderableIndexes(info);
  // A unique key fully matched by equality returns at most one row, so there is nothing to sort; a partial one
  // might too, so it also silences.
  const fullyMatched = ({ index, keys }) => (index.unique || index.primary) && keys.every((key) => equality.has(key));
  if (indexes.some(fullyMatched)) return;
  const sortNames = sortColumns.map((column) => lowerNames(info.table, column));
  if (indexes.some(({ keys }) => servesOrder(keys, equality, sortNames))) return;
  const replaced = redundantIndex(info, indexes, equalityColumns);
  return { info, equalityColumns, sortColumns, columns, node: site.order[0].node, replaced };
}

function sortedRows(info) {
  if (info.rows === undefined) return '';
  const unit = info.dialect === 'mongo' ? 'documents' : 'rows';
  const source = info.capturedOn ? `, estimated from the snapshot of ${info.capturedOn}` : '';
  return ` (the ${noun(info)} has about ${info.rows.toLocaleString('en-US')} ${unit}${source})`;
}

function orderObservation(gap) {
  const { info, equalityColumns, sortColumns, columns } = gap;
  const sorted = sortColumns.map((column) => `\`${info.table.name}.${column}\``).join(', then ');
  const verb = sortColumns.length === 1 ? 'orders' : 'order';
  if (!equalityColumns.length) {
    const pronoun = sortColumns.length === 1 ? 'it' : 'them';
    return (
      `${sorted} ${verb} this limited read and no index starts with ${pronoun}, ` +
      `so the database sorts the whole ${noun(info)}${sortedRows(info)} to return the first rows`
    );
  }
  return (
    `${sorted} ${verb} this limited read after filtering on ${labelList(equalityColumns)}, and no index has ` +
    `(${columns.map((column) => `\`${column}\``).join(', ')}) as leading columns, ` +
    `so the database sorts every matching row${sortedRows(info)} to return the first ones`
  );
}

function reportOrder(site, gap, context) {
  const { info, columns, node, replaced } = gap;
  const fix = indexFix(info, columns, site.orm);
  const cleanup = replaced ? ` Then drop ${indexLabel(replaced)}, which the new index makes redundant.` : '';
  const message = `${orderObservation(gap)}. ${fix.text}${cleanup}${sizeCaveat(info)}`;
  context.report(node, 'index-missing-order', message, contextFor(info, node), {
    suggestion: fix.suggestion,
    related: [declarationLink(info.table)],
  });
}

function evaluateSite(site, context) {
  if (site.uncertain) return;
  const tables = [...site.conditions, ...(Array.isArray(site.order) ? site.order : [])].map((entry) => entry.table);
  if (!tables.length) return;
  const infos = new Map([...new Set(tables)].map((table) => [table, describe(table)]));
  if ([...infos.values()].some((info) => info.table.complete === false)) return;
  const order = orderGap(site, infos);
  if (!evaluateFilter(site, infos, order, context) && order) reportOrder(site, order, context);
}

function checkIndexUsage(node, context) {
  if (!ts.isCallExpression(node)) return;
  const site = querySite(node, context.checker);
  if (site) evaluateSite(site, context);
}

module.exports = { checkIndexUsage };
