'use strict';

// Fixes for list queries that return more than the caller needs: a row cap on an unbounded list, and `omit` for the
// large Prisma columns the code provably never reads.
const path = require('node:path');
const { ts, addProperty, requireReview } = require('./helpers.cjs');

// The same cap the rule's page-size advice uses (`Math.min(limit, 100)`).
const pageSizeCap = 100;
const unboundedListMessage = /has no row limit/;
// Option keys of a TypeORM `find()`; a Mongoose filter would name document fields instead.
const typeormFindOptions = new Set([
  'where',
  'order',
  'relations',
  'select',
  'skip',
  'withDeleted',
  'cache',
  'lock',
  'loadEagerRelations',
  'relationLoadStrategy',
  'transaction',
  'comment',
]);
// Mongoose query steps; a TypeORM `find()` returns a plain Promise, which has none of them.
const mongooseQuerySteps = new Set(['sort', 'select', 'lean', 'populate', 'skip', 'exec']);
const capNote = `The list now returns at most the first ${pageSizeCap} rows. Add a stable order and paging parameters (or a cursor) so callers can read the rest, and check callers that expect every row.`;
// Prisma made `omit` generally available in 6.2.0; earlier clients reject it without the omitApi preview feature.
const minimumOmitVersion = [6, 2];
const wideColumnList = /loads large columns for every row \(((?:[\w$]+ \([\w[\]]+\)(?:, )?)+)\)/;

// The call whose method name is the reported identifier: `repo.find(...)` for the `find` of `repo.find`.
function reportedCall(node) {
  const access = node?.parent;
  if (!access || !ts.isPropertyAccessExpression(access) || access.name !== node) return;
  const call = access.parent;
  return ts.isCallExpression(call) && call.expression === access ? call : undefined;
}

function importsPackage(sourceFile, name) {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === name,
  );
}

function plainObject(node) {
  const literal = node && ts.skipOuterExpressions(node);
  if (!literal || !ts.isObjectLiteralExpression(literal) || literal.properties.some(ts.isSpreadAssignment)) return;
  return literal;
}

// `{ take: 100 }` as the only argument of a call that has none, or the property added to its options literal.
function optionEdit(call, property, text) {
  if (!call.arguments.length) return { start: call.arguments.pos, end: call.arguments.pos, text: `{ ${property} }` };
  const options = call.arguments.length === 1 && plainObject(call.arguments[0]);
  return options ? addProperty(options, property, text) : undefined;
}

function isTypeormFind(call, sourceFile) {
  if (!importsPackage(sourceFile, 'typeorm') || importsPackage(sourceFile, 'mongoose')) return false;
  if (!call.arguments.length) return true;
  const options = call.arguments.length === 1 && plainObject(call.arguments[0]);
  return !!options && options.properties.every((property) => typeormFindOptions.has(property.name?.getText()));
}

function isMongooseFind(call, sourceFile) {
  if (importsPackage(sourceFile, 'typeorm')) return false;
  const next = call.parent;
  const chained = ts.isPropertyAccessExpression(next) && mongooseQuerySteps.has(next.name.text);
  return chained || importsPackage(sourceFile, 'mongoose');
}

// The ORM is read from the method and the file: the rule reports Prisma, TypeORM, Sequelize and Mongoose lists alike.
function rowCapEdit(call, sourceFile, text) {
  const method = call.expression.name.text;
  if (method === 'findMany') return optionEdit(call, `take: ${pageSizeCap}`, text);
  if (method === 'findAll' || method === 'findAndCountAll') return optionEdit(call, `limit: ${pageSizeCap}`, text);
  if (method !== 'find') return;
  if (isTypeormFind(call, sourceFile)) return optionEdit(call, `take: ${pageSizeCap}`, text);
  // Mongoose applies limit after sort whatever the chain order, so the cap can follow find() directly.
  if (isMongooseFind(call, sourceFile)) return { start: call.end, end: call.end, text: `.limit(${pageSizeCap})` };
}

function unboundedListFix({ finding, node, sourceFile, text }) {
  if (!unboundedListMessage.test(finding.message)) return;
  const call = reportedCall(node);
  const edit = call && rowCapEdit(call, sourceFile, text);
  return edit && { edits: [edit] };
}

function versionAtLeast(version, [major, minor]) {
  const [found, foundMajor, foundMinor] = /^(\d+)\.(\d+)/.exec(version ?? '') ?? [];
  if (!found) return false;
  return Number(foundMajor) > major || (Number(foundMajor) === major && Number(foundMinor) >= minor);
}

// The @prisma/client the file resolves, found the way Node looks up node_modules from the file's folder.
function prismaClientVersion(fileName, load) {
  for (let folder = path.dirname(fileName); ; folder = path.dirname(folder)) {
    const manifest = load(path.join(folder, 'node_modules', '@prisma', 'client', 'package.json'));
    if (manifest) {
      try {
        return JSON.parse(manifest.text).version;
      } catch {
        return;
      }
    }
    if (path.dirname(folder) === folder) return;
  }
}

function unreadWideColumns(message) {
  const list = wideColumnList.exec(message)?.[1];
  return list?.split(', ').map((label) => label.split(' ')[0]);
}

// Only the large columns the rule proved unread are omitted; a finding that also names deep includes stays manual,
// since omitting columns would not resolve it.
function overfetchOmitFix({ finding, node, sourceFile, text, load }) {
  if (finding.contextualReason || /relation levels deep/.test(finding.message)) return;
  const columns = unreadWideColumns(finding.message);
  const call = reportedCall(node);
  if (!columns?.length || call?.expression.name.text !== 'findMany' || call.arguments.length !== 1) return;
  const options = plainObject(call.arguments[0]);
  if (!options || !versionAtLeast(prismaClientVersion(sourceFile.fileName, load), minimumOmitVersion)) return;
  const omitted = columns.map((column) => `${column}: true`).join(', ');
  return {
    edits: [addProperty(options, `omit: { ${omitted} }`, text)],
    note: `The rows no longer load ${columns.map((column) => `\`${column}\``).join(', ')}, which this function never reads.`,
  };
}

module.exports = {
  'unbounded-list-query': requireReview(capNote, unboundedListFix),
  'list-query-overfetch': overfetchOmitFix,
};
