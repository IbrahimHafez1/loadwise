import fs from 'node:fs';
import path from 'node:path';
import { ts, indentationAt, lineStart } from './helpers.cjs';
import type { Expression, ObjectLiteralExpression, PropertyAssignment, SourceFile } from 'typescript';
import type { Finding, FixResult, LoadedFile } from '../../shared/types.cjs';
import type { DeclarationLink } from '../types/declaration-link.cjs';

const mysqlCore = 'drizzle-orm/mysql-core';
const plainIndex = /^index\('([a-zA-Z_][\w]{0,63})'\)\.on\((table\.\w+(?:, table\.\w+)*)\)$/;
const scalarTypes = new Set(['int', 'bigint', 'smallint', 'tinyint', 'date', 'datetime', 'timestamp', 'varchar']);
const maxVarcharLength = 255;

function coreImports(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== mysqlCore) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!clause || !bindings || clause.isTypeOnly || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if (!binding.isTypeOnly && !binding.propertyName) names.add(binding.name.text);
    }
  }
  return names;
}

function indexableColumn(columns: ObjectLiteralExpression, name: string, imports: ReadonlySet<string>): boolean {
  const column = columns.properties.find(
    (property): property is PropertyAssignment =>
      ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && property.name.text === name,
  );
  let builder: Expression | undefined = column?.initializer;
  while (builder && ts.isCallExpression(builder) && ts.isPropertyAccessExpression(builder.expression)) {
    builder = builder.expression.expression;
  }
  if (!builder || !ts.isCallExpression(builder) || !ts.isIdentifier(builder.expression)) return false;
  const type = builder.expression.text;
  if (!imports.has(type) || !scalarTypes.has(type)) return false;
  if (type !== 'varchar') return true;
  const options = builder.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options) || options.properties.length !== 1) return false;
  const [length] = options.properties;
  return (
    ts.isPropertyAssignment(length) &&
    !ts.isComputedPropertyName(length.name) &&
    length.name.text === 'length' &&
    ts.isNumericLiteral(length.initializer) &&
    Number(length.initializer.text) > 0 &&
    Number(length.initializer.text) <= maxVarcharLength
  );
}

function canAppendIndex(
  elements: readonly Expression[],
  parameter: string,
  name: string,
  keys: readonly string[],
): boolean {
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
    return !keys.every((key, index) => {
      const argument = entry.arguments[index];
      return argument !== undefined && ts.isPropertyAccessExpression(argument) && argument.name.text === key;
    });
  });
}

function drizzleIndex(entry: LoadedFile, declaration: DeclarationLink, finding: Finding): FixResult | undefined {
  const suggestionText = finding.suggestion;
  if (typeof suggestionText !== 'string') return;
  const suggestion = plainIndex.exec(suggestionText);
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
    !parameter ||
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
  const indentation = indentationAt(entry.text, elements[elements.length - 1].getStart(source));
  const eol = entry.text.includes('\r\n') ? '\r\n' : '\n';
  const text = indentation + suggestionText.replaceAll('table.', () => parameter.text + '.') + ',' + eol;
  const notes = [
    'Confirm the query plan, existing database indexes, and write cost before generating a migration. This edit only adds the non-unique index declaration.',
    ...redundantIndexes(elements, keys).map(
      (redundant) =>
        `The new index starts with \`${keys[0]}\`, so \`${redundant}\` becomes redundant; drop it in the same migration once the plan confirms.`,
    ),
  ];
  if (entry.absolute && !drizzleKitMigrations(path.dirname(entry.absolute))) {
    notes.push(migrationNote(path.dirname(entry.absolute), finding.message));
  }
  return {
    targets: [{ file: declaration.file, edits: [{ start, end: start, text }] }],
    requiresReview: true,
    note: notes.join(' '),
  };
}

const sqlMigrationFolder = /^migrations?$/i;
const skippedFolders = new Set(['node_modules', 'dist', 'build', 'coverage']);
// Migration folders sit close to the package root; deeper trees are vendored code or build output.
const maxMigrationDepth = 4;
const databaseStatement = /build it with `([^`]+)`/;

// The nearest folder under the package root named `migrations` that holds .sql files, as a
// root-relative path.
function sqlMigrationsFolder(directory: string): string | undefined {
  let packageRoot = directory;
  while (!fs.existsSync(path.join(packageRoot, 'package.json')) && path.dirname(packageRoot) !== packageRoot) {
    packageRoot = path.dirname(packageRoot);
  }
  function search(current: string, depth: number): string | undefined {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    if (sqlMigrationFolder.test(path.basename(current)) && entries.some((entry) => entry.name.endsWith('.sql'))) {
      return current;
    }
    if (depth === maxMigrationDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || skippedFolders.has(entry.name)) continue;
      const found = search(path.join(current, entry.name), depth + 1);
      if (found) return found;
    }
  }
  const found = search(packageRoot, 0);
  return found && path.relative(packageRoot, found).replaceAll(path.sep, '/');
}

// Without drizzle-kit the schema file is not what creates indexes: the database only gets what a
// migration runs.
function migrationNote(directory: string, findingMessage: string): string {
  const folder = sqlMigrationsFolder(directory);
  if (!folder) {
    return 'This project has no drizzle-kit migrations folder, so write the migration that creates this index by hand.';
  }
  const statement = databaseStatement.exec(findingMessage ?? '')?.[1];
  const creation = statement ? ` with \`${statement}\`` : '';
  return (
    `This project applies hand-written SQL migrations (${folder}), so no index is created until a new migration ` +
    `there creates it${creation}; follow the folder's numbering and naming.`
  );
}

// Plain single-column indexes on the new composite index's leading column, which that index already
// serves.
function redundantIndexes(elements: readonly Expression[], keys: readonly string[]): string[] {
  if (keys.length < 2) return [];
  return elements.flatMap((entry) => {
    if (!ts.isCallExpression(entry) || !ts.isPropertyAccessExpression(entry.expression)) return [];
    const builder = entry.expression.expression;
    if (!ts.isCallExpression(builder) || !ts.isIdentifier(builder.expression)) return [];
    const [argument] = entry.arguments;
    const [indexName] = builder.arguments;
    const isSingleKeyIndex =
      builder.expression.text === 'index' &&
      entry.arguments.length === 1 &&
      ts.isPropertyAccessExpression(argument) &&
      argument.name.text === keys[0];
    return isSingleKeyIndex && indexName && ts.isStringLiteral(indexName) ? [indexName.text] : [];
  });
}

const drizzleConfigNames = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.cjs'];

// Whether drizzle-kit has a migrations folder to generate into: the `out` of the nearest
// drizzle-kit config up to the package root, `./drizzle` by default. A runtime file that is only
// named drizzle.config is skipped. Unknown (true) outside a package.
function drizzleKitMigrations(directory: string): boolean {
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

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export { drizzleIndex };
