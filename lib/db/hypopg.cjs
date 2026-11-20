'use strict';

const { indexDefinition } = require('./pg-catalog.cjs');
const { totalCost, planUsesIndex } = require('./plan-estimates.cjs');

const extensionName = 'hypopg';
const missingNote =
  'HypoPG is not installed in this database, so suggested indexes are not validated against the planner. ' +
  'On staging, `CREATE EXTENSION hypopg;` lets `db` report estimated cost before and after.';

function hypopgAvailable(extensions) {
  return extensions.some((row) => row.name === extensionName);
}

async function resetHypotheticalIndexes(gateway) {
  try {
    await gateway.catalog('hypopgReset');
    return true;
  } catch {
    return false;
  }
}

/**
 * EXPLAIN, create a hypothetical index (planner-only, nothing is built), EXPLAIN again, reset; all in one read-only
 * transaction. Hypothetical indexes live in session memory and survive ROLLBACK, so the reset is retried outside
 * the transaction when the first attempt fails.
 */
async function evaluateHypotheticalIndex(gateway, { sql, generic, candidate }) {
  const definition = indexDefinition({
    schema: candidate.table.schema,
    table: candidate.table.name,
    columns: candidate.columns,
  });
  let resetDone = false;
  try {
    return await gateway.unit(async () => {
      try {
        const before = await gateway.explain(sql, { generic });
        const [created] = await gateway.catalog('hypopgCreateIndex', [definition]);
        const after = await gateway.explain(sql, { generic });
        return {
          before: totalCost(before),
          after: totalCost(after),
          used: Boolean(created?.indexname) && planUsesIndex(after, created.indexname),
        };
      } finally {
        resetDone = await resetHypotheticalIndexes(gateway);
      }
    });
  } finally {
    if (!resetDone) await resetHypotheticalIndexes(gateway);
  }
}

module.exports = { hypopgAvailable, evaluateHypotheticalIndex, missingNote };
