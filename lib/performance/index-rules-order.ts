import { allDefined } from './schema/model.js';
import type { Node } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.js';
import type { QueryCondition, QuerySite } from './types/query-site.js';
import type { SchemaTable } from './types/schema-model.js';
import {
  contextFor,
  indexFix,
  indexLabel,
  infoOf,
  isCovering,
  isParentReference,
  labelList,
  lowerNames,
  maxSortedEqualityColumns,
  noun,
  relatedTo,
  sizeCaveat,
} from './index-rules-table.js';
import type { IndexSummary, TableInfo } from './index-rules-table.js';

// An index with its key columns in lower case.
interface OrderableIndex {
  index: IndexSummary;
  keys: string[];
}

// A limited, sorted read that no index serves.
export interface OrderGap {
  info: TableInfo;
  equalityColumns: string[];
  sortColumns: string[];
  columns: string[];
  node: Node;
  replaced: IndexSummary | undefined;
  narrowedBy: string | undefined;
}

function namesOf(table: SchemaTable, columns: readonly string[]): Set<string> {
  return new Set(columns.flatMap((column) => [...lowerNames(table, column)]));
}

// Btree indexes from the model or snapshot plus those migrations create, as lower-case key names.
// Partial ones are included because the query might imply their predicate, which is not checked.
function orderableIndexes(info: TableInfo): OrderableIndex[] {
  const declared = info.table.indexes.flatMap((index): OrderableIndex[] => {
    const keys = index.keys.map((key) => key.column?.toLowerCase());
    return index.method === 'btree' && allDefined(keys) ? [{ index, keys }] : [];
  });
  // Migration indexes read as plain btree are never partial; the others carry their own `partial`
  // flag.
  const migratedPlain = (info.migration?.indexes ?? []).flatMap((index): OrderableIndex[] => {
    const keys = index.keys.map((key) => key.column);
    return allDefined(keys) ? [{ index: { ...index, predicate: undefined }, keys }] : [];
  });
  const migratedOthers = (info.migration?.others ?? []).flatMap((index): OrderableIndex[] => {
    const keys = index.keys.map((key) => key.column);
    return index.method.toLowerCase() === 'btree' && allDefined(keys)
      ? [{ index: { ...index, predicate: index.partial }, keys }]
      : [];
  });
  return [...declared, ...migratedPlain, ...migratedOthers];
}

// A migration expression index over a sort column might serve it in a way the rules cannot read.
function expressionMentions(info: TableInfo, columns: string[]): boolean {
  const names = namesOf(info.table, columns);
  return (info.migration?.others ?? []).some((index) =>
    index.keys.some((key) => key.columns?.some((column) => names.has(column))),
  );
}

// An index serves the sort when the first sort column follows a run of equality-filtered columns.
// Later sort columns such as an `id` tiebreaker are cheap: PostgreSQL 13+ sorts only the ties
// (incremental sort).
function servesOrder(
  keys: readonly string[],
  equality: ReadonlySet<string>,
  sortNames: readonly Set<string>[],
): boolean {
  for (let start = 0; start < keys.length; start++) {
    if (start > 0 && !equality.has(keys[start - 1])) return false;
    if (sortNames[0].has(keys[start])) return true;
  }
  return false;
}

