import fs from 'node:fs';
import path from 'node:path';
import { loadSyntax } from './compiler.cjs';
import { calleeName, relativeFile } from './schema/ts-helpers.cjs';
import { drizzleTableFromCall } from './schema/drizzle-schema.cjs';
import { typeormTable } from './schema/typeorm-schema.cjs';
import { sequelizeTableOf } from './schema/sequelize-schema.cjs';
import { loadPrismaSchema } from './schema/prisma-schema.cjs';
import {
  migrationDeclarations,
  projectDialect,
  projectRootOf,
  tableKey,
  tableSpelling,
} from './schema/project-indexes.cjs';
import type { CallExpression, ClassDeclaration, Node, SourceFile } from 'typescript';
import type { CheckerAdapter, Finding, ProgramAdapter, ReportDetails, RuleContext } from '../shared/types.cjs';
import type { LiveIndex } from './types/project-indexes.cjs';
import type { SchemaIndex, SchemaTable } from './types/schema-model.cjs';
const ts = loadSyntax();

const ruleId = 'index-redundant-prefix';
const drizzleTableBuilders = new Set(['pgTable', 'mysqlTable', 'table']);
const classTableDecorators = new Set(['Entity', 'ChildEntity', 'Table']);
// Tables already evaluated; a table is reached through several of its own calls and decorators.
const reportedTables = new WeakSet<SchemaTable>();
// Classes whose indexes entities inherit, already evaluated; each is reached through all of its
// decorators.
const reportedBaseClasses = new WeakSet<Node>();
// Per program: the redundant indexes entities inherit, grouped by the declaration they copy.
const inheritedByProgram = new WeakMap<ProgramAdapter, InheritedGroup[]>();
// How many inheriting entities a message names before it counts the rest.
const namedEntityLimit = 3;
const sequelizeRemovals: Record<string, string> = {
  indexes: "Remove its entry from the model's `indexes`",
  'unique: true': 'Remove `unique: true` from the column',
};

// One index key as the comparison reads it, whether it comes from a schema or from a migration.
interface ComparableKey {
  column?: string;
  spelling?: string;
  expression?: string;
  opclass?: string;
  direction?: string;
  ordering?: string;
  columns?: string[];
}

// An index as the comparison reads it, whether it comes from a schema, a decorator or a migration.
interface ComparableIndex {
  name?: string;
  keys: ComparableKey[];
  unique: boolean;
  primary?: boolean;
  method?: string;
  predicate?: string;
  /** Indexes from helpers whose key order is not read are never compared. */
  unreadable?: boolean;
  file?: string;
  line?: number;
  source?: string;
  constraint?: boolean;
  table?: string;
}

// An index that another one replaces, and the one that replaces it.
interface RedundantIndex<Index extends ComparableIndex> {
  index: Index;
  covering: Index;
}

// The table an index finding names; migration tables have no more than a spelled name.
interface TableLabel {
  name: string;
  dbName?: string;
  orm?: string;
}

// An index declared on a base class, with the entities that inherit it and those where another
// index replaces it.
interface InheritedGroup {
  file: string;
  line: number;
  inheritors: string[];
  found: (RedundantIndex<SchemaIndex> & { table: SchemaTable })[];
}

// An index of a base class, which names the file and line that declare it.
type InheritedIndex = SchemaIndex & { file: string; line: number };

interface SchemaIndexOptions {
  isChangedFile?: (filename: string) => boolean;
  dialect?: string;
}

// `spelling` only changes how a key is shown, never which index can stand in for another.
function keySignature({ column, direction, ...rest }: ComparableKey) {
  const extras = Object.entries(rest)
    .filter(([field, value]) => value !== undefined && field !== 'spelling')
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([column, direction === 'asc' ? undefined : direction, extras]);
}

// Only plain btree indexes over plain columns can be compared by their key lists: a partial index
// serves only queries implying its predicate, an expression key serves only that expression, and
// other methods answer different operators.
function isComparable(index: ComparableIndex): boolean {
  if (index.unreadable || index.predicate || (index.method ?? 'btree') !== 'btree') return false;
  return index.keys.length > 0 && index.keys.every((key) => key.column && !key.expression);
}

