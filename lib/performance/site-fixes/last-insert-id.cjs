'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ts, calleeCall, freshName, nameTaken, replaceNode } = require('./helpers.cjs');
const { insertedIdQuery, constDeclaration } = require('../last-insert-id.cjs');

function firstElement(value, optional = false) {
  const element = ts.skipOuterExpressions(value);
  if (
    ts.isElementAccessExpression(element) &&
    Boolean(element.questionDotToken) === optional &&
    ts.isNumericLiteral(element.argumentExpression) &&
    element.argumentExpression.text === '0'
  )
    return ts.skipOuterExpressions(element.expression);
}

// Every reference has to be accounted for before changing the shape of a result or row.
function usedElsewhere(block, declaration, use) {
  function visit(node) {
    if (ts.isIdentifier(node)) return node.text === declaration.text && node !== declaration && node !== use;
    return ts.forEachChild(node, (child) => visit(child) || undefined);
  }
  return visit(block);
}

const printWidth = 120;

const helperName = 'readInsertedId';
const helperFileName = 'read-inserted-id.ts';
const databaseDirectoryName = 'database';
const helperSource = [
  "import { sql, type SQL } from 'drizzle-orm';",
  '',
  'type InsertResult = readonly [{ insertId?: number }, ...unknown[]] | undefined;',
  '',
  '// The mysql2 insert result carries the generated key. LAST_INSERT_ID() answers for the connection that ran the',
  '// insert, so call this inside the same transaction as the insert.',
  'export async function ' + helperName + '(',
  '  insertResult: InsertResult,',
  '  database: { execute(query: SQL): Promise<unknown> },',
  '): Promise<number> {',
  '  const insertId = insertResult?.[0]?.insertId;',
  '  if (insertId !== undefined) return insertId;',
  '  const [rows] = (await database.execute(sql`SELECT LAST_INSERT_ID() as id`)) as unknown as [Array<{ id: number }>];',
  '  return rows[0]!.id;',
  '}',
  '',
].join('\n');

// The nearest folder up from the site that holds a `database` folder, within the package, is where the database code lives.
function databaseDirectory(sourceFile) {
  for (let directory = path.dirname(sourceFile.fileName); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, databaseDirectoryName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    if (fs.existsSync(path.join(directory, 'package.json')) || path.dirname(directory) === directory) return;
  }
}

function importSpecifier(fromFile, helperFile) {
  const relative = path.relative(path.dirname(fromFile), helperFile).replace(/\\/g, '/').replace(/\.ts$/, '');
  return relative.startsWith('.') ? relative : './' + relative;
}

function importEdit(sourceFile, text, specifier) {
  const statement = `import { ${helperName} } from '${specifier}';`;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  if (!imports.length) return { start: 0, end: 0, text: statement + newline + newline };
  return { start: imports.at(-1).end, end: imports.at(-1).end, text: newline + statement };
}

// One shared helper replaces the same lookup pasted into every service. An existing helper is reused as it is; a
// folder that cannot be found, a non-TypeScript file or a clashing name keeps the lookup inline instead.
function sharedHelper({ sourceFile, text, finding, load }) {
  if (!/\.[cm]?ts$/.test(sourceFile.fileName) || nameTaken(sourceFile, helperName)) return;
  const directory = databaseDirectory(sourceFile);
  if (!directory) return;
  const helperFile = path.join(directory, helperFileName);
  const existing = load(helperFile);
  if (existing && !existing.text.includes('export async function ' + helperName + '(')) return;
  const reported = path.isAbsolute(finding.file) ? helperFile : path.relative(process.cwd(), helperFile);
  return {
    edit: importEdit(sourceFile, text, importSpecifier(sourceFile.fileName, helperFile)),
    create: existing ? undefined : { file: reported, create: true, text: helperSource },
  };
}

// Replaces the declaration's initializer; a line too long to read puts each `??` operand on its own line.
function insertIdOrLookup(site, initializer, result, rowAccess = '') {
  const text = initializer.getText();
  const start = result.getStart() - initializer.getStart();
  const query = '(' + site.declaration.initializer.getText() + ')';
  const original = text.slice(0, start) + query + text.slice(start + result.getWidth());
  const fallback = rowAccess ? '(' + original + ')' + rowAccess : original;
  const insertId = result.getText() + '?.[0]?.insertId';
  const source = initializer.getSourceFile().text;
  const lineStart = source.lastIndexOf('\n', initializer.getStart()) + 1;
  const prefix = source.slice(lineStart, initializer.getStart());
  if (prefix.length + insertId.length + fallback.length + ' ?? ;'.length <= printWidth)
    return replaceNode(initializer, insertId + ' ?? ' + fallback);
  const indent = /^\s*/.exec(prefix)[0] + '  ';
  return {
    start: source.lastIndexOf('=', initializer.getStart()) + 1,
    end: initializer.end,
    text: '\n' + indent + insertId + ' ??\n' + indent + fallback,
  };
}

