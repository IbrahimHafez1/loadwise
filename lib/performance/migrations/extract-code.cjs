'use strict';

// Syntax-only extraction from TypeORM, Knex, Sequelize and MikroORM migration modules. No type checker and no
// native engine: the receiver of a call is recognized by its name, and only the `up` direction is read.

const ts = require('typescript');
const pgParser = require('../sql/pg-parser.cjs');
const { extractSqlText } = require('./extract-sql.cjs');
const { DYNAMIC_PLACEHOLDER_PREFIX, createOperation } = require('./operations.cjs');

const QUERY_RECEIVER = /queryrunner|sequelize|manager/i;
const RAW_RECEIVER = /knex|schema|trx|transaction/i;
const SEQUELIZE_RECEIVER = /queryinterface/i;
const TYPEORM_SIGNATURE = /\bMigrationInterface\b|\bQueryRunner\b|\bqueryRunner\b/;
const SEQUELIZE_SIGNATURE = /\bqueryInterface\b|\bQueryInterface\b/;
const KNEX_SIGNATURE = /\bknex\b|\bKnex\b/;
// `@mikro-orm/migrations`, or a framework re-export such as Medusa's `@medusajs/framework/mikro-orm/migrations`.
const MIKRO_ORM_IMPORT = /\bfrom\s+['"][^'"]*mikro-orm\/migrations['"]/;
const MIKRO_ORM_CLASS = /\bextends\s+Migration\b/;
const MIKRO_ORM_SQL_METHODS = new Set(['addSql', 'execute']);
const CLIENT_SIDE_DEFAULTS = /\b(?:UUIDV4|UUIDV1)\b/;
const KNEX_SERIAL_TYPES = new Set(['increments', 'bigIncrements']);
const KNEX_IGNORED_METHODS = new Set(['timestamps', 'comment', 'engine', 'charset', 'collate', 'inherits']);
const SEQUELIZE_CONSTRAINT_TYPES = {
  'foreign key': 'foreign',
  unique: 'unique',
  check: 'check',
  'primary key': 'primary',
};
const TYPEORM_CONSTRAINT_METHODS = {
  createForeignKey: 'foreign',
  createForeignKeys: 'foreign',
  createUniqueConstraint: 'unique',
  createUniqueConstraints: 'unique',
  createPrimaryKey: 'primary',
  createCheckConstraint: 'check',
  createCheckConstraints: 'check',
};

function scriptKindFor(file) {
  if (/\.[cm]?tsx?$/i.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function detectFramework(text) {
  if (MIKRO_ORM_IMPORT.test(text) && MIKRO_ORM_CLASS.test(text)) return 'mikro-orm';
  if (TYPEORM_SIGNATURE.test(text)) return 'typeorm';
  if (SEQUELIZE_SIGNATURE.test(text)) return 'sequelize';
  if (KNEX_SIGNATURE.test(text)) return 'knex';
  return 'unknown';
}

function propertyName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

function isFunctionLike(node) {
  return (
    node !== undefined &&
    (ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionDeclaration(node))
  );
}

function isExportsMember(expression, member) {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== member) return false;
  const target = expression.expression;
  if (ts.isIdentifier(target)) return target.text === 'exports';
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === 'exports' &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === 'module'
  );
}

