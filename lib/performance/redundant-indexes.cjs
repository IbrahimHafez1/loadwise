'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { syntax: ts } = require('./compiler.cjs');
const { calleeName, relativeFile } = require('./schema/ts-helpers.cjs');
const { drizzleTableFromCall } = require('./schema/drizzle-schema.cjs');
const { typeormTable } = require('./schema/typeorm-schema.cjs');
const { sequelizeTableOf } = require('./schema/sequelize-schema.cjs');
const { loadPrismaSchema } = require('./schema/prisma-schema.cjs');
const { migrationDeclarations, tableKey } = require('./schema/project-indexes.cjs');

const ruleId = 'index-redundant-prefix';
const drizzleTableBuilders = new Set(['pgTable', 'mysqlTable', 'table']);
const classTableDecorators = new Set(['Entity', 'ChildEntity', 'Table']);
// Tables already evaluated; a table is reached through several of its own calls and decorators.
const reportedTables = new WeakSet();

function keySignature({ column, direction, ...rest }) {
  const extras = Object.entries(rest)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([column, direction === 'asc' ? undefined : direction, extras]);
}

// Only plain btree indexes over plain columns can be compared by their key lists: a partial index serves only
// queries implying its predicate, an expression key serves only that expression, and other methods answer
// different operators.
function isComparable(index) {
  if (index.unreadable || index.predicate || (index.method ?? 'btree') !== 'btree') return false;
  return index.keys.length > 0 && index.keys.every((key) => key.column && !key.expression);
}

// A primary key is never dropped, and a unique index outranks a plain one that enforces nothing extra.
function keepRank(index) {
  if (index.primary) return 2;
  return index.unique ? 1 : 0;
}

function startsWithKeys(longer, shorter) {
  const longerSignatures = longer.keys.map(keySignature);
  return shorter.keys.map(keySignature).every((signature, position) => signature === longerSignatures[position]);
}

// Whether `covering` makes `index` unnecessary. A unique prefix enforces a constraint the longer index does not,
// so only an identical key list on an index that is unique too replaces it; of two identical ones the later goes.
function isCoveredBy(index, indexPosition, covering, coveringPosition) {
  if (!isComparable(covering) || covering.keys.length < index.keys.length || !startsWithKeys(covering, index)) {
    return false;
  }
  if (covering.keys.length > index.keys.length) return !index.unique;
  const rankDifference = keepRank(covering) - keepRank(index);
  return rankDifference > 0 || (rankDifference === 0 && coveringPosition < indexPosition);
}

// [{ index, covering }] for each index in `indexes` that another one in the list replaces.
function redundantIndexes(indexes) {
  const found = [];
  indexes.forEach((index, position) => {
    if (index.primary || !isComparable(index)) return;
    const coveringPosition = indexes.findIndex(
      (candidate, candidatePosition) =>
        candidatePosition !== position && isCoveredBy(index, position, candidate, candidatePosition),
    );
    if (coveringPosition >= 0) found.push({ index, covering: indexes[coveringPosition] });
  });
  return found;
}

function keyLabel(key) {
  return key.direction && key.direction !== 'asc' ? `${key.column} ${key.direction}` : key.column;
}

function keyList(index) {
  return `(${index.keys.map(keyLabel).join(', ')})`;
}

function indexLabel(index) {
  return index.name ? `\`${index.name}\` ${keyList(index)}` : keyList(index);
}

function dropSuggestion(index, tableName, dialect) {
  if (!index.name) return;
  return dialect === 'mysql' ? `DROP INDEX ${index.name} ON ${tableName};` : `DROP INDEX ${index.name};`;
}

function findingParts({ index, covering }, table) {
  const duplicate = index.keys.length === covering.keys.length;
  const relation = duplicate ? 'duplicates' : 'is a leading prefix of';
  const advice = duplicate
    ? 'so this one only adds write cost and memory. Drop the duplicate.'
    : 'so it serves no lookup the longer index cannot and only adds write cost and memory. Drop the shorter index.';
  const message = `Index ${indexLabel(index)} on \`${table.name}\` ${relation} index ${indexLabel(covering)}, ${advice}`;
  return { message, suggestion: dropSuggestion(index, table.name, table.dialect) };
}

// The first node that starts on `line` inside `container`: the outermost one, so a decorator or a builder call
// rather than one of its arguments.
function nodeOnLine(container, line) {
  const sourceFile = container.getSourceFile();
  const lineOf = (position) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  function visit(node) {
    if (lineOf(node.getStart(sourceFile)) === line) return node;
    if (lineOf(node.getStart(sourceFile)) > line || lineOf(node.getEnd()) < line) return;
    return ts.forEachChild(node, visit);
  }
  return ts.forEachChild(container, visit);
}

