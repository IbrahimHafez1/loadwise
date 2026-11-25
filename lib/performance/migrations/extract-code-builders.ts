import ts from 'typescript';
import { extractSqlText } from './extract-sql.js';
import type { CallExpression, Expression, Node, SourceFile } from 'typescript';
import type { ConstraintType, MigrationDialect } from '../types/migration-operations.js';
import { isFunctionLike, objectProperty, unwrapExpression } from './extract-code-discovery.js';
import {
  MIKRO_ORM_SQL_METHODS,
  builderOperation,
  describeBuilderDefault,
  functionCallDefault,
  offsetMapper,
  parseDefaultSql,
  sqlFromExpression,
  stringArgument,
  tableArgument,
} from './extract-code-sql.js';
import type {
  AttributeFields,
  BuilderDefault,
  BuilderFields,
  ChainCall,
  CodeOperation,
  UnitContext,
} from './extract-code-types.js';

const QUERY_RECEIVER = /queryrunner|sequelize|manager/i;

const RAW_RECEIVER = /knex|schema|trx|transaction/i;

const SEQUELIZE_RECEIVER = /queryinterface/i;

const KNEX_SERIAL_TYPES = new Set(['increments', 'bigIncrements']);

const KNEX_IGNORED_METHODS = new Set(['timestamps', 'comment', 'engine', 'charset', 'collate', 'inherits']);

const SEQUELIZE_CONSTRAINT_TYPES: Partial<Record<string, ConstraintType>> = {
  'foreign key': 'foreign',
  unique: 'unique',
  check: 'check',
  'primary key': 'primary',
};

const TYPEORM_CONSTRAINT_METHODS: Partial<Record<string, ConstraintType>> = {
  createForeignKey: 'foreign',
  createForeignKeys: 'foreign',
  createUniqueConstraint: 'unique',
  createUniqueConstraints: 'unique',
  createPrimaryKey: 'primary',
  createCheckConstraint: 'check',
  createCheckConstraints: 'check',
};

function typeormColumnFields(columnNode: Node | undefined, sourceFile: SourceFile, dialect: MigrationDialect) {
  const column = unwrapExpression(columnNode);
  const options = column && ts.isNewExpression(column) ? column.arguments?.[0] : column;
  if (!options || !ts.isObjectLiteralExpression(options)) return { columnName: null, dynamicDefinition: true };
  const read = (name: string) => objectProperty(options, name)?.initializer;
  const isNullable = read('isNullable');
  const isGenerated = read('isGenerated');
  const isPrimary = read('isPrimary');
  const defaultNode = read('default');
  const defaultText = defaultNode ? stringArgument(defaultNode) : null;
  const generated = isGenerated !== undefined && isGenerated.kind === ts.SyntaxKind.TrueKeyword;
  return {
    columnName: stringArgument(read('name')),
    notNull:
      !(isNullable && isNullable.kind === ts.SyntaxKind.TrueKeyword) &&
      !(isPrimary && isPrimary.kind === ts.SyntaxKind.TrueKeyword),
    hasDefault: Boolean(defaultNode) || generated,
    defaultExpression:
      defaultText !== null && dialect === 'postgres'
        ? parseDefaultSql(defaultText)
        : generated
          ? functionCallDefault(stringArgument(read('generationStrategy')) === 'uuid' ? 'gen_random_uuid' : 'nextval')
          : null,
  };
}

function typeormBuilderOperations(
  call: CallExpression,
  method: string,
  sourceFile: SourceFile,
  dialect: MigrationDialect,
): CodeOperation[] {
  const [first, second, third] = call.arguments;
  const table = tableArgument(first);
  const make = (fields: BuilderFields) => builderOperation(call, sourceFile, { table, ...fields });
  switch (method) {
    case 'createTable':
      return [make({ kind: 'create-table' })];
    case 'createIndex':
    case 'createIndices':
      return [make({ kind: 'create-index' })];
    case 'addColumn':
      return [make({ kind: 'add-column', ...typeormColumnFields(second, sourceFile, dialect) })];
    case 'addColumns': {
      const columns: readonly Expression[] = second && ts.isArrayLiteralExpression(second) ? second.elements : [];
      return columns.map((column) => make({ kind: 'add-column', ...typeormColumnFields(column, sourceFile, dialect) }));
    }
    case 'dropColumn':
      return [make({ kind: 'drop-column', columnName: stringArgument(second) })];
    case 'dropColumns':
      return [make({ kind: 'drop-column', columnName: null })];
    case 'dropTable':
      return [make({ kind: 'drop-table' })];
    case 'renameColumn':
      return [make({ kind: 'rename-column', columnName: stringArgument(second), newName: stringArgument(third) })];
    case 'renameTable':
      return [make({ kind: 'rename-table', newName: stringArgument(second) })];
    case 'changeColumn':
      return [make({ kind: 'alter-column-type', columnName: stringArgument(second), type: null })];
    default:
      if (TYPEORM_CONSTRAINT_METHODS[method]) {
        return [make({ kind: 'add-constraint', constraintType: TYPEORM_CONSTRAINT_METHODS[method] })];
      }
      return [];
  }
}

