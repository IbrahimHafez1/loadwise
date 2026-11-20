'use strict';

const { sizeGateRows } = require('./checks.cjs');

// Estimate-only pass over EXPLAIN without ANALYZE: lib/plans.cjs needs actual row counts, which a generic plan lacks.
const maxQueryTextLength = 300;
const maxCandidateEqualityColumns = 3;
const comparison =
  /(\(*)("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\)?(?:::[A-Za-z ]+(?:\([0-9, ]+\))?(?:\[\])?)?\s*(=|<=|>=|<|>)\s/g;

function planRoot(document) {
  const root = Array.isArray(document) ? document[0] : document;
  return root?.Plan;
}

function* walk(node) {
  if (!node || typeof node !== 'object') return;
  yield node;
  for (const child of node.Plans ?? []) yield* walk(child);
}

function totalCost(document) {
  const cost = planRoot(document)?.['Total Cost'];
  return typeof cost === 'number' ? cost : undefined;
}

function unquote(identifier) {
  return identifier.startsWith('"') ? identifier.slice(1, -1).replaceAll('""', '"') : identifier;
}

// Columns compared directly in a plan Filter, equality first. Columns wrapped in a function call are skipped:
// a plain index would not serve them.
function filterColumns(filter) {
  const equality = [];
  const range = [];
  for (const match of String(filter ?? '').matchAll(comparison)) {
    const before = filter.slice(0, match.index);
    // `lower(email)`: a name directly before the parenthesis is a function call.
    if (/[A-Za-z0-9_]$/.test(before)) continue;
    const column = unquote(match[2]);
    const target = match[3] === '=' ? equality : range;
    if (!equality.includes(column) && !range.includes(column)) target.push(column);
  }
  return { equality, range };
}

function resolveTable(model, node) {
  const name = node['Relation Name'];
  if (!name) return;
  if (node.Schema) return model.get(`${node.Schema}.${name}`);
  const matches = [...model.values()].filter((table) => table.name === name);
  if (matches.length === 1) return matches[0];
  return matches.find((table) => table.schema === 'public');
}

function isLeadingInBtree(table, column) {
  return table.indexes.some(
    (index) => index.method === 'btree' && !index.predicate && index.keys[0]?.column === column,
  );
}

// Equality columns, then one range column: the composite order design 2.3 prescribes.
function candidateColumns(table, filter) {
  const known = (column) => table.columns.includes(column);
  const { equality, range } = filterColumns(filter);
  const equalityColumns = equality.filter(known).slice(0, maxCandidateEqualityColumns);
  const rangeColumn = range.find(known);
  const columns = rangeColumn ? [...equalityColumns, rangeColumn] : equalityColumns;
  if (columns.length === 0 || columns.some((column) => isLeadingInBtree(table, column))) return [];
  return columns;
}

/** Sequential scans of tables at or above the size gate whose filter names indexable columns. */
function seqScanCandidates(document, model) {
  const candidates = [];
  for (const node of walk(planRoot(document))) {
    if (node['Node Type'] !== 'Seq Scan' || !node.Filter) continue;
    const table = resolveTable(model, node);
    if (!table || table.rowEstimate === undefined || table.rowEstimate < sizeGateRows) continue;
    const columns = candidateColumns(table, node.Filter);
    if (columns.length === 0) continue;
    candidates.push({ table, columns, planRows: node['Plan Rows'] });
  }
  return candidates;
}

function planUsesIndex(document, indexName) {
  for (const node of walk(planRoot(document))) {
    if (node['Index Name'] === indexName) return true;
  }
  return false;
}

function describeQuery(text) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  return collapsed.length > maxQueryTextLength ? collapsed.slice(0, maxQueryTextLength - 3) + '...' : collapsed;
}

function formatCost(cost) {
  return cost.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function hypotheticalImpact(hypothetical) {
  return {
    kind: 'estimated',
    before: Math.round(hypothetical.before),
    after: Math.round(hypothetical.after),
    unit: 'planner cost',
    method: 'HypoPG hypothetical index, planner cost estimate',
  };
}

/**
 * One finding per scanned table of a statement. `subject` already names the statement and how it was observed;
 * `hypothetical` is the HypoPG result and `measured` the --measure impact, either of which may be absent.
 */
function planFinding({ subject, location, candidate, fix, hypothetical, measured }) {
  const { table } = candidate;
  const columns = candidate.columns.map((column) => `\`${column}\``).join(', ');
  const scan =
    `${subject} plans a sequential scan of \`${table.schema}.${table.name}\` (about ` +
    `${Math.round(table.rowEstimate).toLocaleString('en-US')} rows, estimated) filtering on ${columns}.`;
  const validated = Boolean(measured) || Boolean(hypothetical?.used);
  let advice;
  if (measured) {
    advice = ` Building the index inside a rolled-back transaction on this database confirmed the gain. Add it: \`${fix}\``;
  } else if (hypothetical?.used) {
    advice =
      ` With a hypothetical \`${fix}\` the planner switches to it (cost ${formatCost(hypothetical.before)} -> ` +
      `${formatCost(hypothetical.after)}, estimated by HypoPG). Add it.`;
  } else if (hypothetical) {
    advice = ` A hypothetical \`${fix}\` did not change the plan (HypoPG), so the filter is not selective enough for it; narrow the query or index a more selective column.`;
  } else {
    advice = ` Add \`${fix}\`, then confirm the plan change with HypoPG or \`--measure\` on staging.`;
  }
  const finding = {
    ...(location ?? { target: `${table.schema}.${table.name}` }),
    ruleId: validated ? 'db-missing-index' : 'db-slow-query-plan',
    message: scan + advice,
    suggestion: fix,
  };
  if (measured) finding.impact = measured;
  else if (hypothetical?.used) finding.impact = hypotheticalImpact(hypothetical);
  return finding;
}

function* mysqlTableAccesses(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* mysqlTableAccesses(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof value.access_type === 'string' && typeof value.table_name === 'string') yield value;
  for (const child of Object.values(value)) yield* mysqlTableAccesses(child);
}

/** Full table scans (access_type ALL) of tables at or above the size gate in MySQL EXPLAIN FORMAT=JSON. */
function mysqlFullScans(document, model) {
  const scans = [];
  for (const access of mysqlTableAccesses(document?.query_block)) {
    if (access.access_type !== 'ALL') continue;
    const table = [...model.values()].find((candidate) => candidate.name === access.table_name);
    if (!table || table.rowEstimate === undefined || table.rowEstimate < sizeGateRows) continue;
    scans.push({ table, rowsPerScan: Number(access.rows_examined_per_scan) || undefined });
  }
  const cost = Number(document?.query_block?.cost_info?.query_cost);
  return { scans, queryCost: Number.isFinite(cost) ? cost : undefined };
}

module.exports = {
  mysqlFullScans,
  planFinding,
  totalCost,
  filterColumns,
  seqScanCandidates,
  planUsesIndex,
  describeQuery,
  walk,
  planRoot,
};