// A primary key is never dropped, and a unique index outranks a plain one that enforces nothing
// extra.
function keepRank(index: ComparableIndex) {
  if (index.primary) return 2;
  return index.unique ? 1 : 0;
}

function startsWithKeys(longer: ComparableIndex, shorter: ComparableIndex) {
  const longerSignatures = longer.keys.map(keySignature);
  return shorter.keys.map(keySignature).every((signature, position) => signature === longerSignatures[position]);
}

// Whether `covering` makes `index` unnecessary. A unique prefix enforces a constraint the longer
// index does not, so only an identical key list on an index that is unique too replaces it; of two
// identical ones the later goes.
function isCoveredBy(
  index: ComparableIndex,
  indexPosition: number,
  covering: ComparableIndex,
  coveringPosition: number,
): boolean {
  if (!isComparable(covering) || covering.keys.length < index.keys.length || !startsWithKeys(covering, index)) {
    return false;
  }
  if (covering.keys.length > index.keys.length) return !index.unique;
  const rankDifference = keepRank(covering) - keepRank(index);
  return rankDifference > 0 || (rankDifference === 0 && coveringPosition < indexPosition);
}

// [{ index, covering }] for each index in `indexes` that another one in the list replaces. The
// highest-ranked replacement is named, so a primary key wins over a unique index with the same
// keys.
function redundantIndexes<Index extends ComparableIndex>(indexes: readonly Index[]): RedundantIndex<Index>[] {
  const found: RedundantIndex<Index>[] = [];
  indexes.forEach((index, position) => {
    if (index.primary || !isComparable(index)) return;
    const coverings = indexes.filter(
      (candidate, candidatePosition) =>
        candidatePosition !== position && isCoveredBy(index, position, candidate, candidatePosition),
    );
    if (!coverings.length) return;
    const covering = coverings.reduce((best, candidate) => (keepRank(candidate) > keepRank(best) ? candidate : best));
    found.push({ index, covering });
  });
  return found;
}

function keyLabel(key: ComparableKey) {
  const column = key.spelling ?? key.column;
  return key.direction && key.direction !== 'asc' ? `${column} ${key.direction}` : column;
}

function keyList(index: ComparableIndex) {
  return `(${index.keys.map(keyLabel).join(', ')})`;
}

// A unique constraint and a unique index on the same keys are separate objects, removed
// differently.
function kindLabel(index: ComparableIndex) {
  if (index.primary) return 'the primary key';
  if (index.constraint) return 'unique constraint';
  return index.unique ? 'unique index' : 'index';
}

// `index \`name\` (a, b)`, plus the decorator or option that declares it, since one column can
// carry several.
function indexLabel(index: ComparableIndex) {
  const name = index.name ? ` \`${index.name}\`` : '';
  const source = index.source && index.source !== 'indexes' ? ` (\`${index.source}\`)` : '';
  return `${kindLabel(index)}${name} ${keyList(index)}${source}`;
}

function capitalized(text: string) {
  return text[0].toUpperCase() + text.slice(1);
}

function quoteIdentifier(identifier: string, quote: string) {
  return quote + identifier.replaceAll(quote, quote + quote) + quote;
}

function quoteTable(tableName: string, quote: string) {
  return tableName
    .split('.')
    .map((part) => quoteIdentifier(part, quote))
    .join('.');
}

// PostgreSQL drops a plain index CONCURRENTLY so writes to the table keep going; a constraint's
// index goes with its constraint. MySQL drops either kind through ALTER TABLE.
function dropSuggestion(index: ComparableIndex, tableName: string, dialect: string | undefined) {
  if (!index.name) return;
  const quote = dialect === 'mysql' ? '`' : '"';
  const name = quoteIdentifier(index.name, quote);
  if (dialect === 'mysql') return `ALTER TABLE ${quoteTable(tableName, quote)} DROP INDEX ${name};`;
  if (index.constraint) return `ALTER TABLE ${quoteTable(tableName, quote)} DROP CONSTRAINT ${name};`;
  return `DROP INDEX CONCURRENTLY ${name};`;
}

