import { ts } from './compiler.js';
import { querySite } from './schema/query-sites.js';
import { rawSqlSite } from './schema/raw-sql-sites.js';
import { checkRedundantIndexes } from './redundant-indexes.js';
import type { Node } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.js';
import type { QueryCondition, QuerySite } from './types/query-site.js';
import type { SchemaTable } from './types/schema-model.js';
import {
  contextFor,
  declarationLink,
  describe,
  filterObservation,
  hasPatternIndex,
  indexFix,
  indexedColumns,
  infoOf,
  isCandidate,
  isCovering,
  isTestSource,
  labelList,
  relatedTo,
  scanPhrase,
  sizeCaveat,
} from './index-rules-table.js';
import type { TableInfo } from './index-rules-table.js';
import { checkDecoratorForeignKey, checkDrizzleForeignKeys, foreignKeyFinding } from './index-rules-foreign-keys.js';
import { orderGap, reportOrder } from './index-rules-order.js';
import type { OrderGap } from './index-rules-order.js';
import { reportExpression, reportPattern } from './index-rules-pattern.js';

function reportFilter(
  site: QuerySite,
  info: TableInfo,
  candidates: QueryCondition[],
  order: OrderGap | undefined,
  context: PerformanceRuleContext,
): void {
  const equality = candidates.filter((condition) => condition.kind !== 'range').map((condition) => condition.column);
  const range = candidates.find((condition) => condition.kind === 'range')?.column;
  const filtered = [...new Set([...equality, ...(range ? [range] : [])])];
  const keyed = indexedColumns(info, filtered);
  // One composite serves the filter and the sort when no range column sits between them.
  const sortColumns =
    order && order.info === info && !(range !== undefined && keyed.includes(range))
      ? order.sortColumns.filter((column) => !keyed.includes(column))
      : [];
  const fix = indexFix(info, [...keyed, ...sortColumns], site.orm);
  const sortNote = sortColumns.length ? ` Ending it with ${labelList(sortColumns)} also serves the sort.` : '';
  const message = `${filterObservation(info, filtered)}, ${scanPhrase(info)}. ${fix.text}${sortNote}${sizeCaveat(info)}`;
  const node = candidates[0].node;
  context.report(node, 'index-missing-filter', message, contextFor(info, node), {
    suggestion: fix.suggestion,
    ...relatedTo(info.table),
  });
}

function evaluateFilter(
  site: QuerySite,
  infos: ReadonlyMap<SchemaTable, TableInfo>,
  order: OrderGap | undefined,
  context: PerformanceRuleContext,
): boolean {
  if (!site.conditions.length) return false;
  // The planner narrows by any indexed conjunct first, so the others are filtered on few rows.
  if (site.conditions.some((condition) => isCovering(infoOf(infos, condition.table), condition))) return false;
  let reported = false;
  for (const [table, info] of infos) {
    const candidates = site.conditions.filter((condition) => condition.table === table && isCandidate(info, condition));
    if (!candidates.length) continue;
    reportFilter(site, info, candidates, order, context);
    reported = true;
  }
  return reported;
}

// Pattern and expression conjuncts, reported only when no other conjunct lets an index narrow the
// rows first.
function evaluateUnusable(
  site: QuerySite,
  infos: ReadonlyMap<SchemaTable, TableInfo>,
  context: PerformanceRuleContext,
): void {
  if (site.conditions.some((condition) => isCovering(infoOf(infos, condition.table), condition))) return;
  for (const condition of site.conditions) {
    const info = infoOf(infos, condition.table);
    if (condition.kind === 'expression' && info.dialect === 'postgres')
      reportExpression(site, info, condition, context);
    if (condition.kind !== 'pattern' || hasPatternIndex(info, condition.column)) continue;
    if (info.dialect === 'postgres' || info.dialect === 'mongo') reportPattern(site, info, condition, context);
  }
}

function evaluateSite(site: QuerySite, context: PerformanceRuleContext): void {
  if (site.uncertain) return;
  const tables = [...site.conditions, ...(Array.isArray(site.order) ? site.order : [])].map((entry) => entry.table);
  if (!tables.length) return;
  const infos = new Map([...new Set(tables)].map((table): [SchemaTable, TableInfo] => [table, describe(table)]));
  if ([...infos.values()].some((info) => info.table.complete === false)) return;
  // A raw SQL table without a model: only a lone pattern or expression conjunct is certain to scan.
  if ([...infos.values()].some((info) => info.table.modelless)) {
    if (site.conditions.length === 1) evaluateUnusable(site, infos, context);
    return;
  }
  const order = orderGap(site, infos);
  // An index for the filter narrows the rows first, after which the sort and patterns are cheap.
  if (evaluateFilter(site, infos, order, context)) return;
  if (order) reportOrder(site, order, context);
  evaluateUnusable(site, infos, context);
}

function checkIndexUsage(node: Node, context: PerformanceRuleContext): void {
  if (!ts.isCallExpression(node)) return;
  checkRedundantIndexes(node, context);
  if (ts.isDecorator(node.parent)) {
    checkDecoratorForeignKey(node, context);
    return;
  }
  checkDrizzleForeignKeys(node, context);
  // A query only tests run needs no production index, and the suggested one may undo a deliberate
  // drop.
  if (isTestSource(node.getSourceFile().fileName)) return;
  const site = querySite(node, context.checker) ?? rawSqlSite(node, context.checker);
  if (site) evaluateSite(site, context);
}

export { checkIndexUsage, foreignKeyFinding, declarationLink };