function hasTrueProperty(argumentsList: readonly Node[], name: string) {
  return argumentsList.some((argument) => {
    const property = objectProperty(unwrapExpression(argument), name);
    return property?.initializer.kind === ts.SyntaxKind.TrueKeyword;
  });
}

function sequelizeAttributeFields(
  attributesNode: Node | undefined,
  sourceFile: SourceFile,
  dialect: MigrationDialect,
): AttributeFields {
  const attributes = unwrapExpression(attributesNode);
  if (!attributes || !ts.isObjectLiteralExpression(attributes)) return { dynamicDefinition: true };
  const allowNull = objectProperty(attributes, 'allowNull')?.initializer;
  const primaryKey = objectProperty(attributes, 'primaryKey')?.initializer;
  const autoIncrement = objectProperty(attributes, 'autoIncrement')?.initializer;
  const defaultValue = objectProperty(attributes, 'defaultValue')?.initializer;
  const described = describeBuilderDefault(defaultValue, sourceFile, dialect);
  return {
    notNull: allowNull?.kind === ts.SyntaxKind.FalseKeyword || primaryKey?.kind === ts.SyntaxKind.TrueKeyword,
    serial: autoIncrement?.kind === ts.SyntaxKind.TrueKeyword,
    ...described,
  };
}

function sequelizeBuilderOperations(
  call: CallExpression,
  method: string,
  sourceFile: SourceFile,
  dialect: MigrationDialect,
): CodeOperation[] {
  const [first, second, third] = call.arguments;
  const table = tableArgument(first);
  const make = (fields: BuilderFields) => builderOperation(call, sourceFile, { table, ...fields });
  switch (method) {
    case 'createTable':
      return [make({ kind: 'create-table' })];
    case 'addIndex':
      return [make({ kind: 'create-index', concurrent: hasTrueProperty(call.arguments.slice(1), 'concurrently') })];
    case 'removeIndex':
      return [make({ kind: 'drop-index', concurrent: hasTrueProperty(call.arguments.slice(1), 'concurrently') })];
    case 'addColumn':
      return [
        make({
          kind: 'add-column',
          columnName: stringArgument(second),
          ...sequelizeAttributeFields(third, sourceFile, dialect),
        }),
      ];
    case 'removeColumn':
      return [make({ kind: 'drop-column', columnName: stringArgument(second) })];
    case 'renameColumn':
      return [make({ kind: 'rename-column', columnName: stringArgument(second), newName: stringArgument(third) })];
    case 'dropTable':
      return [make({ kind: 'drop-table' })];
    case 'renameTable':
      return [make({ kind: 'rename-table', newName: stringArgument(second) })];
    case 'changeColumn': {
      const columnName = stringArgument(second);
      const operations = [make({ kind: 'alter-column-type', columnName, type: null })];
      if (sequelizeAttributeFields(third, sourceFile, dialect).notNull)
        operations.push(make({ kind: 'set-not-null', columnName }));
      return operations;
    }
    case 'addConstraint': {
      const options = unwrapExpression(second);
      const type = stringArgument(objectProperty(options, 'type')?.initializer)?.toLowerCase();
      const constraintType = (type === undefined ? undefined : SEQUELIZE_CONSTRAINT_TYPES[type]) ?? 'other';
      return [make({ kind: 'add-constraint', constraintType })];
    }
    case 'bulkInsert':
    case 'bulkUpdate':
    case 'bulkDelete':
      return [make({ kind: 'data' })];
    default:
      return [];
  }
}

function isChainCall(node: Node): node is ChainCall {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression);
}

// Method chain of `t.string('c').notNullable().defaultTo(...)`, root call first.
function callChain(call: CallExpression) {
  const chain: ChainCall[] = [];
  let current: Expression = call;
  while (isChainCall(current)) {
    chain.unshift(current);
    current = current.expression.expression;
  }
  return { chain, root: current };
}