// `sequelize.sync({ alter: true })` adds every index the model declares, so dropping only the
// database index would not last.
function sequelizeAdvice(index: ComparableIndex) {
  const fallback = index.source ? `Remove the \`${index.source}\` decorator` : 'Remove it from the model';
  const removal = (index.source === undefined ? undefined : sequelizeRemovals[index.source]) ?? fallback;
  return `${removal} and drop it in a migration; \`sequelize.sync({ alter: true })\` recreates every index the model declares.`;
}

function findingParts(
  { index, covering }: RedundantIndex<ComparableIndex>,
  table: TableLabel,
  dialect: string | undefined,
): { message: string; details: ReportDetails } {
  const duplicate = index.keys.length === covering.keys.length;
  const relation = duplicate ? 'duplicates' : 'is a leading prefix of';
  const cost = duplicate
    ? 'so this one only adds write cost and memory.'
    : 'so it serves no lookup the longer index cannot and only adds write cost and memory.';
  const drop = duplicate ? 'Drop the duplicate.' : 'Drop the shorter index.';
  const advice = table.orm === 'sequelize' ? sequelizeAdvice(index) : drop;
  const subject = capitalized(indexLabel(index));
  const message = `${subject} on \`${table.name}\` ${relation} ${indexLabel(covering)}, ${cost} ${advice}`;
  const suggestion = dropSuggestion(index, table.dbName ?? table.name, dialect);
  // The fix's comment names the removed index and the one that replaces it.
  const labels = { redundantIndex: indexLabel(index), coveringIndex: indexLabel(covering) };
  return { message, details: { ...(suggestion ? { suggestion } : {}), ...labels } };
}

// The first node that starts on `line` inside `container`: the outermost one, so a decorator or a
// builder call rather than one of its arguments.
function nodeOnLine(container: Node, line: number): Node | undefined {
  const sourceFile = container.getSourceFile();
  const lineOf = (position: number) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  function visit(node: Node): Node | undefined {
    if (lineOf(node.getStart(sourceFile)) === line) return node;
    if (lineOf(node.getStart(sourceFile)) > line || lineOf(node.getEnd()) < line) return;
    return ts.forEachChild(node, visit);
  }
  return ts.forEachChild(container, visit);
}