// `up` as a class method, an object-literal member, `exports.up = ...` or an exported function/const.
function findUpFunctions(sourceFile) {
  const found = [];
  const visit = (node) => {
    if ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && propertyName(node.name) === 'up') {
      const target = ts.isPropertyAssignment(node) ? node.initializer : node;
      if (isFunctionLike(target)) found.push({ fn: target, owner: node.parent });
    } else if (ts.isPropertyDeclaration(node) && propertyName(node.name) === 'up' && isFunctionLike(node.initializer)) {
      found.push({ fn: node.initializer, owner: node.parent });
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'up') {
      const declared = findDeclaration(node, 'up');
      if (declared) found.push({ fn: declared, owner: node.parent });
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === 'up' && hasExportModifier(node)) {
      found.push({ fn: node, owner: sourceFile });
    } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (declaration.name.getText(sourceFile) === 'up' && isFunctionLike(declaration.initializer)) {
          found.push({ fn: declaration.initializer, owner: sourceFile });
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isExportsMember(node.left, 'up') &&
      isFunctionLike(node.right)
    ) {
      found.push({ fn: node.right, owner: sourceFile });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function hasExportModifier(node) {
  return (ts.getModifiers?.(node) ?? node.modifiers ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function isFalseLiteral(node) {
  let current = node;
  while (current && (ts.isAsExpression(current) || ts.isParenthesizedExpression(current))) current = current.expression;
  return current?.kind === ts.SyntaxKind.FalseKeyword;
}

function objectProperty(objectLiteral, name) {
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) return undefined;
  return objectLiteral.properties.find(
    (property) => ts.isPropertyAssignment(property) && propertyName(property.name) === name,
  );
}

function typeormClassDisablesTransaction(owner) {
  if (!owner || !ts.isClassLike(owner)) return false;
  return owner.members.some(
    (member) =>
      ts.isPropertyDeclaration(member) &&
      propertyName(member.name) === 'transaction' &&
      isFalseLiteral(member.initializer),
  );
}

// `exports.config = { transaction: false }` or `export const config = { transaction: false }`.
function knexDisablesTransaction(sourceFile) {
  let disabled = false;
  const visit = (node) => {
    if (disabled) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isExportsMember(node.left, 'config')
    ) {
      disabled = isFalseLiteral(objectProperty(node.right, 'transaction')?.initializer);
    } else if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === 'config') {
      disabled = isFalseLiteral(objectProperty(node.initializer, 'transaction')?.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return disabled;
}

// MikroORM runs each migration in a transaction unless the class overrides `isTransactional()` to return false.
function mikroOrmClassDisablesTransaction(owner) {
  if (!owner || !ts.isClassLike(owner)) return false;
  return owner.members.some(
    (member) =>
      ts.isMethodDeclaration(member) &&
      propertyName(member.name) === 'isTransactional' &&
      (member.body?.statements ?? []).some(
        (statement) => ts.isReturnStatement(statement) && isFalseLiteral(statement.expression),
      ),
  );
}

function defaultTransaction(framework, owner, sourceFile) {
  if (framework === 'mikro-orm') return !mikroOrmClassDisablesTransaction(owner);
  if (framework === 'typeorm') return !typeormClassDisablesTransaction(owner);
  if (framework === 'knex') return !knexDisablesTransaction(sourceFile);
  return false;
}

// Finds a `const name = <initializer>` visible from `node` by walking enclosing blocks.
function findDeclaration(node, name) {
  // Binding the syntax tree honors lexical shadowing without building a TypeScript project.
  const source = node.getSourceFile();
  if (!source.locals) ts.bindSourceFile(source, {});
  const key = ts.escapeLeadingUnderscores(name);
  for (let scope = node.parent; scope; scope = scope.parent) {
    const local = scope.locals?.get(key);
    if (!local) continue;
    const binding = local.exportSymbol ?? local;
    if (!(binding.flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Alias))) continue;
    const declaration = binding.valueDeclaration;
    if (declaration && ts.isFunctionDeclaration(declaration)) return declaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const)
      return declaration.initializer;
    return;
  }
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression?.(current))
  ) {
    current = current.expression;
  }
  return current;
}

const EMPTY_BINDINGS = new Map();

// A helper parameter resolves to its call-site argument; any other name to its `const` declaration.
function resolveIdentifierSql(identifier, sourceFile, depth, bindings) {
  const bound = bindings.get(identifier.text);
  if (bound) return bound.node ? sqlFromExpression(bound.node, sourceFile, depth + 1, bound.bindings) : null;
  const declared = findDeclaration(identifier, identifier.text);
  return declared && !isFunctionLike(declared) ? sqlFromExpression(declared, sourceFile, depth + 1, bindings) : null;
}

