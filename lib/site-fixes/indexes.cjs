'use strict';

// Index findings: insert the suggested index into the model or entity declaration the finding links to.
const { ts, insertLinesBefore, nameTaken, indentationAt, lineStart } = require('./helpers.cjs');

const prismaSuggestion = /^@@index\(\[[\w, ()":.]*\](?:, type: Gin)?\)$/;
const typeormEntitySuggestion = /^@Index\(\[(?:'\w+'(?:, )?)+\]\)$/;
const typeormPropertySuggestion = '@Index()';
const typeormPackage = 'typeorm';
const indexImportName = 'Index';
const dropNote = /Then drop [^.]*\./;

function declarationFile(finding) {
  return finding.related?.find((entry) => (entry.message ?? '').endsWith(' is declared here.'));
}

function noteFor(finding) {
  const drop = dropNote.exec(finding.message ?? '')?.[0];
  return drop ? { note: `${drop} (left untouched here)` } : {};
}

// Offset of the 1-based line/column inside the loaded file.
function offsetOf(entry, line, column) {
  const start = entry.lineStarts[line - 1];
  return start === undefined ? undefined : start + column - 1;
}

// --- Prisma ---------------------------------------------------------------

// Line index of the `}` that closes the block opened on `openingRow`, skipping braces in strings and comments.
function closingRowOf(lines, openingRow) {
  let depth = 0;
  for (let row = openingRow; row < lines.length; row++) {
    let quote = '';
    for (let column = 0; column < lines[row].length; column++) {
      const character = lines[row][column];
      if (quote) {
        if (character === '\\') column++;
        else if (character === quote) quote = '';
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '/' && lines[row][column + 1] === '/') break;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) return lines[row].slice(0, column).trim() === '' ? row : undefined;
    }
  }
}

function prismaFix(entry, declaration, finding) {
  const { suggestion } = finding;
  const modelName = /^Model `([^`]+)`/.exec(declaration.message)?.[1];
  if (!modelName || !prismaSuggestion.test(suggestion)) return;
  const lines = entry.text.split('\n').map((line) => line.replace(/\r$/, ''));
  const openingRow = declaration.line - 1;
  const opening = new RegExp(`^\\s*model\\s+${modelName}\\s*\\{`);
  if (!opening.test(lines[openingRow] ?? '')) return;
  const closingRow = closingRowOf(lines, openingRow);
  if (closingRow === undefined || closingRow <= openingRow) return;
  const body = lines.slice(openingRow + 1, closingRow);
  if (body.some((line) => line.trim() === suggestion)) return;
  const lastContent = body.findLast((line) => line.trim() !== '');
  if (lastContent === undefined) return;
  const indentation = /^[ \t]*/.exec(lastContent)[0];
  const eol = entry.text.includes('\r\n') ? '\r\n' : '\n';
  const start = entry.lineStarts[closingRow];
  return {
    targets: [{ file: declaration.file, edits: [{ start, end: start, text: indentation + suggestion + eol }] }],
    ...noteFor(finding),
  };
}

// --- TypeORM --------------------------------------------------------------

function decoratorName(decorator) {
  const expression = decorator.expression;
  const callee = ts.isCallExpression(expression) ? expression.expression : expression;
  return ts.isIdentifier(callee) ? callee.text : undefined;
}

function isFirstOnItsLine(text, node) {
  const start = node.getStart(node.getSourceFile());
  return text.slice(lineStart(text, start), start).trim() === '';
}

// Adds `Index` to an existing named `typeorm` import. Returns [] when already imported, undefined when impossible.
function indexImportEdits(sourceFile) {
  const imports = sourceFile.statements.filter(
    (statement) => ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === typeormPackage,
  );
  const named = imports
    .map((statement) => statement.importClause)
    .filter((clause) => clause && !clause.isTypeOnly && clause.namedBindings && ts.isNamedImports(clause.namedBindings))
    .map((clause) => clause.namedBindings);
  const imported = named.flatMap((bindings) => [...bindings.elements]);
  const existing = imported.find((element) => (element.propertyName ?? element.name).text === indexImportName);
  if (existing) return existing.isTypeOnly || existing.name.text !== indexImportName ? undefined : [];
  if (!named.length || nameTaken(sourceFile, indexImportName)) return;
  const bindings = named[0];
  const last = bindings.elements.at(-1);
  if (!last) return;
  const text = sourceFile.text;
  const multiline =
    sourceFile.getLineAndCharacterOfPosition(bindings.elements[0].getStart(sourceFile)).line !==
    sourceFile.getLineAndCharacterOfPosition(last.getStart(sourceFile)).line;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const insertion = multiline
    ? `,${eol}${indentationAt(text, last.getStart(sourceFile))}${indexImportName}`
    : `, ${indexImportName}`;
  return [{ start: last.end, end: last.end, text: insertion }];
}

function entityClassAt(sourceFile, offset) {
  let found;
  (function visit(node) {
    if (ts.isClassDeclaration(node) && node.name && node.name.getStart(sourceFile) === offset) found = node;
    else ts.forEachChild(node, visit);
  })(sourceFile);
  return found;
}

function isEntity(declaration) {
  return (ts.getDecorators(declaration) ?? []).some((decorator) => decoratorName(decorator) === 'Entity');
}

function buildTypeorm(entry, context) {
  const { klass, propertyName, suggestion } = context;
  if (!klass || !isEntity(klass)) return;
  let anchor;
  if (suggestion === typeormPropertySuggestion) {
    const property =
      context.property ??
      klass.members.find((member) => {
        return ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === propertyName;
      });
    if (!property || property.parent !== klass || property.name.text !== propertyName) return;
    const decorators = ts.getDecorators(property) ?? [];
    if (!decorators.length || decorators.some((decorator) => decoratorName(decorator) === indexImportName)) return;
    anchor = decorators[0];
  } else {
    anchor = ts.getDecorators(klass)?.[0];
  }
  if (!anchor || !isFirstOnItsLine(entry.text, anchor)) return;
  const importEdits = indexImportEdits(entry.sourceFile);
  if (!importEdits) return;
  return [insertLinesBefore(anchor, [suggestion]), ...importEdits];
}

function typeormFromDeclaration(entry, declaration, finding) {
  const { suggestion } = finding;
  if (suggestion !== typeormPropertySuggestion && !typeormEntitySuggestion.test(suggestion)) return;
  const propertyName = /the `([^`]+)` property of entity/.exec(finding.message ?? '')?.[1];
  if (suggestion === typeormPropertySuggestion && !propertyName) return;
  const offset = offsetOf(entry, declaration.line, declaration.column);
  const klass = offset === undefined || !entry.sourceFile ? undefined : entityClassAt(entry.sourceFile, offset);
  const edits = buildTypeorm(entry, { klass, propertyName, suggestion });
  return edits && { targets: [{ file: declaration.file, edits }], ...noteFor(finding) };
}

// The foreign key finding sits on the relation property itself and carries no declaration link.
function typeormFromProperty(entry, finding, node) {
  if (finding.suggestion !== typeormPropertySuggestion) return;
  const property = node.parent;
  if (!property || !ts.isPropertyDeclaration(property) || property.name !== node) return;
  const propertyName = /the `([^`]+)` property of entity/.exec(finding.message ?? '')?.[1];
  if (propertyName !== node.text || !ts.isClassDeclaration(property.parent)) return;
  const edits = buildTypeorm(entry, { klass: property.parent, property, propertyName, suggestion: finding.suggestion });
  return edits && { targets: [{ file: finding.file, edits }] };
}

// --- Dispatch -------------------------------------------------------------

function fixFromDeclaration({ finding, load }) {
  if (typeof finding.suggestion !== 'string') return;
  const declaration = declarationFile(finding);
  if (!declaration || typeof declaration.file !== 'string') return;
  const entry = load(declaration.file);
  if (!entry) return;
  if (declaration.file.endsWith('.prisma')) return prismaFix(entry, declaration, finding);
  return typeormFromDeclaration(entry, declaration, finding);
}

function fixForeignKey({ finding, node, load }) {
  if (typeof finding.suggestion !== 'string') return;
  const entry = load(finding.file);
  return entry && typeormFromProperty(entry, finding, node);
}

module.exports = {
  'index-missing-filter': fixFromDeclaration,
  'index-missing-order': fixFromDeclaration,
  'index-unusable-pattern': fixFromDeclaration,
  'index-unusable-expression': fixFromDeclaration,
  'index-missing-foreign-key': fixForeignKey,
};
