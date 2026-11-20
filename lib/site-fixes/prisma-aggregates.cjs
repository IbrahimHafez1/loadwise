'use strict';

const { ts, calleeCall, replaceNode, textOf } = require('./helpers.cjs');
const { distinctFields, optionProperty, propertyKey, propertyValue } = require('../prisma-aggregates.cjs');

const FIXABLE_OPTIONS = new Set(['where', 'select', 'distinct', 'orderBy']);
const SORT_DIRECTIONS = new Set(['asc', 'desc']);

// `select: { a: true }` whose keys all belong to the distinct fields.
function selectsOnly(selectProperty, fields) {
  const value = propertyValue(selectProperty);
  if (!value || !ts.isObjectLiteralExpression(value) || !value.properties.length) return false;
  return value.properties.every(
    (property) =>
      ts.isPropertyAssignment(property) &&
      fields.includes(propertyKey(property)) &&
      property.initializer.kind === ts.SyntaxKind.TrueKeyword,
  );
}

// groupBy only orders by its `by` fields (or aggregates), so a sort on anything else cannot move over.
function ordersOnly(orderByProperty, fields) {
  const value = propertyValue(orderByProperty);
  if (!value) return false;
  const entries = ts.isArrayLiteralExpression(value) ? value.elements : [value];
  return entries.every(
    (entry) =>
      ts.isObjectLiteralExpression(entry) &&
      entry.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          fields.includes(propertyKey(property)) &&
          ts.isStringLiteralLike(property.initializer) &&
          SORT_DIRECTIONS.has(property.initializer.text),
      ),
  );
}

function distinctFix({ node }) {
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.arguments.length !== 1) return;
  const options = call.arguments[0];
  if (!ts.isObjectLiteralExpression(options)) return;
  if (!options.properties.every((property) => FIXABLE_OPTIONS.has(propertyKey(property)))) return;
  const distinctProperty = optionProperty(options, 'distinct');
  const selectProperty = optionProperty(options, 'select');
  const fields = distinctProperty && distinctFields(distinctProperty);
  if (!fields || !selectProperty || !selectsOnly(selectProperty, fields)) return;
  const orderByProperty = optionProperty(options, 'orderBy');
  if (orderByProperty && !ordersOnly(orderByProperty, fields)) return;
  const kept = ['where', 'orderBy'].flatMap((key) => {
    const property = optionProperty(options, key);
    return property ? [textOf(property)] : [];
  });
  const by = `by: [${fields.map((field) => `'${field}'`).join(', ')}]`;
  return {
    edits: [replaceNode(call.expression.name, 'groupBy'), replaceNode(options, `{ ${[by, ...kept].join(', ')} }`)],
    note: 'groupBy returns one row per distinct combination; rows come back in unspecified order unless orderBy is set.',
  };
}

module.exports = { 'prisma-distinct-in-memory': distinctFix };