// Builds SQL text plus segments mapping SQL offsets back to the file. Holes become placeholders.
function sqlFromExpression(node, sourceFile, depth = 0, bindings = EMPTY_BINDINGS) {
  const expression = unwrapExpression(node);
  const builder = { sql: '', segments: [], dynamic: false, holes: 0, literalText: '' };
  const appendLiteral = (cooked, raw, fileStart) => {
    builder.literalText += cooked;
    builder.segments.push({ sqlStart: builder.sql.length, length: cooked.length, fileStart, exact: cooked === raw });
    builder.sql += cooked;
  };
  const appendHole = (hole) => {
    const placeholder = DYNAMIC_PLACEHOLDER_PREFIX + builder.holes++;
    builder.segments.push({
      sqlStart: builder.sql.length,
      length: placeholder.length,
      fileStart: hole.getStart(sourceFile),
      exact: false,
    });
    builder.sql += placeholder;
    builder.dynamic = true;
  };
  // `${name}` naming a constant string (or a helper parameter given one) is spliced in, placed at the hole.
  const appendTemplateHole = (hole) => {
    const value = unwrapExpression(hole);
    const resolved =
      ts.isIdentifier(value) && depth < 3 ? resolveIdentifierSql(value, sourceFile, depth, bindings) : null;
    if (!resolved || resolved.dynamic) return appendHole(hole);
    builder.literalText += resolved.sql;
    builder.segments.push({
      sqlStart: builder.sql.length,
      length: resolved.sql.length,
      fileStart: hole.getStart(sourceFile),
      exact: false,
    });
    builder.sql += resolved.sql;
  };
  const append = (part) => {
    const value = unwrapExpression(part);
    if (ts.isStringLiteral(value)) {
      const start = value.getStart(sourceFile) + 1;
      appendLiteral(value.text, sourceFile.text.slice(start, value.end - 1), start);
    } else if (ts.isNoSubstitutionTemplateLiteral(value)) {
      appendLiteral(value.text, value.rawText ?? value.text, value.getStart(sourceFile) + 1);
    } else if (ts.isNumericLiteral(value)) {
      appendLiteral(value.text, value.getText(sourceFile), value.getStart(sourceFile));
    } else if (ts.isTemplateExpression(value)) {
      appendLiteral(value.head.text, value.head.rawText ?? value.head.text, value.head.getStart(sourceFile) + 1);
      for (const span of value.templateSpans) {
        appendTemplateHole(span.expression);
        appendLiteral(
          span.literal.text,
          span.literal.rawText ?? span.literal.text,
          span.literal.getStart(sourceFile) + 1,
        );
      }
    } else if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      append(value.left);
      append(value.right);
    } else if (ts.isIdentifier(value) && depth < 3) {
      const resolved = resolveIdentifierSql(value, sourceFile, depth, bindings);
      if (!resolved) appendHole(value);
      else {
        const offset = builder.sql.length;
        builder.segments.push(
          ...resolved.segments.map((segment) => ({ ...segment, sqlStart: segment.sqlStart + offset })),
        );
        builder.sql += resolved.sql;
        builder.dynamic ||= resolved.dynamic;
        builder.literalText += resolved.literalText;
      }
    } else appendHole(value);
  };
  append(expression);
  // A call whose text is entirely interpolated says nothing about its statement.
  return builder.literalText.trim() ? builder : null;
}

function offsetMapper(builder, sourceFile) {
  return (sqlOffset) => {
    let segment = builder.segments[0];
    for (const candidate of builder.segments) {
      if (candidate.sqlStart <= sqlOffset) segment = candidate;
      else break;
    }
    const fileOffset = segment.exact
      ? segment.fileStart + Math.min(sqlOffset - segment.sqlStart, segment.length)
      : segment.fileStart;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(fileOffset);
    return { line: line + 1, column: character + 1 };
  };
}