// The table and the node that spans its declaration, for a call or class decorator that declares one.
function declaredTable(node, checker) {
  if (ts.isDecorator(node.parent)) {
    const declaration = node.parent.parent;
    if (!ts.isClassDeclaration(declaration) || !classTableDecorators.has(calleeName(node))) return;
    const table =
      typeormTable(declaration, checker) ?? (declaration.name && sequelizeTableOf(declaration.name, checker));
    return table && { table, container: declaration };
  }
  const name = calleeName(node);
  if (drizzleTableBuilders.has(name)) {
    const table = drizzleTableFromCall(node, checker);
    return table && { table, container: node };
  }
  if (name === 'init' && ts.isPropertyAccessExpression(node.expression)) {
    const table = sequelizeTableOf(node.expression.expression, checker);
    return table && { table, container: node };
  }
  if (name === 'define' && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    const table = sequelizeTableOf(node.parent.name, checker);
    return table && { table, container: node };
  }
}

function sameFile(left, right) {
  return path.resolve(left) === path.resolve(right);
}

// Drizzle `pgTable`, TypeORM `@Entity`, Sequelize `Model.init` / `define` / `@Table`: reports each replaced
// index at its declaration in the file being scanned.
function checkRedundantIndexes(node, context) {
  if (!ts.isCallExpression(node)) return;
  const declared = declaredTable(node, context.checker);
  if (!declared || reportedTables.has(declared.table)) return;
  reportedTables.add(declared.table);
  const { table, container } = declared;
  for (const found of redundantIndexes(table.indexes)) {
    const { index } = found;
    if (index.line === undefined || (index.file && !sameFile(index.file, node.getSourceFile().fileName))) continue;
    const target = nodeOnLine(container, index.line);
    if (!target) continue;
    const { message, suggestion } = findingParts(found, table);
    context.report(target, ruleId, message, undefined, suggestion ? { suggestion } : undefined);
  }
}

function prismaFindings(root) {
  const schema = loadPrismaSchema(root);
  const findings = [];
  for (const table of schema?.models.values() ?? []) {
    for (const found of redundantIndexes(table.indexes)) {
      if (!found.index.file || found.index.line === undefined) continue;
      const { message, suggestion } = findingParts(found, table);
      findings.push({
        file: relativeFile(found.index.file),
        line: found.index.line,
        column: 1,
        ruleId,
        message,
        ...(suggestion && { suggestion }),
      });
    }
  }
  return findings;
}

// A migration index as the comparison reads it. Indexes from helpers whose key order is not read are left out.
function migrationIndex(declaration) {
  return {
    ...declaration,
    method: declaration.method ?? 'btree',
    predicate: declaration.partial ? 'partial' : undefined,
    unreadable: declaration.plainKeys === false,
  };
}

function lineAndColumn(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

function groupByTable(declarations, opaqueTables) {
  const groups = new Map();
  for (const declaration of declarations) {
    const table = tableKey(declaration.table);
    if (opaqueTables.has(table)) continue;
    const key = `${declaration.directory}\n${table}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(migrationIndex(declaration));
  }
  return groups.values();
}

function migrationFindings(root, dialect) {
  const { indexes, opaqueTables } = migrationDeclarations(root);
  const texts = new Map();
  const findings = [];
  for (const group of groupByTable(indexes, opaqueTables)) {
    for (const found of redundantIndexes(group)) {
      const { index } = found;
      if (!texts.has(index.file)) texts.set(index.file, fs.readFileSync(index.file, 'utf8'));
      const { message, suggestion } = findingParts(found, { name: tableKey(index.table), dialect });
      findings.push({
        file: relativeFile(index.file),
        ...lineAndColumn(texts.get(index.file), index.at),
        ruleId,
        message,
        ...(suggestion && { suggestion }),
      });
    }
  }
  return findings;
}

// Schema-file findings that the source scan never visits: schema.prisma and SQL or code migrations.
// `isChangedFile` narrows them to changed files; `dialect` ('postgres' or 'mysql') shapes the DROP INDEX text.
function checkRedundantSchemaIndexes(root, { isChangedFile, dialect } = {}) {
  const findings = [...prismaFindings(root), ...migrationFindings(root, dialect)];
  if (!isChangedFile) return findings;
  return findings.filter((finding) => isChangedFile(path.resolve(finding.file)));
}

module.exports = { checkRedundantIndexes, checkRedundantSchemaIndexes, redundantIndexes };