function knexColumnOperations(
  chain: ChainCall[],
  table: string | null,
  sourceFile: SourceFile,
  dialect: MigrationDialect,
): CodeOperation[] {
  const [rootCall] = chain;
  const methods = chain.map((call) => call.expression.name.text);
  const rootMethod = methods[0];
  const make = (fields: BuilderFields) => builderOperation(rootCall, sourceFile, { table, ...fields });
  const columnName = stringArgument(rootCall.arguments[0]);
  switch (rootMethod) {
    case 'index':
      return [make({ kind: 'create-index' })];
    case 'unique':
      return [make({ kind: 'add-constraint', constraintType: 'unique' })];
    case 'primary':
      return [make({ kind: 'add-constraint', constraintType: 'primary' })];
    case 'foreign':
      return [make({ kind: 'add-constraint', constraintType: 'foreign' })];
    case 'dropColumn':
    case 'dropColumns':
      return rootCall.arguments.map((argument) => make({ kind: 'drop-column', columnName: stringArgument(argument) }));
    case 'renameColumn':
      return [make({ kind: 'rename-column', columnName, newName: stringArgument(rootCall.arguments[1]) })];
    case 'dropNullable':
      return [make({ kind: 'set-not-null', columnName })];
    case 'setNullable':
    case 'dropIndex':
    case 'dropForeign':
    case 'dropUnique':
    case 'dropPrimary':
      return [make({ kind: 'alter-table-other', subtype: rootMethod })];
    default:
      break;
  }
  if (KNEX_IGNORED_METHODS.has(rootMethod) || columnName === null) return [];
  if (methods.includes('alter')) {
    const operations = [make({ kind: 'alter-column-type', columnName, type: null })];
    if (methods.includes('notNullable')) operations.push(make({ kind: 'set-not-null', columnName }));
    return operations;
  }
  const defaultCall = chain.find((call) => call.expression.name.text === 'defaultTo');
  const described: BuilderDefault = defaultCall
    ? describeBuilderDefault(defaultCall.arguments[0], sourceFile, dialect)
    : { hasDefault: false, defaultExpression: null };
  return [
    make({
      kind: 'add-column',
      columnName,
      notNull: methods.includes('notNullable') || methods.includes('primary'),
      serial: KNEX_SERIAL_TYPES.has(rootMethod),
      ...described,
    }),
  ];
}

function knexAlterTableOperations(
  call: CallExpression,
  sourceFile: SourceFile,
  dialect: MigrationDialect,
): CodeOperation[] {
  const table = stringArgument(call.arguments[0]);
  const callback = call.arguments[1];
  if (!isFunctionLike(callback) || callback.parameters.length === 0) return [];
  const builderName = callback.parameters[0].name.getText(sourceFile);
  const operations: CodeOperation[] = [];
  const visit = (node: Node) => {
    if (ts.isCallExpression(node) && !ts.isPropertyAccessExpression(node.parent)) {
      const { chain, root } = callChain(node);
      if (chain.length > 0 && ts.isIdentifier(root) && root.text === builderName) {
        operations.push(...knexColumnOperations(chain, table, sourceFile, dialect));
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  if (callback.body) visit(callback.body);
  return operations;
}

function knexSchemaOperations(
  call: CallExpression,
  method: string,
  sourceFile: SourceFile,
  dialect: MigrationDialect,
): CodeOperation[] {
  const table = stringArgument(call.arguments[0]);
  const make = (fields: BuilderFields) => builderOperation(call, sourceFile, { table, ...fields });
  switch (method) {
    case 'createTable':
    case 'createTableIfNotExists':
      return [make({ kind: 'create-table' })];
    case 'alterTable':
    case 'table':
      return knexAlterTableOperations(call, sourceFile, dialect);
    case 'dropTable':
    case 'dropTableIfExists':
      return [make({ kind: 'drop-table' })];
    case 'renameTable':
      return [make({ kind: 'rename-table', newName: stringArgument(call.arguments[1]) })];
    default:
      return [];
  }
}

export function isRawSqlCall(
  method: string,
  receiverText: string,
  { framework, firstParameter }: Pick<UnitContext, 'framework' | 'firstParameter'>,
) {
  if (framework === 'mikro-orm' && MIKRO_ORM_SQL_METHODS.has(method)) return receiverText === 'this';
  if (method === 'query') return QUERY_RECEIVER.test(receiverText) || receiverText === firstParameter;
  if (method === 'raw') return RAW_RECEIVER.test(receiverText) || receiverText === firstParameter;
  return false;
}

export function rawSqlOperations(call: CallExpression, context: UnitContext): CodeOperation[] {
  const built = sqlFromExpression(call.arguments[0], context.sourceFile, 0, context.bindings);
  if (!built) return [];
  const { operations } = extractSqlText(built.sql, {
    dialect: context.dialect,
    file: context.file,
    mapOffset: offsetMapper(built, context.sourceFile),
  });
  return operations;
}

export function builderOperations(
  call: CallExpression,
  method: string,
  receiverText: string,
  context: UnitContext,
): CodeOperation[] {
  const { framework, sourceFile, dialect, firstParameter } = context;
  if (framework === 'typeorm' && (QUERY_RECEIVER.test(receiverText) || receiverText === firstParameter)) {
    return typeormBuilderOperations(call, method, sourceFile, dialect);
  }
  if (framework === 'sequelize' && (SEQUELIZE_RECEIVER.test(receiverText) || receiverText === firstParameter)) {
    return sequelizeBuilderOperations(call, method, sourceFile, dialect);
  }
  if (framework === 'knex' && /\bschema\b/.test(receiverText)) {
    return knexSchemaOperations(call, method, sourceFile, dialect);
  }
  return [];
}
