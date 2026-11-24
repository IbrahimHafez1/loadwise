import fs from 'node:fs';
import path from 'node:path';
import { ts, calleeCall, freshName, nameTaken, replaceNode } from './helpers.cjs';
import { insertedIdQuery, constDeclaration } from '../last-insert-id.cjs';
import type {
  Block,
  Expression,
  Identifier,
  Node,
  PropertyAccessExpression,
  SourceFile,
  VariableDeclaration,
} from 'typescript';
import type { FileTarget, FixResult, SiteFixInput, TextEdit } from '../../shared/types.cjs';
import type { InsertedIdSite } from '../last-insert-id.cjs';

// The shared helper's import edit, and the helper file to create when the project has none yet.
interface SharedHelper {
  edit: TextEdit;
  create: FileTarget | undefined;
}

// The generated key as read from the insert response: the result expression, and the edits that
// read it.
interface ExtractedId {
  result: Node;
  edits: TextEdit[];
  usesHelper?: boolean;
}

function firstElement(value: Node, optional = false): Node | undefined {
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
function usedElsewhere(block: Node, declaration: Identifier, use: Node): boolean | undefined {
  function visit(node: Node): boolean | undefined {
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

// The nearest folder up from the site that holds a `database` folder, within the package, is where
// the database code lives.
function databaseDirectory(sourceFile: SourceFile): string | undefined {
  for (let directory = path.dirname(sourceFile.fileName); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, databaseDirectoryName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    if (fs.existsSync(path.join(directory, 'package.json')) || path.dirname(directory) === directory) return;
  }
}

function importSpecifier(fromFile: string, helperFile: string): string {
  const relative = path.relative(path.dirname(fromFile), helperFile).replaceAll('\\', '/').replace(/\.ts$/, '');
  return relative.startsWith('.') ? relative : './' + relative;
}

function importEdit(sourceFile: SourceFile, text: string, specifier: string): TextEdit {
  const statement = `import { ${helperName} } from '${specifier}';`;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const lastImport = imports.at(-1);
  if (!lastImport) return { start: 0, end: 0, text: statement + newline + newline };
  return { start: lastImport.end, end: lastImport.end, text: newline + statement };
}

// One shared helper replaces the same lookup pasted into every service. An existing helper is
// reused as it is; a folder that cannot be found, a non-TypeScript file or a clashing name keeps
// the lookup inline instead.
function sharedHelper({
  sourceFile,
  text,
  file,
  load,
}: {
  sourceFile: SourceFile;
  text: string;
  file: string;
  load: SiteFixInput['load'];
}): SharedHelper | undefined {
  if (!/\.[cm]?ts$/.test(sourceFile.fileName) || nameTaken(sourceFile, helperName)) return;
  const directory = databaseDirectory(sourceFile);
  if (!directory) return;
  const helperFile = path.join(directory, helperFileName);
  const existing = load(helperFile);
  if (existing && !existing.text.includes('export async function ' + helperName + '(')) return;
  const reported = path.isAbsolute(file) ? helperFile : path.relative(process.cwd(), helperFile);
  return {
    edit: importEdit(sourceFile, text, importSpecifier(sourceFile.fileName, helperFile)),
    create: existing ? undefined : { file: reported, create: true, text: helperSource },
  };
}

// Replaces the declaration's initializer; a line too long to read puts each `??` operand on its own
// line.
function insertIdOrLookup(
  site: InsertedIdSite,
  initializer: Expression,
  result: Node,
  rowAccess = '',
): TextEdit | undefined {
  const declaredQuery = site.declaration.initializer;
  if (!declaredQuery) return;
  const text = initializer.getText();
  const start = result.getStart() - initializer.getStart();
  const query = '(' + declaredQuery.getText() + ')';
  const original = text.slice(0, start) + query + text.slice(start + result.getWidth());
  const fallback = rowAccess ? '(' + original + ')' + rowAccess : original;
  const insertId = result.getText() + '?.[0]?.insertId';
  const source = initializer.getSourceFile().text;
  const lineStart = source.lastIndexOf('\n', initializer.getStart()) + 1;
  const prefix = source.slice(lineStart, initializer.getStart());
  if (prefix.length + insertId.length + fallback.length + ' ?? ;'.length <= printWidth)
    return replaceNode(initializer, insertId + ' ?? ' + fallback);
  const indent = (/^\s*/.exec(prefix) ?? [''])[0] + '  ';
  return {
    start: source.lastIndexOf('=', initializer.getStart()) + 1,
    end: initializer.end,
    text: '\n' + indent + insertId + ' ??\n' + indent + fallback,
  };
}

// The insert response read directly, as `rows[0][0].alias`: the result expression, if it is one.
function directResult(value: Node, site: InsertedIdSite): Node | undefined {
  if (!ts.isPropertyAccessExpression(value) || ts.isOptionalChain(value) || value.name.text !== site.alias) return;
  const row = firstElement(value.expression);
  return row && firstElement(row);
}

function directIdRead(
  site: InsertedIdSite,
  initializer: Expression,
  result: Node,
  helper: SharedHelper | undefined,
): ExtractedId | undefined {
  const edit = helper
    ? replaceNode(initializer, `await ${helperName}(${result.getText()}, ${site.receiver.text})`)
    : insertIdOrLookup(site, initializer, result);
  if (!edit) return;
  return { result, edits: [edit], usesHelper: Boolean(helper) };
}

// The `extracted?.alias` read inside the `Number(... ?? ...)` conversion that follows the
// extraction.
function fallbackAccess(
  site: InsertedIdSite,
  block: Block,
  extractedName: Identifier,
): PropertyAccessExpression | undefined {
  const nextIndex = site.next ? block.statements.indexOf(site.next) : -1;
  const next = constDeclaration(block.statements[nextIndex + 1]);
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
    access.expression.text !== extractedName.text ||
    usedElsewhere(block, extractedName, access.expression)
  )
    return;
  return access;
}

// Keep a separate first-row binding and the caller's exact conversion/fallback.
function separateRowRead(
  site: InsertedIdSite,
  extracted: VariableDeclaration,
  initializer: Expression,
  block: Block,
): ExtractedId | undefined {
  const row = firstElement(ts.skipOuterExpressions(initializer), true);
  const result = row && firstElement(row);
  if (!result || extracted.type || !ts.isIdentifier(extracted.name)) return;
  const access = fallbackAccess(site, block, extracted.name);
  if (!access) return;
  const id = freshName(extracted.getSourceFile(), extracted.name.text + 'Id');
  if (!id) return;
  const lookupEdit = insertIdOrLookup(site, initializer, result, '?.' + site.alias);
  if (!lookupEdit) return;
  return { result, edits: [replaceNode(extracted.name, id), lookupEdit, replaceNode(access, id)] };
}

function extractedId(
  site: InsertedIdSite,
  extracted: VariableDeclaration,
  helper: SharedHelper | undefined,
): ExtractedId | undefined {
  const initializer = extracted.initializer;
  if (!initializer) return;
  const block = site.statement.parent;
  if (!ts.isBlock(block)) return;
  const direct = directResult(ts.skipOuterExpressions(initializer), site);
  if (direct) return directIdRead(site, initializer, direct, helper);
  return separateRowRead(site, extracted, initializer, block);
}

const reviewNote =
  'Check the generated key and its type with your mysql2 settings, including custom typeCast and big-number options. The original lookup runs only when the insert response supplies no ID.';

function insertResultFix({ node, text, sourceFile, finding, load }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined || !sourceFile || !finding.file) return;
  const call = calleeCall(node);
  if (!call) return;
  const site = insertedIdQuery(call);
  if (!site) return;
  const declarationName = site.declaration.name;
  if (!ts.isIdentifier(declarationName)) return;
  const extracted = constDeclaration(site.next);
  if (!extracted?.initializer) return;
  // Only the direct `.id` read maps onto the helper; a caller's own conversion or fallback stays
  // inline.
  const helper = site.alias === 'id' ? sharedHelper({ sourceFile, text, file: finding.file, load }) : undefined;
  const read = extractedId(site, extracted, helper);
  const result = read?.result;
  if (!read || !result || !ts.isIdentifier(result) || result.text !== declarationName.text) return;
  if (usedElsewhere(site.statement.parent, declarationName, result)) return;
  const leading = text.slice(site.insert.end, site.statement.getStart());
  // A sole description of the removed query is obsolete. Preserve all other comments and
  // directives.
  if (!/^\s*(?:\/\/\s*get the last inserted id using raw sql\.?[ \t]*(?:\r?\n)\s*)?$/i.test(leading)) return;
  if (/\/\/|\/\*/.test(site.statement.getText() + extracted.initializer.getText())) return;
  const edits: TextEdit[] = [
    { start: site.insert.getStart(), end: site.insert.getStart(), text: `const ${result.text} = ` },
    { start: site.insert.end, end: site.statement.end, text: '' },
    ...read.edits,
  ];
  if (read.usesHelper && helper) {
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

export default { 'drizzle-last-insert-id': insertResultFix };
