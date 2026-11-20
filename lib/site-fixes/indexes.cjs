'use strict';

// Index findings: insert the suggested index into the model or entity declaration the finding links to.
const { ts, insertLinesBefore, nameTaken, indentationAt, lineStart } = require('./helpers.cjs');

const prismaSuggestion = /^@@index\(\[[\w, ()":.]*\](?:, type: Gin)?\)$/;
const typeormEntitySuggestion = /^@Index\(\[(?:'\w+'(?:, )?)+\]\)$/;
const typeormPropertySuggestion = '@Index()';
const typeormPackage = 'typeorm';
const indexImportName = 'Index';
const dropNote = /Then drop [^.]*\./;

// Columns that hold free text or documents: a B-tree index on them is large and only serves whole-value matches, so
// they are left out of a suggested index (a trigram `type: Gin` index is kept as suggested).
const freeTextColumnTypes = new Set([
  'text',
  'mediumtext',
  'longtext',
  'json',
  'jsonb',
  'simple-json',
  'simple-array',
  'bytea',
  'blob',
  'longblob',
  'xml',
]);
const freeTextPrismaAttribute = /@db\.(?:Text|MediumText|LongText|Xml)\b/;
const freeTextNames = /^(?:description|comments?|body|content|bio|summary|notes|details|remarks)$/i;
// Strings longer than this are prose rather than keys.
const maxKeyLength = 255;

function freeTextNote(dropped) {
  const names = dropped.map((name) => `\`${name}\``).join(', ');
  return `${names} ${dropped.length > 1 ? 'are' : 'is'} left out of the index: free-text columns make it large and only help exact whole-value matches.`;
}

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
  const trimmed = withoutPrismaFreeText(suggestion, body);
  if (!trimmed || body.some((line) => line.trim() === trimmed.suggestion)) return;
  const lastContent = body.findLast((line) => line.trim() !== '');
  if (lastContent === undefined) return;
  const indentation = /^[ \t]*/.exec(lastContent)[0];
  const eol = entry.text.includes('\r\n') ? '\r\n' : '\n';
  const start = entry.lineStarts[closingRow];
  return {
    targets: [{ file: declaration.file, edits: [{ start, end: start, text: indentation + trimmed.suggestion + eol }] }],
    ...joinedNotes(trimmed.dropped.length && freeTextNote(trimmed.dropped), noteFor(finding).note),
  };
}

function isPrismaFreeText(body, fieldName) {
  const field = body
    .map((line) => /^\s*(\w+)\s+(\w+)(\[\])?\??(.*)$/.exec(line.replace(/\/\/.*$/, '')))
    .find((match) => match?.[1] === fieldName);
  if (!field) return false;
  if (field[2] === 'Json' || field[2] === 'Bytes') return true;
  return field[2] === 'String' && (freeTextPrismaAttribute.test(field[4]) || freeTextNames.test(fieldName));
}

// The `@@index([...])` suggestion without free-text fields, or undefined when no field is left.
function withoutPrismaFreeText(suggestion, body) {
  if (/type: Gin\)$/.test(suggestion)) return { suggestion, dropped: [] };
  const list = /^@@index\(\[(.*)\]\)$/.exec(suggestion)?.[1];
  if (list === undefined) return { suggestion, dropped: [] };
  const fields = list.split(/,\s*(?![^()]*\))/);
  const dropped = fields.map((field) => /^\w+/.exec(field)?.[0]).filter((name) => name && isPrismaFreeText(body, name));
  if (!dropped.length) return { suggestion, dropped };
  const kept = fields.filter((field) => !dropped.includes(/^\w+/.exec(field)?.[0]));
  if (!kept.length) return;
  return { suggestion: `@@index([${kept.join(', ')}])`, dropped };
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
  // The empty edit keeps `} from 'typeorm'` in the hunk, so its original lines name the import they change.
  const statementEnd = bindings.parent.parent.end;
  return [
    { start: last.end, end: last.end, text: insertion },
    { start: statementEnd, end: statementEnd, text: '' },
  ];
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

function propertyNamed(klass, name) {
  return klass.members.find(
    (member) => ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name,
  );
}

// Inserts `suggestion` above the property's decorators, or above the entity's decorators without a property.
function buildTypeorm(entry, { klass, property, suggestion }) {
  if (!klass || !isEntity(klass)) return;
  let anchor;
  // Empty edits stretch the hunk to the property name, so its original lines are unique in the file (many
  // properties share `@Column({ type: 'uuid' })`) and a second finding for the same column reads as already applied.
  const anchors = [];
  if (property) {
    if (property.parent !== klass) return;
    const decorators = ts.getDecorators(property) ?? [];
    if (!decorators.length || decorators.some((decorator) => decoratorName(decorator) === indexImportName)) return;
    anchor = decorators[0];
    anchors.push({ start: property.name.end, end: property.name.end, text: '' });
  } else {
    const decorators = ts.getDecorators(klass) ?? [];
    const sameText = (decorator) => decorator.getText(entry.sourceFile).replace(/"/g, "'") === suggestion;
    if (decorators.some(sameText)) return;
    anchor = decorators[0];
  }
  if (!anchor || !isFirstOnItsLine(entry.text, anchor)) return;
  const importEdits = indexImportEdits(entry.sourceFile);
  if (!importEdits) return;
  const insertion = insertLinesBefore(anchor, [suggestion]);
  if (entry.text.includes('\r\n')) insertion.text = insertion.text.replace(/\n/g, '\r\n');
  return [insertion, ...anchors, ...importEdits];
}

function extendsAClass(klass) {
  return (klass.heritageClauses ?? []).some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
}

// A column declared on a base class cannot take `@Index()` there without indexing every subclass's table, so it
// gets an entity-level index naming the inherited property instead.
function inheritedColumnFix(klass, propertyName) {
  if (!extendsAClass(klass) || !/^\w+$/.test(propertyName)) return;
  return {
    suggestion: `@Index(['${propertyName}'])`,
    note: `\`${propertyName}\` is declared on the base class, so the index is added to this entity only.`,
  };
}

function joinedNotes(...notes) {
  const text = notes.filter(Boolean).join(' ');
  return text ? { note: text } : {};
}

function stringOption(options, key) {
  const option = options?.properties.find(
    (property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === key,
  );
  return option && (ts.isStringLiteralLike(option.initializer) || ts.isNumericLiteral(option.initializer))
    ? option.initializer.text
    : undefined;
}

// A `@Column` holding text, JSON or a string longer than a key, or a string property named like prose.
function isTypeormFreeText(property) {
  const column = (ts.getDecorators(property) ?? []).find((decorator) => decoratorName(decorator) === 'Column');
  if (!column) return false;
  const args = ts.isCallExpression(column.expression) ? [...column.expression.arguments] : [];
  const options = args.find(ts.isObjectLiteralExpression);
  const type = (
    args[0] && ts.isStringLiteralLike(args[0]) ? args[0].text : stringOption(options, 'type')
  )?.toLowerCase();
  if (type && freeTextColumnTypes.has(type)) return true;
  if (Number(stringOption(options, 'length')) > maxKeyLength) return true;
  const isString = type ? /char|text/.test(type) : /\bstring\b/.test(property.type?.getText() ?? '');
  return isString && ts.isIdentifier(property.name) && freeTextNames.test(property.name.text);
}

// The entity-level `@Index([...])` suggestion without free-text columns of this class, or undefined when none is left.
function withoutTypeormFreeText(suggestion, klass) {
  const columns = [...suggestion.matchAll(/'(\w+)'/g)].map((match) => match[1]);
  const dropped = columns.filter((name) => {
    const property = propertyNamed(klass, name);
    return property && isTypeormFreeText(property);
  });
  if (!dropped.length) return { suggestion, dropped };
  const kept = columns.filter((name) => !dropped.includes(name));
  if (!kept.length) return;
  return { suggestion: `@Index([${kept.map((name) => `'${name}'`).join(', ')}])`, dropped };
}

function typeormFromDeclaration(entry, declaration, finding) {
  let { suggestion } = finding;
  if (suggestion !== typeormPropertySuggestion && !typeormEntitySuggestion.test(suggestion)) return;
  const offset = offsetOf(entry, declaration.line, declaration.column);
  const klass = offset === undefined || !entry.sourceFile ? undefined : entityClassAt(entry.sourceFile, offset);
  if (!klass) return;
  const dropNote = noteFor(finding).note;
  let edits;
  let inheritedNote;
  let freeText;
  if (suggestion === typeormPropertySuggestion) {
    const propertyName = /the `([^`]+)` property of entity/.exec(finding.message ?? '')?.[1];
    if (!propertyName) return;
    const property = propertyNamed(klass, propertyName);
    if (property && isTypeormFreeText(property)) return;
    if (property) edits = buildTypeorm(entry, { klass, property, suggestion });
    else {
      const inherited = inheritedColumnFix(klass, propertyName);
      if (!inherited) return;
      edits = buildTypeorm(entry, { klass, suggestion: inherited.suggestion });
      inheritedNote = inherited.note;
    }
  } else {
    const trimmed = withoutTypeormFreeText(suggestion, klass);
    if (!trimmed) return;
    suggestion = trimmed.suggestion;
    freeText = trimmed.dropped.length && freeTextNote(trimmed.dropped);
    edits = buildTypeorm(entry, { klass, suggestion });
  }
  return edits && { targets: [{ file: declaration.file, edits }], ...joinedNotes(freeText, inheritedNote, dropNote) };
}

const relationDecorators = new Set(['ManyToOne', 'OneToOne']);

// The join column name a relation property writes: `@JoinColumn({ name })`, or TypeORM's default `<relation>Id`.
function joinColumnName(property) {
  const decorators = ts.getDecorators(property) ?? [];
  if (!decorators.some((decorator) => relationDecorators.has(decoratorName(decorator)))) return;
  const joinColumn = decorators.find((decorator) => decoratorName(decorator) === 'JoinColumn');
  if (!joinColumn || !ts.isCallExpression(joinColumn.expression)) return;
  const [options, ...rest] = joinColumn.expression.arguments;
  if (rest.length) return;
  if (!options) return property.name.text + 'Id';
  if (!ts.isObjectLiteralExpression(options)) return;
  const nameProperty = options.properties.find(
    (option) => ts.isPropertyAssignment(option) && ts.isIdentifier(option.name) && option.name.text === 'name',
  );
  if (!nameProperty) return property.name.text + 'Id';
  return ts.isStringLiteralLike(nameProperty.initializer) ? nameProperty.initializer.text : undefined;
}

// The foreign key finding sits on the relation property and names the foreign key column: the relation itself,
// a separate column property next to it, or only the relation's join column.
function typeormFromProperty(entry, finding, node) {
  const { suggestion } = finding;
  if (suggestion !== typeormPropertySuggestion) return;
  const relation = node.parent;
  if (!relation || !ts.isPropertyDeclaration(relation) || relation.name !== node) return;
  const klass = relation.parent;
  const propertyName = /the `([^`]+)` property of entity/.exec(finding.message ?? '')?.[1];
  if (!propertyName || !ts.isClassDeclaration(klass)) return;
  let property = propertyName === node.text ? relation : propertyNamed(klass, propertyName);
  let note;
  if (!property && joinColumnName(relation) === propertyName) {
    property = relation;
    note = `On a relation property \`@Index()\` indexes its join column \`${propertyName}\`.`;
  }
  if (!property) return;
  const edits = buildTypeorm(entry, { klass, property, suggestion });
  return edits && { targets: [{ file: finding.file, edits }], ...joinedNotes(note) };
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