// The table and the node that spans its declaration, for a call or class decorator that declares
// one.
function declaredTable(
  node: CallExpression,
  checker: CheckerAdapter,
): { table: SchemaTable; container: Node } | undefined {
  const name = calleeName(node);
  if (ts.isDecorator(node.parent)) {
    const declaration = node.parent.parent;
    if (!ts.isClassDeclaration(declaration) || name === undefined || !classTableDecorators.has(name)) return;
    const table =
      typeormTable(declaration, checker) ?? (declaration.name && sequelizeTableOf(declaration.name, checker));
    return table && { table, container: declaration };
  }
  if (name !== undefined && drizzleTableBuilders.has(name)) {
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

function sameFile(left: string, right: string) {
  return path.resolve(left) === path.resolve(right);
}

// The class a decorator call sits on, directly or through one of its members.
function decoratedClass(node: Node): ClassDeclaration | undefined {
  if (!ts.isDecorator(node.parent)) return;
  const target = node.parent.parent;
  if (ts.isClassDeclaration(target)) return target;
  return target.parent && ts.isClassDeclaration(target.parent) ? target.parent : undefined;
}

function entityClasses(sourceFile: SourceFile): ClassDeclaration[] {
  const normalized = sourceFile.fileName.replaceAll('\\', '/');
  if (sourceFile.isDeclarationFile || normalized.includes('/node_modules/') || !/@Entity\b/.test(sourceFile.text)) {
    return [];
  }
  return sourceFile.statements.filter(ts.isClassDeclaration);
}

function isInherited(index: SchemaIndex, entityFile: string): index is InheritedIndex {
  return !!index.file && index.line !== undefined && !sameFile(index.file, entityFile);
}

// Files the table's inherited indexes, and those another index makes redundant, under their
// declaring group.
function collectInheritedIndexes(
  table: SchemaTable,
  entityFile: string,
  groupOf: (index: InheritedIndex) => InheritedGroup,
) {
  for (const index of table.indexes) {
    if (isInherited(index, entityFile)) groupOf(index).inheritors.push(table.name);
  }
  for (const found of redundantIndexes(table.indexes)) {
    if (isInherited(found.index, entityFile)) groupOf(found.index).found.push({ ...found, table });
  }
}

// A base class's index is copied into every entity that extends it. Groups the copies by the
// declaration they come from, with the entities that inherit it and those where another index
// replaces it; only replaced ones are kept.
function inheritedIndexes(program: ProgramAdapter, checker: CheckerAdapter): InheritedGroup[] {
  const known = inheritedByProgram.get(program);
  if (known) return known;
  const groups = new Map<string, InheritedGroup>();
  const groupOf = (index: InheritedIndex): InheritedGroup => {
    const key = [path.resolve(index.file), index.line, index.name, JSON.stringify(index.keys)].join('\n');
    let group = groups.get(key);
    if (!group) {
      group = { file: index.file, line: index.line, inheritors: [], found: [] };
      groups.set(key, group);
    }
    return group;
  };
  // The TypeScript 7 program lists its project sources only through getToolingSourceFiles.
  for (const sourceFile of program.getToolingSourceFiles?.() ?? program.getSourceFiles?.() ?? []) {
    for (const declaration of entityClasses(sourceFile)) {
      const table = typeormTable(declaration, checker);
      if (!table) continue;
      collectInheritedIndexes(table, sourceFile.fileName, groupOf);
    }
  }
  const redundant = [...groups.values()].filter((group) => group.found.length);
  inheritedByProgram.set(program, redundant);
  return redundant;
}

function entityList(names: readonly string[]) {
  const quoted = names.slice(0, namedEntityLimit).map((name) => `\`${name}\``);
  const rest = names.length - quoted.length;
  return rest > 0 ? `${quoted.join(', ')} and ${rest} more` : quoted.join(', ');
}

function inheritedMessage({ inheritors, found }: InheritedGroup) {
  const label = capitalized(indexLabel(found[0].index));
  const everyEntity = found.length === inheritors.length;
  const scope = everyEntity
    ? 'every entity that inherits it'
    : `${found.length} of the ${inheritors.length} entities that inherit it`;
  const names = entityList(found.map(({ table }) => table.name));
  const advice = everyEntity ? 'Drop it from the base class.' : 'Declare it only on the entities that still need it.';
  return (
    `${label} declared in this base class is redundant on ${scope} (${names}): each has another index that starts ` +
    `with the same columns, so there it only adds write cost and memory. ${advice}`
  );
}

// Inherited indexes are reported once, at the base class that declares them, rather than in every
// entity.
function reportInheritedIndexes(declaration: ClassDeclaration, context: RuleContext) {
  if (reportedBaseClasses.has(declaration)) return;
  reportedBaseClasses.add(declaration);
  if (!context.program) return;
  const fileName = declaration.getSourceFile().fileName;
  for (const group of inheritedIndexes(context.program, context.checker)) {
    if (!sameFile(group.file, fileName)) continue;
    const target = nodeOnLine(declaration, group.line);
    if (target) context.report(target, ruleId, inheritedMessage(group));
  }
}

// Only Drizzle and Prisma tables carry a dialect; otherwise the project's SQL driver decides.
function tableDialect(table: SchemaTable, fileName: string): string | undefined {
  if (table.dialect) return table.dialect;
  const root = projectRootOf(fileName);
  return root && projectDialect(root);
}

// Drizzle `pgTable`, TypeORM `@Entity`, Sequelize `Model.init` / `define` / `@Table`: reports each
// replaced index at its declaration in the file being scanned.
function checkRedundantIndexes(node: CallExpression, context: RuleContext) {
  const decorated = decoratedClass(node);
  if (decorated) reportInheritedIndexes(decorated, context);
  const declared = declaredTable(node, context.checker);
  if (!declared || reportedTables.has(declared.table)) return;
  reportedTables.add(declared.table);
  const { table, container } = declared;
  const fileName = node.getSourceFile().fileName;
  for (const found of redundantIndexes(table.indexes)) {
    const { index } = found;
    if (index.line === undefined || (index.file && !sameFile(index.file, fileName))) continue;
    const target = nodeOnLine(container, index.line);
    if (!target) continue;
    const { message, details } = findingParts(found, table, tableDialect(table, fileName));
    context.report(target, ruleId, message, undefined, details);
  }
}

function prismaFindings(schema: ReturnType<typeof loadPrismaSchema>): Finding[] {
  const findings: Finding[] = [];
  for (const table of schema?.models.values() ?? []) {
    for (const found of redundantIndexes(table.indexes)) {
      if (!found.index.file || found.index.line === undefined) continue;
      const { message, details } = findingParts(found, table, table.dialect);
      findings.push({
        file: relativeFile(found.index.file),
        line: found.index.line,
        column: 1,
        ruleId,
        message,
        ...details,
      });
    }
  }
  return findings;
}

// A migration index as the comparison reads it, named as the database stores it. Indexes from
// helpers whose key order is not read are left out.
function migrationIndex(declaration: LiveIndex) {
  return {
    ...declaration,
    name: declaration.spelling,
    method: declaration.method ?? 'btree',
    predicate: declaration.partial ? 'partial' : undefined,
    unreadable: declaration.plainKeys === false,
  };
}

function lineAndColumn(text: string, offset: number) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

function groupByTable(declarations: readonly LiveIndex[], skippedTables: ReadonlySet<string>) {
  const groups = new Map<string, ReturnType<typeof migrationIndex>[]>();
  for (const declaration of declarations) {
    const table = tableKey(declaration.table);
    if (skippedTables.has(table)) continue;
    const key = `${declaration.directory}\n${table}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(migrationIndex(declaration));
  }
  return groups.values();
}

// `schemaTables` are reported at their schema.prisma declaration, so the migrations generated from
// it are skipped.
function migrationFindings(root: string, dialect: string | undefined, schemaTables: readonly string[]): Finding[] {
  const { indexes, opaqueTables } = migrationDeclarations(root);
  const texts = new Map<string, string>();
  const findings: Finding[] = [];
  for (const group of groupByTable(indexes, new Set([...opaqueTables, ...schemaTables]))) {
    for (const found of redundantIndexes(group)) {
      const { index } = found;
      let text = texts.get(index.file);
      if (text === undefined) {
        text = fs.readFileSync(index.file, 'utf8');
        texts.set(index.file, text);
      }
      const { message, details } = findingParts(found, { name: tableSpelling(index.table) }, dialect);
      findings.push({
        file: relativeFile(index.file),
        ...lineAndColumn(text, index.at),
        ruleId,
        message,
        ...details,
      });
    }
  }
  return findings;
}

// Schema-file findings that the source scan never visits: schema.prisma and SQL or code migrations.
// `isChangedFile` narrows them to changed files; `dialect` ('postgres' or 'mysql') shapes the DROP
// INDEX text.
function checkRedundantSchemaIndexes(root: string, { isChangedFile, dialect }: SchemaIndexOptions = {}): Finding[] {
  const schema = loadPrismaSchema(root);
  const schemaTables = [...(schema?.models.values() ?? [])].map((table) => tableKey(table.dbName));
  const findings = [...prismaFindings(schema), ...migrationFindings(root, dialect, schemaTables)];
  if (!isChangedFile) return findings;
  return findings.filter((finding) => finding.file !== undefined && isChangedFile(path.resolve(finding.file)));
}

export { checkRedundantIndexes, checkRedundantSchemaIndexes, redundantIndexes };
