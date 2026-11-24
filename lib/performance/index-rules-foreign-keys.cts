import { loadSyntax } from './compiler.cjs';
import { calleeName, propertyName, declaredInPackage } from './schema/ts-helpers.cjs';
import { drizzleTableFromCall } from './schema/drizzle-schema.cjs';
import { typeormTable } from './schema/typeorm-schema.cjs';
import { sequelizeTableOf } from './schema/sequelize-schema.cjs';
import type { CallExpression, Node } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.cjs';
import type { SchemaOrm, SchemaTable } from './types/schema-model.cjs';
import {
  contextForFile,
  describe,
  indexFix,
  indexLabel,
  isCovering,
  nonLeadingIndex,
  ordinal,
  sizeCaveat,
} from './index-rules-table.cjs';

const ts = loadSyntax();

interface ForeignKeyFinding {
  message: string;
  suggestion: string;
  contextualReason: string | undefined;
}

// PostgreSQL does not index the referencing side of a foreign key, unlike MySQL's InnoDB.
export function foreignKeyFinding(
  table: SchemaTable,
  columnName: string,
  orm: SchemaOrm | undefined,
): ForeignKeyFinding | undefined {
  const column = table.columns.get(columnName);
  const target = column?.foreignKey?.table;
  if (!target || (column.foreignKey?.position ?? 0) > 0 || table.complete === false) return;
  const info = describe(table);
  if (info.dialect !== 'postgres' || isCovering(info, { column: columnName, kind: 'eq' })) return;
  const label = `\`${table.name}.${columnName}\``;
  const partial = nonLeadingIndex(table, columnName);
  const observation = partial
    ? `${label} references \`${target}\` but is only the ${ordinal(partial.position + 1)} column of ${indexLabel(partial.index)}`
    : `${label} references \`${target}\` and no index starts with it`;
  const consequence =
    `so deleting or updating a \`${target}\` row scans \`${table.dbName}\` to check the reference, ` +
    `and joins from \`${target}\` cannot use an index`;
  const fix = indexFix(info, [columnName], orm);
  const caveat = ' PostgreSQL does not create this index for a foreign key automatically.';
  const file = column.file ?? table.file;
  return {
    message: `${observation}, ${consequence}. ${fix.text}${caveat}${sizeCaveat(info)}`,
    suggestion: fix.suggestion,
    contextualReason: file === undefined ? undefined : contextForFile(info, file, 'Schema'),
  };
}

function reportForeignKey(context: PerformanceRuleContext, node: Node, table: SchemaTable, columnName: string): void {
  const finding = foreignKeyFinding(table, columnName, table.orm);
  if (!finding) return;
  context.report(node, 'index-missing-foreign-key', finding.message, finding.contextualReason, {
    suggestion: finding.suggestion,
  });
}

const drizzleTableBuilders = new Set(['pgTable', 'table']);

// `pgTable('orders', { customerId: uuid().references(() => users.id) })`: one finding per
// referencing column.
export function checkDrizzleForeignKeys(call: CallExpression, context: PerformanceRuleContext): void {
  const builder = calleeName(call);
  if (builder === undefined || !drizzleTableBuilders.has(builder)) return;
  const table = drizzleTableFromCall(call, context.checker);
  const columns = call.arguments[1] && ts.skipOuterExpressions(call.arguments[1]);
  if (!table || !columns || !ts.isObjectLiteralExpression(columns)) return;
  for (const property of columns.properties) {
    const name = propertyName(property);
    if (name && property.name && table.columns.get(name)?.foreignKey) {
      reportForeignKey(context, property.name, table, name);
    }
  }
}

// `@ManyToOne(() => School) @JoinColumn({ name: 'school_id' })` or sequelize-typescript
// `@ForeignKey(() => Store)`.
export function checkDecoratorForeignKey(call: CallExpression, context: PerformanceRuleContext): void {
  const decorator = call.parent;
  const property = decorator.parent;
  if (!ts.isPropertyDeclaration(property) || !ts.isIdentifier(property.name) || !ts.isIdentifier(call.expression)) {
    return;
  }
  const name = property.name.text;
  const { checker } = context;
  if (call.expression.text === 'ManyToOne' && declaredInPackage(call.expression, checker, ['typeorm'])) {
    const table = typeormTable(property.parent, checker);
    const column = [...(table?.columns.values() ?? [])].find(
      (candidate) => candidate.foreignKey?.property === name && candidate.foreignKey.explicitName,
    );
    if (table && column) reportForeignKey(context, property.name, table, column.name);
  } else if (
    call.expression.text === 'ForeignKey' &&
    declaredInPackage(call.expression, checker, ['sequelize-typescript']) &&
    property.parent.name
  ) {
    const table = sequelizeTableOf(property.parent.name, checker);
    if (table?.columns.get(name)?.foreignKey) reportForeignKey(context, property.name, table, name);
  }
}