function positionOf(node, sourceFile) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function calleeParts(call) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  return { method: callee.name.text, receiver: callee.expression };
}

function receiverName(receiver, sourceFile) {
  return receiver.getText(sourceFile);
}

function stringArgument(node) {
  const value = unwrapExpression(node);
  if (!value) return null;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isObjectLiteralExpression(value)) {
    const tableName = objectProperty(value, 'tableName')?.initializer;
    return tableName ? stringArgument(tableName) : null;
  }
  return null;
}

function tableArgument(node) {
  const value = unwrapExpression(node);
  if (value && ts.isNewExpression(value))
    return stringArgument(objectProperty(value.arguments?.[0], 'name')?.initializer);
  return stringArgument(value);
}

function isInsideTransactionCallback(node, upFunction) {
  for (let current = node.parent; current && current !== upFunction; current = current.parent) {
    if (!isFunctionLike(current) || !ts.isCallExpression(current.parent)) continue;
    const parts = calleeParts(current.parent);
    if (parts?.method === 'transaction') return true;
  }
  return false;
}

// Parses a raw SQL default (TypeORM `default`, `Sequelize.literal`, `knex.raw`) into an expression node.
function parseDefaultSql(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const [statement] = pgParser.parseStatements('SELECT ' + text);
    return statement?.node?.SelectStmt?.targetList?.[0]?.ResTarget?.val ?? null;
  } catch {
    return null;
  }
}

function functionCallDefault(name) {
  return { FuncCall: { funcname: [{ String: { sval: name } }] } };
}

// Default described by a schema-builder value: { hasDefault, defaultExpression }.
function describeBuilderDefault(node, sourceFile, dialect) {
  const value = unwrapExpression(node);
  if (!value) return { hasDefault: false, defaultExpression: null };
  const text = value.getText(sourceFile);
  if (CLIENT_SIDE_DEFAULTS.test(text)) return { hasDefault: false, defaultExpression: null };
  if (ts.isCallExpression(value)) {
    const parts = calleeParts(value);
    const firstArgument = stringArgument(value.arguments[0]);
    if (parts && ['literal', 'raw'].includes(parts.method) && firstArgument !== null) {
      return { hasDefault: true, defaultExpression: dialect === 'postgres' ? parseDefaultSql(firstArgument) : null };
    }
    if (parts?.method === 'fn' && firstArgument)
      return { hasDefault: true, defaultExpression: functionCallDefault(firstArgument) };
    if (parts?.method === 'now') return { hasDefault: true, defaultExpression: functionCallDefault('now') };
    if (parts?.method === 'uuid')
      return { hasDefault: true, defaultExpression: functionCallDefault('gen_random_uuid') };
  }
  if (/\bNOW\b/.test(text) && ts.isPropertyAccessExpression(value)) {
    return { hasDefault: true, defaultExpression: functionCallDefault('now') };
  }
  return { hasDefault: true, defaultExpression: null };
}

function builderOperation(call, sourceFile, fields) {
  return { ...positionOf(call, sourceFile), sql: call.getText(sourceFile), builder: true, ...fields };
}

