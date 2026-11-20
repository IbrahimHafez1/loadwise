'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { syntax: ts } = require('./compiler.cjs');
const { prismaModelName } = require('./prisma.cjs');
const { findProjectRoot } = require('./schema/context.cjs');

const SCHEMA_LOCATIONS = [path.join('prisma', 'schema.prisma'), 'schema.prisma'];
const NATIVE_DISTINCT_FEATURE = /previewFeatures\s*=\s*\[[^\]]*["']nativeDistinct["']/;
const schemaEnablesNativeDistinct = new Map();

function propertyKey(property) {
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
}

function optionProperty(options, key) {
  return options.properties.find((property) => propertyKey(property) === key);
}

function propertyValue(property) {
  return ts.isPropertyAssignment(property) ? ts.skipOuterExpressions(property.initializer) : undefined;
}

// `distinct: 'a'` or `distinct: ['a', 'b']`; anything computed is not understood.
function distinctFields(property) {
  const value = propertyValue(property);
  if (!value) return;
  const elements = ts.isArrayLiteralExpression(value) ? value.elements : [value];
  if (!elements.length || !elements.every((element) => ts.isStringLiteralLike(element))) return;
  return elements.map((element) => element.text);
}

// The nearest project's schema decides, as `prisma generate` would.
function nativeDistinctEnabled(sourceFile) {
  const projectRoot = findProjectRoot(path.dirname(sourceFile.fileName));
  if (!schemaEnablesNativeDistinct.has(projectRoot)) {
    let enabled = false;
    for (const location of SCHEMA_LOCATIONS) {
      try {
        enabled = NATIVE_DISTINCT_FEATURE.test(fs.readFileSync(path.join(projectRoot, location), 'utf8'));
        break;
      } catch {
        // Try the next conventional location.
      }
    }
    schemaEnablesNativeDistinct.set(projectRoot, enabled);
  }
  return schemaEnablesNativeDistinct.get(projectRoot);
}

function checkDistinct(call, access, options, context) {
  const distinctProperty = optionProperty(options, 'distinct');
  const fields = distinctProperty && distinctFields(distinctProperty);
  // Rows already differ on the conventional primary key, so there are no duplicates to read and drop.
  if (!fields || fields.includes('id')) return;
  if (nativeDistinctEnabled(call.getSourceFile())) return;
  const model = prismaModelName(access.name, context.checker);
  if (!model) return;
  const list = fields.join(', ');
  context.report(
    access.name,
    'prisma-distinct-in-memory',
    `${model}.findMany({ distinct: [${list}] }) reads every matching row and removes duplicates inside Prisma's query engine, not with SQL DISTINCT, so the database still returns all duplicates. Use \`groupBy({ by: [${list}], where })\` when only those fields are selected, or a raw \`SELECT DISTINCT\`/\`DISTINCT ON\` query otherwise. Ignore this if the schema enables the nativeDistinct preview feature.`,
  );
}

// Relation names listed in `_count: { select: { rel: true } }`; null for `_count: true` (every relation).
function countedRelations(countProperty) {
  const value = propertyValue(countProperty);
  if (value?.kind === ts.SyntaxKind.TrueKeyword) return null;
  if (!value || !ts.isObjectLiteralExpression(value)) return [];
  const selection = optionProperty(value, 'select');
  const selected = selection && propertyValue(selection);
  if (!selected || !ts.isObjectLiteralExpression(selected)) return [];
  return selected.properties.map(propertyKey).filter(Boolean);
}

function relationCountProperty(options) {
  for (const key of ['select', 'include']) {
    const projection = optionProperty(options, key);
    const value = projection && propertyValue(projection);
    const countProperty = value && ts.isObjectLiteralExpression(value) && optionProperty(value, '_count');
    if (countProperty) return countProperty;
  }
}

function checkRelationCount(access, options, context) {
  if (!optionProperty(options, 'take')) return;
  const countProperty = relationCountProperty(options);
  if (!countProperty) return;
  const relations = countedRelations(countProperty);
  if (relations?.length === 0) return;
  const model = prismaModelName(access.name, context.checker);
  if (!model) return;
  const counted = relations ? `relation${relations.length > 1 ? 's' : ''} ${relations.join(', ')}` : 'every relation';
  context.report(
    access.name,
    'prisma-relation-count-in-list',
    `Paged ${model}.findMany() selects \`_count\` of ${counted}. Prisma computes it with a LEFT JOIN on a GROUP BY over the whole related table, not just this page, so cost grows with the related table instead of \`take\`. Fetch the page, then run \`groupBy({ by: ['fk'], where: { fk: { in: pageIds } }, _count: { _all: true } })\` and merge the counts by id. Ignore this if the related table stays small.`,
  );
}

// Called for every call expression.
function check(node, context) {
  const access = node.expression;
  if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'findMany') return;
  const options = node.arguments[0] && ts.skipOuterExpressions(node.arguments[0]);
  if (!options || !ts.isObjectLiteralExpression(options)) return;
  checkDistinct(node, access, options, context);
  checkRelationCount(access, options, context);
}

module.exports = { check, distinctFields, optionProperty, propertyKey, propertyValue };