function extractedId(site, extracted, helper) {
  const block = site.statement.parent;
  const value = ts.skipOuterExpressions(extracted.initializer);
  if (ts.isPropertyAccessExpression(value) && !ts.isOptionalChain(value) && value.name.text === site.alias) {
    const row = firstElement(value.expression);
    const result = row && firstElement(row);
    if (result) {
      const edit = helper
        ? replaceNode(extracted.initializer, `await ${helperName}(${result.getText()}, ${site.receiver.text})`)
        : insertIdOrLookup(site, extracted.initializer, result);
      return { result, edits: [edit], usesHelper: Boolean(helper) };
    }
  }
  // Keep a separate first-row binding and the caller's exact conversion/fallback.
  const row = firstElement(value, true);
  const result = row && firstElement(row);
  if (!result || extracted.type || !ts.isIdentifier(extracted.name)) return;
  const next = constDeclaration(block.statements[block.statements.indexOf(site.next) + 1]);
  const convert = next?.initializer;
  if (
    !convert ||
    !ts.isCallExpression(convert) ||
    convert.arguments.length !== 1 ||
    convert.expression.getText() !== 'Number'
  )
    return;
  const fallback = convert.arguments[0];
  if (!ts.isBinaryExpression(fallback) || fallback.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) return;
  const access = fallback.left;
  if (!ts.isPropertyAccessExpression(access) || !access.questionDotToken || access.name.text !== site.alias) return;
  if (
    !ts.isIdentifier(access.expression) ||
    access.expression.text !== extracted.name.text ||
    usedElsewhere(block, extracted.name, access.expression)
  )
    return;
  const id = freshName(extracted.getSourceFile(), extracted.name.text + 'Id');
  if (!id) return;
  return {
    result,
    edits: [
      replaceNode(extracted.name, id),
      insertIdOrLookup(site, extracted.initializer, result, '?.' + site.alias),
      replaceNode(access, id),
    ],
  };
}

const reviewNote =
  'Check the generated key and its type with your mysql2 settings, including custom typeCast and big-number options. The original lookup runs only when the insert response supplies no ID.';

function insertResultFix({ node, text, sourceFile, finding, load }) {
  const call = calleeCall(node);
  const site = call && insertedIdQuery(call);
  if (!site) return;
  const extracted = constDeclaration(site.next);
  if (!extracted?.initializer) return;
  // Only the direct `.id` read maps onto the helper; a caller's own conversion or fallback stays inline.
  const helper = site.alias === 'id' && sharedHelper({ sourceFile, text, finding, load });
  const read = extractedId(site, extracted, helper);
  const result = read?.result;
  if (!result || !ts.isIdentifier(result) || result.text !== site.declaration.name.text) return;
  if (usedElsewhere(site.statement.parent, site.declaration.name, result)) return;
  const leading = text.slice(site.insert.end, site.statement.getStart());
  // A sole description of the removed query is obsolete. Preserve all other comments and directives.
  if (!/^\s*(?:\/\/\s*get the last inserted id using raw sql\.?[ \t]*(?:\r?\n)\s*)?$/i.test(leading)) return;
  if (/\/\/|\/\*/.test(site.statement.getText() + extracted.initializer.getText())) return;
  const edits = [
    { start: site.insert.getStart(), end: site.insert.getStart(), text: `const ${result.text} = ` },
    { start: site.insert.end, end: site.statement.end, text: '' },
    ...read.edits,
  ];
  if (read.usesHelper) {
    return {
      targets: [{ file: finding.file, edits: [...edits, helper.edit] }, ...(helper.create ? [helper.create] : [])],
      requiresReview: true,
      // Every site in a file adds the same import, so it has to stay a separate, shareable hunk.
      separateEdits: true,
      note: `Reads the generated key through ${helperName}, one shared helper next to the database code (${helperFileName}), with the LAST_INSERT_ID() fallback in the same transaction. Remove the sql import here if nothing else uses it. ${reviewNote}`,
    };
  }
  return {
    edits,
    requiresReview: true,
    note: reviewNote,
  };
}

module.exports = { 'drizzle-last-insert-id': insertResultFix };