function typeormColumnFields(columnNode, sourceFile, dialect) {
  const column = unwrapExpression(columnNode);
  const options = column && ts.isNewExpression(column) ? column.arguments?.[0] : column;
  if (!options || !ts.isObjectLiteralExpression(options)) return { columnName: null, dynamicDefinition: true };
  const read = (name) => objectProperty(options, name)?.initializer;
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

function typeormBuilderOperations(call, method, sourceFile, dialect) {
  const [first, second, third] = call.arguments;
  const table = tableArgument(first);
  const make = (fields) => builderOperation(call, sourceFile, { table, ...fields });
  switch (method) {
    case 'createTable':
      return [make({ kind: 'create-table' })];
    case 'createIndex':
    case 'createIndices':
      return [make({ kind: 'create-index' })];
    case 'addColumn':
      return [make({ kind: 'add-column', ...typeormColumnFields(second, sourceFile, dialect) })];
    case 'addColumns': {
      const columns = ts.isArrayLiteralExpression(second ?? {}) ? second.elements : [];
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

function hasTrueProperty(argumentsList, name) {
  return argumentsList.some((argument) => {
    const property = objectProperty(unwrapExpression(argument), name);
    return property?.initializer.kind === ts.SyntaxKind.TrueKeyword;
  });
}

function sequelizeAttributeFields(attributesNode, sourceFile, dialect) {
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

function sequelizeBuilderOperations(call, method, sourceFile, dialect) {
  const [first, second, third] = call.arguments;
  const table = tableArgument(first);
  const make = (fields) => builderOperation(call, sourceFile, { table, ...fields });
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
      return [make({ kind: 'add-constraint', constraintType: SEQUELIZE_CONSTRAINT_TYPES[type] ?? 'other' })];
    }
    case 'bulkInsert':
    case 'bulkUpdate':
    case 'bulkDelete':
      return [make({ kind: 'data' })];
    default:
      return [];
  }
}

// Method chain of `t.string('c').notNullable().defaultTo(...)`, root call first.
function callChain(call) {
  const chain = [];
  let current = call;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    chain.unshift(current);
    current = current.expression.expression;
  }
  return { chain, root: current };
}

function knexColumnOperations(chain, table, sourceFile, dialect) {
  const [rootCall] = chain;
  const methods = chain.map((call) => call.expression.name.text);
  const rootMethod = methods[0];
  const make = (fields) => builderOperation(rootCall, sourceFile, { table, ...fields });
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
  const described = defaultCall
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

function knexAlterTableOperations(call, sourceFile, dialect) {
  const table = stringArgument(call.arguments[0]);
  const callback = call.arguments[1];
  if (!isFunctionLike(callback) || callback.parameters.length === 0) return [];
  const builderName = callback.parameters[0].name.getText(sourceFile);
  const operations = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && !ts.isPropertyAccessExpression(node.parent)) {
      const { chain, root } = callChain(node);
      if (chain.length > 0 && ts.isIdentifier(root) && root.text === builderName) {
        operations.push(...knexColumnOperations(chain, table, sourceFile, dialect));
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return operations;
}

function knexSchemaOperations(call, method, sourceFile, dialect) {
  const table = stringArgument(call.arguments[0]);
  const make = (fields) => builderOperation(call, sourceFile, { table, ...fields });
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

function isRawSqlCall(method, receiverText, { framework, firstParameter }) {
  if (framework === 'mikro-orm' && MIKRO_ORM_SQL_METHODS.has(method)) return receiverText === 'this';
  if (method === 'query') return QUERY_RECEIVER.test(receiverText) || receiverText === firstParameter;
  if (method === 'raw') return RAW_RECEIVER.test(receiverText) || receiverText === firstParameter;
  return false;
}

function rawSqlOperations(call, context) {
  const built = sqlFromExpression(call.arguments[0], context.sourceFile, 0, context.bindings);
  if (!built) return [];
  const { operations } = extractSqlText(built.sql, {
    dialect: context.dialect,
    file: context.file,
    mapOffset: offsetMapper(built, context.sourceFile),
  });
  return operations;
}

function builderOperations(call, method, receiverText, context) {
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

const MAX_HELPER_DEPTH = 3;

// `this.helper(...)` resolves to a method of the migration class; `helper(...)` to a function declared in the file.
function sameFileHelper(call, owner) {
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    const declared = findDeclaration(call, callee.text);
    return isFunctionLike(declared) ? declared : null;
  }
  if (!ts.isPropertyAccessExpression(callee) || callee.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
  if (!owner || !ts.isClassLike(owner)) return null;
  const name = callee.name.text;
  for (const member of owner.members) {
    if (propertyName(member.name) !== name) continue;
    if (ts.isMethodDeclaration(member)) return member;
    if (ts.isPropertyDeclaration(member) && isFunctionLike(member.initializer)) return member.initializer;
  }
  return null;
}

// Helper parameters bound to the call-site arguments, read in the caller's bindings.
function helperBindings(helper, call, bindings) {
  const bound = new Map();
  helper.parameters.forEach((parameter, index) => {
    if (ts.isIdentifier(parameter.name)) bound.set(parameter.name.text, { node: call.arguments[index], bindings });
  });
  return bound;
}

// The helper parameter that receives the migration's runner (`queryRunner`, `knex`, ...), if any.
function helperRunnerParameter(helper, call, context) {
  const index = call.arguments.findIndex(
    (argument) => unwrapExpression(argument).getText(context.sourceFile) === context.firstParameter,
  );
  return index === -1 ? context.firstParameter : helper.parameters[index]?.name.getText(context.sourceFile);
}

function helperCallOperations(call, context, scope) {
  if (scope.helpers.length > MAX_HELPER_DEPTH) return [];
  const helper = sameFileHelper(call, scope.owner);
  if (!helper?.body || scope.helpers.includes(helper)) return [];
  const helperContext = {
    ...context,
    firstParameter: helperRunnerParameter(helper, call, context),
    bindings: helperBindings(helper, call, context.bindings),
  };
  // Each operation is reported at the call, so every call (and its table) gets its own line.
  return functionOperations(helper, helperContext, { ...scope, helpers: [...scope.helpers, helper] }).map(
    (operation) => ({ ...operation, ...positionOf(call, context.sourceFile) }),
  );
}

function functionOperations(fn, context, scope) {
  const operations = [];
  const visit = (node) => {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const parts = calleeParts(node);
    if (parts) {
      const receiverText = receiverName(parts.receiver, context.sourceFile);
      const found = isRawSqlCall(parts.method, receiverText, context)
        ? rawSqlOperations(node, context)
        : builderOperations(node, parts.method, receiverText, context);
      if (found.length > 0) {
        // The receiver of a chained builder call (`schema.createTable(...).alterTable(...)`) runs first.
        // Arguments, including Knex alterTable callbacks, were already read with their call.
        visit(parts.receiver);
        const explicitTransaction = scope.explicitTransaction || isInsideTransactionCallback(node, fn);
        for (const fields of found) {
          operations.push(createOperation({ file: context.file, ...fields, explicitTransaction }));
        }
        return;
      }
    }
    const helperOperations = helperCallOperations(node, context, {
      ...scope,
      explicitTransaction: scope.explicitTransaction || isInsideTransactionCallback(node, fn),
    });
    if (helperOperations.length > 0) {
      ts.forEachChild(node, visit);
      operations.push(...helperOperations);
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return operations;
}

function upFunctionOperations(upFunction, owner, context) {
  const firstParameter = upFunction.parameters?.[0]?.name.getText(context.sourceFile);
  const unitContext = { ...context, firstParameter, bindings: EMPTY_BINDINGS };
  return functionOperations(upFunction, unitContext, { owner, helpers: [upFunction], explicitTransaction: false });
}

function extractCodeFile(text, { file, dialect }) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const framework = detectFramework(text);
  const context = { sourceFile, file, dialect, framework };
  const units = findUpFunctions(sourceFile).map(({ fn, owner }) => ({
    inTransaction: defaultTransaction(framework, owner, sourceFile),
    operations: upFunctionOperations(fn, owner, context),
  }));
  return { framework, units };
}

// Helper modules kept next to migrations (shared SQL, support utilities) define no `up` and are not migrations.
function definesUpFunction(text, file) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  return findUpFunctions(sourceFile).length > 0;
}

module.exports = { extractCodeFile, detectFramework, definesUpFunction };
