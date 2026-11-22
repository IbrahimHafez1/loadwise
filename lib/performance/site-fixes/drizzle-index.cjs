'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ts, indentationAt, lineStart } = require('./helpers.cjs');

const mysqlCore = 'drizzle-orm/mysql-core';
const plainIndex = /^index\('([a-zA-Z_][\w]{0,63})'\)\.on\((table\.\w+(?:, table\.\w+)*)\)$/;
const scalarTypes = new Set(['int', 'bigint', 'smallint', 'tinyint', 'date', 'datetime', 'timestamp', 'varchar']);
const maxVarcharLength = 255;

function coreImports(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== mysqlCore) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || statement.importClause.isTypeOnly || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if (!binding.isTypeOnly && !binding.propertyName) names.add(binding.name.text);
    }
  }
  return names;
}

function indexableColumn(columns, name, imports) {
  const column = columns.properties.find(
    (property) => ts.isPropertyAssignment(property) && property.name.text === name,
  );
  let builder = column?.initializer;
  while (builder && ts.isCallExpression(builder) && ts.isPropertyAccessExpression(builder.expression)) {
    builder = builder.expression.expression;
  }
  if (!builder || !ts.isCallExpression(builder) || !ts.isIdentifier(builder.expression)) return false;
  const type = builder.expression.text;
  if (!imports.has(type) || !scalarTypes.has(type)) return false;
  if (type !== 'varchar') return true;
  const options = builder.arguments[1];
  const length =
    options &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.length === 1 &&
    options.properties[0].name?.text === 'length' &&
    options.properties[0];
  return (
    length &&
    ts.isPropertyAssignment(length) &&
    ts.isNumericLiteral(length.initializer) &&
    Number(length.initializer.text) > 0 &&
    Number(length.initializer.text) <= maxVarcharLength
  );
}

function canAppendIndex(elements, parameter, name, keys) {
  return elements.every((entry) => {
    if (
      !ts.isCallExpression(entry) ||
      !ts.isPropertyAccessExpression(entry.expression) ||
      entry.expression.name.text !== 'on'
    )
      return false;
    const builder = entry.expression.expression;
    if (
      !ts.isCallExpression(builder) ||
      !ts.isIdentifier(builder.expression) ||
      !['index', 'uniqueIndex'].includes(builder.expression.text)
    )
      return false;
    const indexName = builder.arguments[0];
    if (!indexName || !ts.isStringLiteral(indexName) || indexName.text.toLowerCase() === name.toLowerCase())
      return false;
    if (
      !entry.arguments.every(
        (key) =>
          ts.isPropertyAccessExpression(key) && ts.isIdentifier(key.expression) && key.expression.text === parameter,
      )
    )
      return false;
    return !keys.every((key, index) => entry.arguments[index]?.name.text === key);
  });
}

function drizzleIndex(entry, declaration, finding) {
  const suggestion = plainIndex.exec(finding.suggestion);
  const tableName = /^Table `([\w]+)` is declared here\.$/.exec(declaration.message)?.[1];
  const source = entry.sourceFile;
  if (!suggestion || !tableName || !source) return;
  const offset = entry.lineStarts[declaration.line - 1] + declaration.column - 1;
  const imports = coreImports(source);
  if (!imports.has('mysqlTable') || !imports.has('index')) return;
  const call = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .map((variable) => variable.initializer)
    .find((initializer) => initializer && initializer.getStart(source) === offset);
  if (
    !call ||
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== 'mysqlTable' ||
    call.arguments.length !== 3
  )
    return;
  const [name, columns, extras] = call.arguments;
  if (
    !ts.isStringLiteral(name) ||
    name.text !== tableName ||
    !ts.isObjectLiteralExpression(columns) ||
    !ts.isArrowFunction(extras)
  )
    return;
  const parameter = extras.parameters[0]?.name;
  if (
    extras.parameters.length !== 1 ||
    !ts.isIdentifier(parameter) ||
    parameter.text === 'index' ||
    !ts.isArrayLiteralExpression(extras.body)
  )
    return;
  const [, indexName, keyList] = suggestion;
  const keys = keyList.split(', ').map((key) => key.slice('table.'.length));
  // At most two bounded varchar keys also fit the modern InnoDB key budget with utf8mb4.
  if (keys.length > 2 || !keys.every((key) => indexableColumn(columns, key, imports))) return;
  const elements = extras.body.elements;
  if (!elements.length || !elements.hasTrailingComma || !canAppendIndex(elements, parameter.text, indexName, keys))
    return;
  const close = extras.body.end - 1;
  const start = lineStart(entry.text, close);
  if (entry.text.slice(start, close).trim() !== '') return;
  const indentation = indentationAt(entry.text, elements.at(-1).getStart(source));
  const eol = entry.text.includes('\r\n') ? '\r\n' : '\n';
  const text = indentation + finding.suggestion.replaceAll('table.', () => parameter.text + '.') + ',' + eol;
  const notes = [
    'Confirm the query plan, existing database indexes, and write cost before generating a migration. This edit only adds the non-unique index declaration.',
    ...redundantIndexes(elements, keys).map(
      (redundant) =>
        `The new index starts with \`${keys[0]}\`, so \`${redundant}\` becomes redundant; drop it in the same migration once the plan confirms.`,
    ),
  ];
  if (entry.absolute && !drizzleKitMigrations(path.dirname(entry.absolute)))
    notes.push(
      'This project has no drizzle-kit migrations folder, so write the migration that creates this index by hand.',
    );
  return {
    targets: [{ file: declaration.file, edits: [{ start, end: start, text }] }],
    requiresReview: true,
    note: notes.join(' '),
  };
}

// Plain single-column indexes on the new composite index's leading column, which that index already serves.
function redundantIndexes(elements, keys) {
  if (keys.length < 2) return [];
  return elements
    .filter((entry) => {
      const builder = entry.expression.expression;
      return (
        builder.expression.text === 'index' && entry.arguments.length === 1 && entry.arguments[0].name.text === keys[0]
      );
    })
    .map((entry) => entry.expression.expression.arguments[0].text);
}

const drizzleConfigNames = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.cjs'];

// Whether drizzle-kit has a migrations folder to generate into: the `out` of the nearest drizzle-kit config up to
// the package root, `./drizzle` by default. A runtime file that is only named drizzle.config is skipped. Unknown
// (true) outside a package.
function drizzleKitMigrations(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    for (const name of drizzleConfigNames) {
      const config = readText(path.join(current, name));
      if (!/drizzle-kit|\bdialect\s*:/.test(config)) continue;
      const out = /\bout\s*:\s*(['"`])([^'"`]+)\1/.exec(config)?.[2] ?? './drizzle';
      return fs.existsSync(path.resolve(current, out));
    }
    if (fs.existsSync(path.join(current, 'package.json'))) return false;
    if (path.dirname(current) === current) return true;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

module.exports = { drizzleIndex };
