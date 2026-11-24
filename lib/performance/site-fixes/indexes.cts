// Index findings: insert the suggested index into the model or entity declaration the finding links
// to.
import { ts, insertLinesBefore, nameTaken, indentationAt, lineStart } from './helpers.cjs';
import { drizzleIndex } from './drizzle-index.cjs';
import type {
  ClassDeclaration,
  Decorator,
  NamedImports,
  Node,
  ObjectLiteralExpression,
  PropertyAssignment,
  PropertyDeclaration,
  SourceFile,
} from 'typescript';
import type { Finding, FixResult, LoadedFile, SiteFixInput, TextEdit } from '../../shared/types.cjs';
import type { DeclarationLink } from '../types/declaration-link.cjs';

// A suggested index, minus the free-text columns it was cut down by.
interface FreeTextTrim {
  suggestion: string;
  dropped: string[];
}

// Where the TypeORM decorator goes: the entity, and the property whose decorators it joins (the
// entity's own without).
interface TypeormInsertion {
  klass: ClassDeclaration | undefined;
  property?: PropertyDeclaration;
  suggestion: string;
}

type MigrationOrm = 'prisma' | 'typeorm' | 'drizzle';

const prismaSuggestion = /^@@index\(\[[\w, ()":.]*\](?:, type: Gin)?, map: "\w+"\)$/;
const typeormEntitySuggestion = /^@Index\('\w+', \[(?:'\w+'(?:, )?)+\]\)$/;
const typeormPropertySuggestion = /^@Index\('\w+'\)$/;
const typeormNamedIndex = /^@Index\('(\w+)'/;
const migrationNotes: Record<MigrationOrm, string> = {
  prisma: 'run `npx prisma migrate dev`',
  typeorm: 'for example `npx typeorm migration:generate`',
  drizzle: 'run `npx drizzle-kit generate`',
};
const typeormPackage = 'typeorm';
const indexImportName = 'Index';
const dropNote = /Then drop [^.]*\./;

// Columns that hold free text or documents: a B-tree index on them is large and only serves
// whole-value matches, so they are left out of a suggested index (a trigram `type: Gin` index is
// kept as suggested).
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

function freeTextNote(dropped: readonly string[]): string {
  const names = dropped.map((name) => `\`${name}\``).join(', ');
  return `${names} ${dropped.length > 1 ? 'are' : 'is'} left out of the index: free-text columns make it large and only help exact whole-value matches.`;
}

function isDeclarationLink(value: unknown): value is DeclarationLink {
  return (
    typeof value === 'object' &&
    value !== null &&
    'file' in value &&
    typeof value.file === 'string' &&
    'line' in value &&
    typeof value.line === 'number' &&
    'column' in value &&
    typeof value.column === 'number' &&
    'message' in value &&
    typeof value.message === 'string'
  );
}

function declarationFile(finding: Finding): DeclarationLink | undefined {
  const related: readonly unknown[] = Array.isArray(finding.related) ? finding.related : [];
  return related.find(
    (entry): entry is DeclarationLink => isDeclarationLink(entry) && entry.message.endsWith(' is declared here.'),
  );
}

function noteFor(finding: Finding): { note?: string } {
  const drop = dropNote.exec(finding.message ?? '')?.[0];
  return drop ? { note: `${drop} (left untouched here)` } : {};
}

// Offset of the 1-based line/column inside the loaded file.
function offsetOf(entry: LoadedFile, line: number, column: number): number | undefined {
  const start = entry.lineStarts[line - 1];
  return start === undefined ? undefined : start + column - 1;
}

// --- Prisma ---------------------------------------------------------------

// Line index of the `}` that closes the block opened on `openingRow`, skipping braces in strings
// and comments.
function closingRowOf(lines: readonly string[], openingRow: number): number | undefined {
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

function prismaFix(entry: LoadedFile, declaration: DeclarationLink, finding: Finding): FixResult | undefined {
  const { suggestion } = finding;
  const modelName = /^Model `([^`]+)`/.exec(declaration.message)?.[1];
  if (!modelName || typeof suggestion !== 'string' || !prismaSuggestion.test(suggestion)) return;
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
  const indentation = (/^[ \t]*/.exec(lastContent) ?? [''])[0];
  const eol = entry.text.includes('\r\n') ? '\r\n' : '\n';
  const start = entry.lineStarts[closingRow];
  return {
    targets: [{ file: declaration.file, edits: [{ start, end: start, text: indentation + trimmed.suggestion + eol }] }],
    ...joinedNotes(trimmed.dropped.length ? freeTextNote(trimmed.dropped) : undefined, noteFor(finding).note),
  };
}

function isPrismaFreeText(body: readonly string[], fieldName: string): boolean {
  const field = body
    .map((line) => /^\s*(\w+)\s+(\w+)(\[\])?\??(.*)$/.exec(line.replace(/\/\/.*$/, '')))
    .find((match) => match?.[1] === fieldName);
  if (!field) return false;
  if (field[2] === 'Json' || field[2] === 'Bytes') return true;
  return field[2] === 'String' && (freeTextPrismaAttribute.test(field[4]) || freeTextNames.test(fieldName));
}

// The `@@index([...])` suggestion without free-text fields, or undefined when no field is left.
function withoutPrismaFreeText(suggestion: string, body: readonly string[]): FreeTextTrim | undefined {
  if (suggestion.includes('type: Gin')) return { suggestion, dropped: [] };
  const [, list, name] = /^@@index\(\[(.*)\], map: "(\w+)"\)$/.exec(suggestion) ?? [];
  if (list === undefined) return { suggestion, dropped: [] };
  const fields = list.split(/,\s*(?![^()]*\))/);
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const field of fields) {
    const name = /^\w+/.exec(field)?.[0];
    if (name && isPrismaFreeText(body, name)) dropped.push(name);
    else kept.push(field);
  }
  if (!dropped.length) return { suggestion, dropped };
  if (!kept.length) return;
  return { suggestion: `@@index([${kept.join(', ')}], map: "${name}")`, dropped };
}

// --- TypeORM --------------------------------------------------------------

function decoratorName(decorator: Decorator): string | undefined {
  const expression = decorator.expression;
  const callee = ts.isCallExpression(expression) ? expression.expression : expression;
  return ts.isIdentifier(callee) ? callee.text : undefined;
}

function isFirstOnItsLine(text: string, node: Node): boolean {
  const start = node.getStart(node.getSourceFile());
  return text.slice(lineStart(text, start), start).trim() === '';
}

// Adds `Index` to an existing named `typeorm` import. Returns [] when already imported, undefined
// when impossible.
function indexImportEdits(sourceFile: SourceFile): TextEdit[] | undefined {
  const named = sourceFile.statements.flatMap((statement): NamedImports[] => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    if (statement.moduleSpecifier.text !== typeormPackage) return [];
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    return clause && !clause.isTypeOnly && bindings && ts.isNamedImports(bindings) ? [bindings] : [];
  });
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
  // The empty edit keeps `} from 'typeorm'` in the hunk, so its original lines name the import they
  // change.
  const statementEnd = bindings.parent.parent.end;
  return [
    { start: last.end, end: last.end, text: insertion },
    { start: statementEnd, end: statementEnd, text: '' },
  ];
}

function entityClassAt(sourceFile: SourceFile, offset: number): ClassDeclaration | undefined {
  let found: ClassDeclaration | undefined;
  (function visit(node: Node): void {
    if (ts.isClassDeclaration(node) && node.name && node.name.getStart(sourceFile) === offset) found = node;
    else ts.forEachChild(node, visit);
  })(sourceFile);
  return found;
}

function isEntity(declaration: ClassDeclaration): boolean {
  return (ts.getDecorators(declaration) ?? []).some((decorator) => decoratorName(decorator) === 'Entity');
}

function propertyNamed(klass: ClassDeclaration, name: string): PropertyDeclaration | undefined {
  return klass.members.find(
    (member): member is PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name,
  );
}

// Inserts `suggestion` above the property's decorators, or above the entity's decorators without a
// property.
function buildTypeorm(entry: LoadedFile, { klass, property, suggestion }: TypeormInsertion): TextEdit[] | undefined {
  if (!klass || !isEntity(klass)) return;
  const sourceFile = entry.sourceFile;
  if (!sourceFile) return;
  let anchor: Decorator | undefined;
  // Empty edits stretch the hunk to the property name, so its original lines are unique in the file
  // (many properties share `@Column({ type: 'uuid' })`) and a second finding for the same column
  // reads as already applied.
  const anchors: TextEdit[] = [];
  if (property) {
    if (property.parent !== klass) return;
    const decorators = ts.getDecorators(property) ?? [];
    if (!decorators.length || decorators.some((decorator) => decoratorName(decorator) === indexImportName)) return;
    anchor = decorators[0];
    anchors.push({ start: property.name.end, end: property.name.end, text: '' });
  } else {
    const decorators = ts.getDecorators(klass) ?? [];
    const sameText = (decorator: Decorator) => decorator.getText(sourceFile).replaceAll('"', "'") === suggestion;
    if (decorators.some(sameText)) return;
    anchor = decorators[0];
  }
  if (!anchor || !isFirstOnItsLine(entry.text, anchor)) return;
  const importEdits = indexImportEdits(sourceFile);
  if (!importEdits) return;
  const insertion = insertLinesBefore(anchor, [suggestion]);
  if (entry.text.includes('\r\n')) insertion.text = insertion.text.replaceAll('\n', '\r\n');
  return [insertion, ...anchors, ...importEdits];
}

function extendsAClass(klass: ClassDeclaration): boolean {
  return (klass.heritageClauses ?? []).some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
}

// A column declared on a base class cannot take `@Index()` there without indexing every subclass's
// table, so it gets an entity-level index naming the inherited property instead.
function inheritedColumnFix(
  klass: ClassDeclaration,
  propertyName: string,
  indexName: string,
): { suggestion: string; note: string } | undefined {
  if (!extendsAClass(klass) || !/^\w+$/.test(propertyName)) return;
  return {
    suggestion: `@Index('${indexName}', ['${propertyName}'])`,
    note: `\`${propertyName}\` is declared on the base class, so the index is added to this entity only.`,
  };
}

function joinedNotes(...notes: (string | false | undefined)[]): { note?: string } {
  const text = notes.filter(Boolean).join(' ');
  return text ? { note: text } : {};
}

function stringOption(options: ObjectLiteralExpression | undefined, key: string): string | undefined {
  const option = options?.properties.find(
    (property): property is PropertyAssignment =>
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === key,
  );
  return option && (ts.isStringLiteralLike(option.initializer) || ts.isNumericLiteral(option.initializer))
    ? option.initializer.text
    : undefined;
}

// A `@Column` holding text, JSON or a string longer than a key, or a string property named like
// prose.
function isTypeormFreeText(property: PropertyDeclaration): boolean {
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

// The entity-level `@Index([...])` suggestion without free-text columns of this class, or undefined
// when none is left.
function withoutTypeormFreeText(suggestion: string, klass: ClassDeclaration): FreeTextTrim | undefined {
  const match = /^@Index\('(\w+)', \[(.*)\]\)$/.exec(suggestion);
  if (!match) return;
  const [, name, columnList] = match;
  const columns = [...columnList.matchAll(/'(\w+)'/g)].map((match) => match[1]);
  const dropped = columns.filter((name) => {
    const property = propertyNamed(klass, name);
    return property && isTypeormFreeText(property);
  });
  if (!dropped.length) return { suggestion, dropped };
  const kept = columns.filter((name) => !dropped.includes(name));
  if (!kept.length) return;
  return { suggestion: `@Index('${name}', [${kept.map((column) => `'${column}'`).join(', ')}])`, dropped };
}

function typeormFromDeclaration(
  entry: LoadedFile,
  declaration: DeclarationLink,
  finding: Finding,
): FixResult | undefined {
  if (typeof finding.suggestion !== 'string') return;
  let suggestion = finding.suggestion;
  const isPropertySuggestion = typeormPropertySuggestion.test(suggestion);
  if (!isPropertySuggestion && !typeormEntitySuggestion.test(suggestion)) return;
  const offset = offsetOf(entry, declaration.line, declaration.column);
  const klass = offset === undefined || !entry.sourceFile ? undefined : entityClassAt(entry.sourceFile, offset);
  if (!klass) return;
  const dropNote = noteFor(finding).note;
  let edits: TextEdit[] | undefined;
  let inheritedNote: string | undefined;
  let freeText: string | undefined;
  if (isPropertySuggestion) {
    const propertyName = /the `([^`]+)` property of entity/.exec(finding.message ?? '')?.[1];
    if (!propertyName) return;
    const property = propertyNamed(klass, propertyName);
    if (property && isTypeormFreeText(property)) return;
    if (property) edits = buildTypeorm(entry, { klass, property, suggestion });
    else {
      const indexName = typeormNamedIndex.exec(suggestion)?.[1];
      if (!indexName) return;
      const inherited = inheritedColumnFix(klass, propertyName, indexName);
      if (!inherited) return;
      edits = buildTypeorm(entry, { klass, suggestion: inherited.suggestion });
      inheritedNote = inherited.note;
    }
  } else {
    const trimmed = withoutTypeormFreeText(suggestion, klass);
    if (!trimmed) return;
    suggestion = trimmed.suggestion;
    freeText = trimmed.dropped.length ? freeTextNote(trimmed.dropped) : undefined;
    edits = buildTypeorm(entry, { klass, suggestion });
  }
  return edits && { targets: [{ file: declaration.file, edits }], ...joinedNotes(freeText, inheritedNote, dropNote) };
}

const relationDecorators = new Set(['ManyToOne', 'OneToOne']);

// The join column name a relation property writes: `@JoinColumn({ name })`, or TypeORM's default
// `<relation>Id`.
function joinColumnName(property: PropertyDeclaration): string | undefined {
  const decorators = ts.getDecorators(property) ?? [];
  const isRelation = decorators.some((decorator) => {
    const name = decoratorName(decorator);
    return name !== undefined && relationDecorators.has(name);
  });
  if (!isRelation) return;
  const joinColumn = decorators.find((decorator) => decoratorName(decorator) === 'JoinColumn');
  const defaultName = ts.isComputedPropertyName(property.name) ? undefined : `${property.name.text}Id`;
  if (!joinColumn || !ts.isCallExpression(joinColumn.expression)) return;
  const [options, ...rest] = joinColumn.expression.arguments;
  if (rest.length) return;
  if (!options) return defaultName;
  if (!ts.isObjectLiteralExpression(options)) return;
  const nameProperty = options.properties.find(
    (option): option is PropertyAssignment =>
      ts.isPropertyAssignment(option) && ts.isIdentifier(option.name) && option.name.text === 'name',
  );
  if (!nameProperty) return defaultName;
  return ts.isStringLiteralLike(nameProperty.initializer) ? nameProperty.initializer.text : undefined;
}

// The foreign key finding sits on the relation property and names the foreign key column: the
// relation itself, a separate column property next to it, or only the relation's join column.
function typeormFromProperty(entry: LoadedFile, finding: Finding, node: Node): FixResult | undefined {
  const { suggestion } = finding;
  if (typeof suggestion !== 'string' || !finding.file || !typeormPropertySuggestion.test(suggestion)) return;
  const relation = node.parent;
  if (!relation || !ts.isPropertyDeclaration(relation) || relation.name !== node) return;
  const klass = relation.parent;
  const propertyName = /the `([^`]+)` property of entity/.exec(finding.message ?? '')?.[1];
  if (!propertyName || !ts.isClassDeclaration(klass)) return;
  const relationName = ts.isComputedPropertyName(relation.name) ? undefined : relation.name.text;
  let property = propertyName === relationName ? relation : propertyNamed(klass, propertyName);
  let note: string | undefined;
  if (!property && joinColumnName(relation) === propertyName) {
    property = relation;
    note = `On a relation property \`@Index()\` indexes its join column \`${propertyName}\`.`;
  }
  if (!property) return;
  const edits = buildTypeorm(entry, { klass, property, suggestion });
  return edits && { targets: [{ file: finding.file, edits }], ...joinedNotes(note) };
}

// --- Dispatch -------------------------------------------------------------

// The fix edits the model or entity only, and a project whose schema comes from migrations needs
// one more step.
function withMigrationNote(fix: FixResult | undefined, orm: MigrationOrm): FixResult | undefined {
  if (!fix) return fix;
  const generate = migrationNotes[orm];
  const sentence =
    orm === 'prisma' || orm === 'drizzle'
      ? `Generate a migration for this index (${generate}).`
      : `Generate a migration for this index (${generate}) unless the schema is synchronized from the entities.`;
  return { ...fix, ...joinedNotes(fix.note, sentence) };
}

function fixFromDeclaration({ finding, load }: SiteFixInput): FixResult | undefined {
  if (typeof finding.suggestion !== 'string') return;
  const declaration = declarationFile(finding);
  if (!declaration || typeof declaration.file !== 'string') return;
  const entry = load(declaration.file);
  if (!entry) return;
  if (declaration.file.endsWith('.prisma')) return withMigrationNote(prismaFix(entry, declaration, finding), 'prisma');
  if (declaration.message.startsWith('Table `')) {
    return withMigrationNote(drizzleIndex(entry, declaration, finding), 'drizzle');
  }
  return withMigrationNote(typeormFromDeclaration(entry, declaration, finding), 'typeorm');
}

function fixForeignKey({ finding, node, load }: SiteFixInput): FixResult | undefined {
  if (typeof finding.suggestion !== 'string' || !finding.file) return;
  if (finding.file.endsWith('.prisma')) return fixFromDeclaration({ finding, load });
  const entry = load(finding.file);
  return withMigrationNote(entry && node ? typeormFromProperty(entry, finding, node) : undefined, 'typeorm');
}

export default {
  'index-missing-filter': fixFromDeclaration,
  'index-missing-order': fixFromDeclaration,
  'index-unusable-pattern': fixFromDeclaration,
  'index-unusable-expression': fixFromDeclaration,
  'index-missing-foreign-key': fixForeignKey,
};
