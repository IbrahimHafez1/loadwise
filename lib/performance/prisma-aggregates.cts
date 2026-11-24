import fs from 'node:fs';
import path from 'node:path';
import { loadSyntax } from './compiler.cjs';
import { noteUnreadable } from '../shared/coverage-notes.cjs';
import { prismaModelName } from './prisma.cjs';
import { findProjectRoot } from './schema/context.cjs';
import type {
  CallExpression,
  Expression,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  PropertyAccessExpression,
  SourceFile,
} from 'typescript';
import type { RuleContext } from '../shared/types.cjs';
const ts = loadSyntax();

const SCHEMA_LOCATIONS = [path.join('prisma', 'schema.prisma'), 'schema.prisma'];
const NATIVE_DISTINCT_FEATURE = /previewFeatures\s*=\s*\[[^\]]*["']nativeDistinct["']/;
const schemaEnablesNativeDistinct = new Map<string, boolean>();

function propertyKey(property: ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
}

function optionProperty(options: ObjectLiteralExpression, key: string): ObjectLiteralElementLike | undefined {
  return options.properties.find((property) => propertyKey(property) === key);
}

function propertyValue(property: ObjectLiteralElementLike): Expression | undefined {
  return ts.isPropertyAssignment(property) ? ts.skipOuterExpressions(property.initializer) : undefined;
}

// `distinct: 'a'` or `distinct: ['a', 'b']`; anything computed is not understood.
function distinctFields(property: ObjectLiteralElementLike): string[] | undefined {
  const value = propertyValue(property);
  if (!value) return;
  const elements: readonly Expression[] = ts.isArrayLiteralExpression(value) ? value.elements : [value];
  const literals = elements.filter(ts.isStringLiteralLike);
  if (!elements.length || literals.length !== elements.length) return;
  return literals.map((element) => element.text);
}

// The nearest project's schema decides, as `prisma generate` would.
function nativeDistinctEnabled(sourceFile: SourceFile): boolean {
  const projectRoot = findProjectRoot(path.dirname(sourceFile.fileName));
  let enabled = schemaEnablesNativeDistinct.get(projectRoot);
  if (enabled === undefined) {
    enabled = false;
    for (const location of SCHEMA_LOCATIONS) {
      try {
        enabled = NATIVE_DISTINCT_FEATURE.test(fs.readFileSync(path.join(projectRoot, location), 'utf8'));
        break;
      } catch (error) {
        // Try the next conventional location; only a schema that exists but cannot be read is worth
        // a note.
        if (error instanceof Error)
          noteUnreadable({
            error,
            location: path.join(projectRoot, location),
            consequence: 'treated nativeDistinct as off',
          });
      }
    }
    schemaEnablesNativeDistinct.set(projectRoot, enabled);
  }
  return enabled;
}

function checkDistinct(
  call: CallExpression,
  access: PropertyAccessExpression,
  options: ObjectLiteralExpression,
  context: RuleContext,
) {
  const distinctProperty = optionProperty(options, 'distinct');
  const fields = distinctProperty && distinctFields(distinctProperty);
  // Rows already differ on the conventional primary key, so there are no duplicates to read and
  // drop.
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

// Relation names listed in `_count: { select: { rel: true } }`; null for `_count: true` (every
// relation).
function countedRelations(countProperty: ObjectLiteralElementLike): string[] | null {
  const value = propertyValue(countProperty);
  if (value?.kind === ts.SyntaxKind.TrueKeyword) return null;
  if (!value || !ts.isObjectLiteralExpression(value)) return [];
  const selection = optionProperty(value, 'select');
  const selected = selection && propertyValue(selection);
  if (!selected || !ts.isObjectLiteralExpression(selected)) return [];
  return selected.properties.map(propertyKey).filter((key): key is string => !!key);
}

function relationCountProperty(options: ObjectLiteralExpression): ObjectLiteralElementLike | undefined {
  for (const key of ['select', 'include']) {
    const projection = optionProperty(options, key);
    const value = projection && propertyValue(projection);
    const countProperty = value && ts.isObjectLiteralExpression(value) && optionProperty(value, '_count');
    if (countProperty) return countProperty;
  }
}

function checkRelationCount(access: PropertyAccessExpression, options: ObjectLiteralExpression, context: RuleContext) {
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
function check(node: CallExpression, context: RuleContext) {
  const access = node.expression;
  if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'findMany') return;
  const options = node.arguments[0] && ts.skipOuterExpressions(node.arguments[0]);
  if (!options || !ts.isObjectLiteralExpression(options)) return;
  checkDistinct(node, access, options, context);
  checkRelationCount(access, options, context);
}

export { check, distinctFields, optionProperty, propertyKey, propertyValue };