// The existing index on exactly the equality columns, which an extended index would make redundant.
function redundantIndex(
  info: TableInfo,
  indexes: OrderableIndex[],
  equalityColumns: string[],
): IndexSummary | undefined {
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

// What a limited, sorted single-table read is missing, or undefined when an index (or doubt) covers
// it.
export function orderGap(site: QuerySite, infos: ReadonlyMap<SchemaTable, TableInfo>): OrderGap | undefined {
  if (site.joins || !site.limited || !Array.isArray(site.order) || !site.order.length) return;
  const { table } = site.order[0];
  const tables = [...site.order, ...site.conditions].map((entry) => entry.table);
  if (tables.some((other) => other !== table)) return;
  const info = infoOf(infos, table);
  if (info.migration?.opaque) return;
  // An indexed `IN` list, such as `id: In(ids)`, reads only the listed rows, so the sort covers few
  // of them.
  const indexedList = (condition: QueryCondition) => condition.kind === 'in' && isCovering(info, condition);
  if (site.conditions.some(indexedList)) return;
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
  if (!sortColumns.length || equalityColumns.length > maxSortedEqualityColumns) return;
  const columns = [...equalityColumns, ...sortColumns];
  if (expressionMentions(info, sortColumns)) return;
  const equality = namesOf(info.table, equalityColumns);
  const indexes = orderableIndexes(info);
  // A unique key fully matched by equality returns at most one row, so there is nothing to sort; a
  // partial one might too, so it also silences.
  const fullyMatched = ({ index, keys }: OrderableIndex) =>
    (index.unique || index.primary) && keys.every((key) => equality.has(key));
  if (indexes.some(fullyMatched)) return;
  const sortNames = sortColumns.map((column) => lowerNames(info.table, column));
  if (indexes.some(({ keys }) => servesOrder(keys, equality, sortNames))) return;
  const replaced = redundantIndex(info, indexes, equalityColumns);
  const narrowedBy = indexNarrowing(info, indexes, equality, equalityColumns);
  return { info, equalityColumns, sortColumns, columns, node: site.order[0].node, replaced, narrowedBy };
}

// An equality column inside the leading keys an index shares with the filter. That index already
// narrows the read, so the sort covers only the rows it leaves (one parent's, one status's). (A
// fully matched unique key silences the rule earlier.) A parent reference is preferred because its
// note is the more specific.
function indexNarrowing(
  info: TableInfo,
  indexes: OrderableIndex[],
  equality: ReadonlySet<string>,
  equalityColumns: string[],
): string | undefined {
  const narrows = (column: string) => {
    const names = lowerNames(info.table, column);
    return indexes.some(({ index, keys }) => {
      if (index.predicate) return false;
      const prefixLength = keys.findIndex((key) => !equality.has(key));
      const prefix = prefixLength < 0 ? keys : keys.slice(0, prefixLength);
      return prefix.some((key) => names.has(key));
    });
  };
  const narrowing = equalityColumns.filter(narrows);
  return narrowing.find((column) => isParentReference(info.table, column)) ?? narrowing[0];
}

function sortedRows(info: TableInfo): string {
  if (info.rows === undefined) return '';
  const unit = info.dialect === 'mongo' ? 'documents' : 'rows';
  const source = info.capturedOn ? `, estimated from the snapshot of ${info.capturedOn}` : '';
  return ` (the ${noun(info)} has about ${info.rows.toLocaleString('en-US')} ${unit}${source})`;
}

function orderObservation(gap: OrderGap): string {
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

function narrowedNote(info: TableInfo, column: string): string {
  if (isParentReference(info.table, column)) {
    return (
      `An index on the parent reference \`${column}\` already narrows this read to one parent's rows; ` +
      'the sort matters only if a parent can have many.'
    );
  }
  return `An index on \`${column}\` already narrows this read; the sort matters only if many rows match it.`;
}

export function reportOrder(site: QuerySite, gap: OrderGap, context: PerformanceRuleContext): void {
  const { info, columns, node, replaced } = gap;
  const fix = indexFix(info, columns, site.orm);
  const cleanup = replaced ? ` Then drop ${indexLabel(replaced)}, which the new index makes redundant.` : '';
  const message = `${orderObservation(gap)}. ${fix.text}${cleanup}${sizeCaveat(info)}`;
  const narrowed = gap.narrowedBy && narrowedNote(info, gap.narrowedBy);
  context.report(node, 'index-missing-order', message, contextFor(info, node) ?? narrowed, {
    suggestion: fix.suggestion,
    ...relatedTo(info.table),
  });
}
