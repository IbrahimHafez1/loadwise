// loadwise-reviewed large-module -- one pipeline for the helper-called-per-item rule: callee analysis, read and write batch siblings, call-site rewrite and import edits all share the same ReadBatch/WriteBatch shapes
// service-query-in-loop: the query sits in a project helper called once per item. When the helper
// is a single keyed read or a single insert, a batch sibling is added next to it and the loop calls
// that once; a loop that only awaits the helper otherwise runs its calls a few at a time.
import { innermostNodeAt } from '../../shared/fix-hunks.cjs';
import path from 'node:path';
import { ts, calleeCall, freshName, indentationAt, isPlainReference, nameTaken, textOf } from './helpers.cjs';
import { isMethodCall } from './method-calls.cjs';
import type {
  AwaitExpression,
  BindingName,
  Block,
  CallExpression,
  ClassElement,
  Expression,
  ForOfStatement,
  FunctionDeclaration,
  Identifier,
  MethodDeclaration,
  Node,
  ObjectLiteralExpression,
  ParameterDeclaration,
  PropertyAssignment,
  PropertyName,
  ShorthandPropertyAssignment,
  SourceFile,
  Statement,
  SyntaxKind,
  TypeNode,
} from 'typescript';
import type { MethodCall } from '../types/method-call.cjs';
import type { RelatedLocation } from '../types/related-location.cjs';
import type { FileTarget, Finding, FixResult, LoadedFile, SiteFixInput, TextEdit } from '../../shared/types.cjs';

type ClientFamily = 'typeorm' | 'prisma';

/**
 * A helper whose body holds the per-item query: a method or function with a name and a block body.
 */
type HelperFunction = (MethodDeclaration | FunctionDeclaration) & { name: PropertyName | Identifier; body: Block };

/** An object literal property whose name is known: `name: value` or the shorthand `name`. */
type PlainProperty = PropertyAssignment | ShorthandPropertyAssignment;

/** A declaration beside the helper: a class member or a statement of the file. */
type SiblingDeclaration = ClassElement | Statement;

/** The helper declaration the findings point at, with the file that holds it. */
interface CalleeHelper {
  entry: LoadedFile & { sourceFile: SourceFile };
  declaration: HelperFunction;
}

/** The read statement of a helper and what surrounds it. */
interface SplitRead {
  read: Statement;
  before: Statement[];
  after: Statement[];
}

/** A statement that is one query: returned, or kept in a `const` of this name. */
type StatementQuery = { kind: 'return'; call: MethodCall } | { kind: 'declaration'; call: MethodCall; name: string };

/** The `where` object of a read and the key property in it that holds a parameter. */
interface ReadShape {
  method: string;
  batchMethod: string;
  options: ObjectLiteralExpression;
  byMethod: boolean;
  keyProperty: PlainProperty;
  key: string;
  parameter: string;
}

/** The edits that make a batch read select the key, when it needs to. */
interface KeyEdit {
  edits: TextEdit[];
  added?: boolean;
}

/** A batch sibling of a single keyed read. */
interface ReadBatch {
  kind: 'read';
  itemIndex: number;
  parameterNames: string[];
  listName: string;
  lines: string[];
  bare: boolean;
  single: boolean;
  needsIn: boolean;
  note: string;
}

/** A batch sibling of a single write. */
interface WriteBatch {
  kind: 'write';
  receiver: string;
  parameterNames: string[];
  batchCall: (list: string, parameter: string) => string;
  handler: Expression | undefined;
  used: string[];
  typed: boolean;
}

type BatchPlan = ReadBatch | WriteBatch;

/** What the call site loops over and how its per-item names are bound. */
interface SiteBase {
  collection: Expression;
  binding: BindingName;
  names: Set<string>;
}

/** `Promise.all(list.map((item) => helper(item)))`. */
interface AllSite extends SiteBase {
  kind: 'all';
  all: CallExpression;
}

/** `for (const item of list) await helper(item);` */
interface LoopSite extends SiteBase {
  kind: 'loop';
  loop: ForOfStatement;
  awaited: AwaitExpression;
}

/** `await helper(key)` somewhere in a for-of body. */
interface PrefetchSite extends SiteBase {
  kind: 'prefetch';
  loop: ForOfStatement;
  awaited: AwaitExpression;
}

type CallSite = AllSite | LoopSite | PrefetchSite;

interface SignatureInput {
  declaration: HelperFunction;
  batchName: string;
  itemIndex: number;
  listName: string;
  typed: boolean;
  returnType: string | undefined;
}

interface RowLookupInput {
  single: boolean;
  rowsName: string;
  rowName: string;
  key: string;
  parameter: string;
  typed: boolean;
  taken: (name: string) => boolean;
}

interface ParsedExpression {
  node?: Expression;
  sourceFile?: SourceFile;
}

/** The sibling the call site uses: one that exists, or the name of the one to add. */
interface BatchTarget {
  name: string;
  existing?: SiblingDeclaration;
}

interface BatchedFixInput {
  finding: Finding;
  call: CallExpression;
  sourceFile: SourceFile;
  load: SiteFixInput['load'];
}

interface SiteEditsInput {
  site: CallSite;
  call: CallExpression;
  batch: string;
  itemIndex: number;
  argument: Expression;
  read: ReadBatch | undefined;
  sourceFile: SourceFile;
  typed: boolean;
}

const CONCURRENT_CALLS = 5;
const typedExtensions = /\.[cm]?tsx?$/i;
const migrationSource = /(?:^|[\\/])migrations?[\\/]/i;
// Cache commands on separate keys do not race when they overlap. Database helpers are left
// sequential: their order and locks can matter (two claims of the same slot, deadlocks between
// multi-table deletes), and the listed queries may not be all a helper does.
const overlapSafeCommands = new Set([
  'del',
  'unlink',
  'get',
  'mget',
  'exists',
  'set',
  'setex',
  'expire',
  'hdel',
  'hget',
  'scan',
]);
const transactionHandle =
  /^(?:tx|trx|transaction|manager|entityManager|em|queryRunner|runner|session|connection|conn)$|(?:Manager|Runner|Tx|Transaction|Session)$/;
const arrayMethods = new Set(['map', 'filter', 'slice', 'concat', 'flat', 'flatMap']);
const objectListers = new Set(['keys', 'values', 'entries']);

// Batch variants of single-row and list reads, by client family.
const batchReads: Record<ClientFamily, Record<string, string>> = {
  typeorm: { find: 'find', findBy: 'findBy', findOne: 'find', findOneBy: 'findBy' },
  prisma: { findMany: 'findMany', findFirst: 'findMany', findUnique: 'findMany' },
};
const singleReads = new Set(['findOne', 'findOneBy', 'findFirst', 'findUnique']);
// Options that change which rows one call returns per key, so they cannot be shared by all keys.
const readOptions = new Set(['where', 'select', 'relations', 'order', 'orderBy', 'include', 'withDeleted']);

function clientFamily(message: string): ClientFamily | undefined {
  if (message.includes('`In(ids)`')) return 'typeorm';
  if (message.includes('`{ in: ids }`')) return 'prisma';
}

function unwrap(node: Expression): Expression {
  return ts.skipOuterExpressions(node);
}

function references(node: Node, names: ReadonlySet<string>): boolean {
  let found = false;
  (function visit(child: Node): void {
    if (found) return;
    if (ts.isIdentifier(child) && names.has(child.text) && !isPropertyName(child)) found = true;
    else ts.forEachChild(child, visit);
  })(node);
  return found;
}

function isPropertyName(identifier: Identifier): boolean {
  const parent = identifier.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier)
  );
}

function contains(node: Node, predicate: (node: Node) => boolean): boolean {
  let found = false;
  (function visit(child: Node): void {
    if (found) return;
    if (predicate(child)) found = true;
    else ts.forEachChild(child, visit);
  })(node);
  return found;
}

function bindingNames(name: BindingName, names = new Set<string>()): Set<string> {
  if (ts.isIdentifier(name)) names.add(name.text);
  else
    for (const element of name.elements ?? []) if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  return names;
}

// Names declared by the loop binding and inside its body: values that differ per item.
function loopNames(binding: BindingName, body: Node): Set<string> {
  const names = bindingNames(binding);
  (function visit(node: Node): void {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.name) bindingNames(node.name, names);
    ts.forEachChild(node, visit);
  })(body);
  return names;
}

// --- The callee ---

function isHelperFunction(node: Node): node is HelperFunction {
  return (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && !!node.body && !!node.name;
}

function enclosingNamedFunction(node: Node): HelperFunction | undefined {
  for (let current: Node = node; current; current = current.parent) if (isHelperFunction(current)) return current;
}

// The related locations of a finding, or undefined when it has none or one is not a location.
function relatedLocations(finding: Finding): readonly RelatedLocation[] | undefined {
  const { related } = finding;
  if (!Array.isArray(related)) return;
  const entries: readonly unknown[] = related;
  return entries.every(isRelatedLocation) ? entries : undefined;
}

function isRelatedLocation(value: unknown): value is RelatedLocation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'file' in value &&
    typeof value.file === 'string' &&
    'line' in value &&
    typeof value.line === 'number' &&
    'column' in value &&
    typeof value.column === 'number'
  );
}

// The helper declaration when every listed query sits directly in it, so its body is the whole
// story.
function directCallee(
  related: readonly RelatedLocation[] | undefined,
  name: string,
  load: SiteFixInput['load'],
): CalleeHelper | undefined {
  if (!related?.length) return;
  let found: CalleeHelper | undefined;
  for (const location of related) {
    const entry = load(location.file);
    if (!entry?.sourceFile) return;
    const offset = entry.lineStarts[location.line - 1] + location.column - 1;
    const token = innermostNodeAt(ts, entry.sourceFile, offset);
    const declaration = token && enclosingNamedFunction(token);
    if (!declaration || textOf(declaration.name) !== name) return;
    if (found && found.declaration !== declaration) return;
    found = { entry: { ...entry, sourceFile: entry.sourceFile }, declaration };
  }
  return found;
}

// The names of the parameters when every one is a plain identifier, or undefined.
function simpleParameterNames(declaration: MethodDeclaration | FunctionDeclaration): string[] | undefined {
  const names: string[] = [];
  for (const parameter of declaration.parameters) {
    if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || parameter.initializer) return;
    names.push(parameter.name.text);
  }
  return names;
}

function objectProperty(object: ObjectLiteralExpression, key: string): PlainProperty | undefined {
  return object.properties.find(
    (property): property is PlainProperty =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      ts.isIdentifier(property.name) &&
      property.name.text === key,
  );
}

// `repo.find(...)` or `prisma.model.findMany(...)`, awaited or not, as a whole statement's value.
function queryCall(expression: Expression): MethodCall | undefined {
  const value = unwrap(expression);
  const call = ts.isAwaitExpression(value) ? unwrap(value.expression) : value;
  if (isMethodCall(call)) return call;
}

// The read statement and what surrounds it: constant declarations before it, synchronous statements
// after it.
function splitAroundRead(statements: readonly Statement[], family: ClientFamily): SplitRead | undefined {
  const index = statements.findIndex((statement: Statement) => {
    const method = queryStatement(statement)?.call.expression.name.text;
    return contains(statement, ts.isAwaitExpression) || (method !== undefined && batchReads[family][method]);
  });
  if (index === -1) return;
  const read = statements[index];
  const before = statements.slice(0, index);
  const after = statements.slice(index + 1);
  if (
    !before.every(
      (statement: Statement) =>
        ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const,
    )
  )
    return;
  if (after.some((statement: Statement) => contains(statement, ts.isAwaitExpression))) return;
  if (after.length && !after.some((statement: Statement) => contains(statement, ts.isReturnStatement))) return;
  return { read, before, after };
}

function queryStatement(statement: Statement): StatementQuery | undefined {
  if (ts.isReturnStatement(statement) && statement.expression) {
    const call = queryCall(statement.expression);
    return call && { kind: 'return', call };
  }
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    const declaration = statement.declarationList.declarations[0];
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return;
    const call = queryCall(declaration.initializer);
    return call && { kind: 'declaration', call, name: declaration.name.text };
  }
}

// The `where` object of a read and the key property in it that holds a parameter.
function readShape(call: MethodCall, family: ClientFamily, parameterNames: ReadonlySet<string>): ReadShape | undefined {
  const method = call.expression.name.text;
  const batchMethod = batchReads[family][method];
  if (!batchMethod || call.arguments.length !== 1) return;
  const options = unwrap(call.arguments[0]);
  if (!ts.isObjectLiteralExpression(options)) return;
  const byMethod = method.endsWith('By');
  let where: ObjectLiteralExpression = options;
  if (!byMethod) {
    if (!options.properties.every((property) => readOptions.has(textOf(property.name ?? property)))) return;
    const whereProperty = objectProperty(options, 'where');
    if (!whereProperty || !ts.isPropertyAssignment(whereProperty)) return;
    const whereValue = unwrap(whereProperty.initializer);
    if (!ts.isObjectLiteralExpression(whereValue)) return;
    where = whereValue;
  }
  const keyProperties = where.properties.filter((property): property is PlainProperty => {
    if (ts.isShorthandPropertyAssignment(property)) return parameterNames.has(property.name.text);
    return (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.initializer) &&
      parameterNames.has(property.initializer.text)
    );
  });
  const keyProperty = keyProperties[0];
  if (keyProperties.length !== 1 || !ts.isIdentifier(keyProperty.name)) return;
  const parameter = ts.isShorthandPropertyAssignment(keyProperty)
    ? keyProperty.name.text
    : ts.isIdentifier(keyProperty.initializer)
      ? keyProperty.initializer.text
      : undefined;
  if (parameter === undefined) return;
  return { method, batchMethod, options, byMethod, keyProperty, key: keyProperty.name.text, parameter };
}

// `new Set`-free text of the options with the key matched against the whole list, and the key
// selected.
function batchOptionsText(shape: ReadShape, family: ClientFamily, listName: string, edits: TextEdit[]): string {
  const { options, keyProperty, key } = shape;
  const sourceFile = options.getSourceFile();
  const base = options.getStart(sourceFile);
  const replacements = [
    {
      start: keyProperty.getStart(sourceFile),
      end: keyProperty.end,
      text: `${key}: ${family === 'typeorm' ? `In(${listName})` : `{ in: ${listName} }`}`,
    },
    ...edits,
  ].sort((left, right) => right.start - left.start);
  let result = textOf(options);
  for (const replacement of replacements)
    result = result.slice(0, replacement.start - base) + replacement.text + result.slice(replacement.end - base);
  return result;
}

// Rows must carry the key to be matched back to each item; returns the edit that adds it, if any.
function selectKeyEdit(shape: ReadShape): KeyEdit | undefined {
  if (shape.byMethod) return { edits: [] };
  const selectProperty = objectProperty(shape.options, 'select');
  if (!selectProperty) return { edits: [] };
  if (!ts.isPropertyAssignment(selectProperty)) return;
  const select = unwrap(selectProperty.initializer);
  const sourceFile = select.getSourceFile();
  if (ts.isArrayLiteralExpression(select)) {
    const keyNames: string[] = [];
    for (const element of select.elements) {
      if (!ts.isStringLiteralLike(element)) return;
      keyNames.push(element.text);
    }
    if (keyNames.includes(shape.key)) return { edits: [] };
    const quote = select.elements[0] && textOf(select.elements[0]).startsWith('"') ? '"' : "'";
    const separator = select.elements.length ? ', ' : '';
    return {
      edits: [{ start: select.end - 1, end: select.end - 1, text: `${separator}${quote}${shape.key}${quote}` }],
      added: true,
    };
  }
  if (!ts.isObjectLiteralExpression(select)) return;
  if (objectProperty(select, shape.key)) return { edits: [] };
  const opening = select.getStart(sourceFile) + 1;
  return { edits: [{ start: opening, end: opening, text: ` ${shape.key}: true,` }], added: true };
}

function pluralOf(name: string): string {
  if (name.endsWith('s')) return `${name}List`;
  return /[^aeiou]y$/.test(name) ? `${name.slice(0, -1)}ies` : `${name}s`;
}

function arrayType(typeNode: TypeNode): string {
  const text = textOf(typeNode);
  return ts.isUnionTypeNode(typeNode) || ts.isFunctionTypeNode(typeNode) ? `(${text})[]` : `${text}[]`;
}

function promisedType(declaration: HelperFunction): TypeNode | undefined {
  const type = declaration.type;
  if (!type) return;
  if (ts.isTypeReferenceNode(type) && textOf(type.typeName) === 'Promise' && type.typeArguments?.length === 1)
    return type.typeArguments[0];
}

const keptModifierKinds: ReadonlySet<SyntaxKind> = new Set([
  ts.SyntaxKind.PrivateKeyword,
  ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.PublicKeyword,
  ts.SyntaxKind.StaticKeyword,
]);

function modifiersText(declaration: HelperFunction): string {
  const kept = (declaration.modifiers ?? []).filter((modifier) => keptModifierKinds.has(modifier.kind));
  const exported =
    ts.isFunctionDeclaration(declaration) &&
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  return [
    ...(exported ? ['export'] : []),
    ...kept.map(textOf),
    'async',
    ...(ts.isFunctionDeclaration(declaration) ? ['function'] : []),
  ].join(' ');
}

function signatureText({ declaration, batchName, itemIndex, listName, typed, returnType }: SignatureInput): string {
  const parameters = declaration.parameters.map((parameter: ParameterDeclaration, index: number) => {
    if (index !== itemIndex) return textOf(parameter);
    return typed && parameter.type ? `${listName}: ${arrayType(parameter.type)}` : listName;
  });
  const result = typed && returnType ? `: Promise<${returnType}>` : '';
  return `${modifiersText(declaration)} ${batchName}(${parameters.join(', ')})${result} {`;
}

// Statement text moved one level deeper, keeping its own line breaks.
function reindented(statement: Statement, from: string, to: string): string[] {
  return textOf(statement)
    .split('\n')
    .map((line, index) => (index === 0 ? to + line : line.startsWith(from) ? to + line.slice(from.length) : line));
}

// How each key finds its rows in the batch: `filter` for a list read, and for a single-row read a
// Map instead of one scan of the rows per key. The Map is built reversed so a duplicate key keeps
// its first row, as `find` did under the query's order. Undefined when the Map's name is taken.
function rowLookup({
  single,
  rowsName,
  rowName,
  key,
  parameter,
  typed,
  taken,
}: RowLookupInput): { lines: string[]; match: string } | undefined {
  if (!single) return { lines: [], match: `${rowsName}.filter((${rowName}) => ${rowName}.${key} === ${parameter})` };
  const mapName = `${rowsName}By${key[0].toUpperCase()}${key.slice(1)}`;
  if (taken(mapName)) return;
  const entry = `[${rowName}.${key}, ${rowName}]${typed ? ' as const' : ''}`;
  return {
    lines: [`const ${mapName} = new Map(${rowsName}.map((${rowName}) => ${entry}).reverse());`],
    match: `${mapName}.get(${parameter}) ?? null`,
  };
}

// A batch sibling of a single keyed read: one query for all keys, then the per-item result in input
// order.
// loadwise-reviewed high-branch-complexity -- a linear chain of independent bail-outs proving the helper is one keyed read before the batch sibling text is built; splitting scatters the proof from the lines it licenses
function readBatch(callee: CalleeHelper, family: ClientFamily, typed: boolean): ReadBatch | undefined {
  const { declaration } = callee;
  const parameterNames = simpleParameterNames(declaration);
  if (!ts.isBlock(declaration.body) || !parameterNames) return;
  const parts = splitAroundRead(declaration.body.statements, family);
  const query = parts && queryStatement(parts.read);
  const call = query?.call;
  const shape = call && readShape(call, family, new Set(parameterNames));
  if (!parts || !query || !call || !shape) return;
  const itemIndex = parameterNames.indexOf(shape.parameter);
  const itemParameter = declaration.parameters[itemIndex];
  // Rows are matched to keys with ===, which needs keys that are plain strings or numbers.
  if (typed && !(itemParameter.type && ['string', 'number'].includes(textOf(itemParameter.type)))) return;
  // The key must reach the query only through the where clause.
  const others = declaration.body.statements.filter((statement: Statement) => statement !== parts.read);
  if (others.some((statement: Statement) => references(statement, new Set([shape.parameter])))) return;
  let keyUses = 0;
  (function visit(node: Node): void {
    if (ts.isIdentifier(node) && node.text === shape.parameter && !isPropertyName(node)) keyUses++;
    ts.forEachChild(node, visit);
  })(call.arguments[0]);
  if (keyUses !== 1) return;
  const selection = selectKeyEdit(shape);
  if (!selection) return;
  const sourceFile = declaration.getSourceFile();
  const taken = (name: string) => contains(declaration, (node: Node) => ts.isIdentifier(node) && node.text === name);
  const listName = pluralOf(shape.parameter);
  const rowsName = taken('rows') ? 'batchRows' : 'rows';
  const rowName = taken('row') ? 'batchRow' : 'row';
  if (taken(listName) || taken(rowsName) || taken(rowName)) return;
  const single = singleReads.has(shape.method);
  const receiver = textOf(call.expression.expression);
  const options = batchOptionsText(shape, family, listName, selection.edits);
  const lookup = rowLookup({ single, rowsName, rowName, key: shape.key, parameter: shape.parameter, typed, taken });
  if (!lookup) return;
  const { match } = lookup;
  const returned = promisedType(declaration);
  const returnType = returned && (ts.isUnionTypeNode(returned) ? `(${textOf(returned)})[]` : `${textOf(returned)}[]`);
  const indentation = indentationAt(sourceFile.text, declaration.getStart(sourceFile));
  const bodyIndentation = indentationAt(sourceFile.text, declaration.body.statements[0].getStart(sourceFile));
  const step = bodyIndentation.slice(indentation.length) || '  ';
  const lines = [
    `${indentation}${signatureText({ declaration, batchName: 'BATCH_NAME', itemIndex, listName, typed, returnType })}`,
    `${bodyIndentation}if (!${listName}.length) return [];`,
    ...parts.before.flatMap((statement: Statement) => reindented(statement, bodyIndentation, bodyIndentation)),
    `${bodyIndentation}const ${rowsName} = await ${receiver}.${shape.batchMethod}(${options});`,
    ...lookup.lines.map((line) => bodyIndentation + line),
  ];
  if (query.kind === 'return')
    lines.push(`${bodyIndentation}return ${listName}.map((${shape.parameter}) => ${match});`);
  else {
    lines.push(
      `${bodyIndentation}return ${listName}.map((${shape.parameter}) => {`,
      `${bodyIndentation}${step}const ${query.name} = ${match};`,
      ...parts.after.flatMap((statement: Statement) => reindented(statement, bodyIndentation, bodyIndentation + step)),
      `${bodyIndentation}});`,
    );
  }
  lines.push(`${indentation}}`);
  return {
    kind: 'read',
    itemIndex,
    parameterNames,
    listName,
    lines,
    bare: !parts.after.length,
    single,
    needsIn: family === 'typeorm',
    note:
      `${shape.method}() per item becomes one ${shape.batchMethod}() over all keys, ` +
      (single
        ? `looked up by \`${shape.key}\` in a Map (first match, null when missing).`
        : `matched back with === on \`${shape.key}\`.`) +
      (selection.added ? ` The rows now also select \`${shape.key}\`.` : '') +
      (parts.before.length ? ' The lines before the query run once per batch instead of once per item.' : ''),
  };
}

// `await repo.save(repo.create(X))`, `await repo.insert(X)`, `await prisma.model.create({ data: X
// })`, or
// `const row = repo.create(X); await repo.save(row);` as the whole body.
function writeBatch(callee: CalleeHelper, family: ClientFamily, typed: boolean): WriteBatch | undefined {
  const { declaration } = callee;
  const parameterNames = simpleParameterNames(declaration);
  if (!ts.isBlock(declaration.body) || !parameterNames) return;
  const statements = declaration.body.statements;
  const last = statements[statements.length - 1];
  if (!last || statements.length > 2) return;
  const lastExpression = ts.isExpressionStatement(last) || ts.isReturnStatement(last) ? last.expression : undefined;
  let call = lastExpression && queryCall(lastExpression);
  let handler: Expression | undefined;
  if (call && call.expression.name.text === 'catch' && call.arguments.length === 1) {
    handler = call.arguments[0];
    call = queryCall(call.expression.expression);
  }
  if (!call || call.arguments.length !== 1) return;
  const method = call.expression.name.text;
  const receiver = textOf(call.expression.expression);
  let item: Expression;
  let batchCall: (list: string, parameter: string) => string;
  if (family === 'prisma' && method === 'create' && statements.length === 1) {
    const options = unwrap(call.arguments[0]);
    const data =
      ts.isObjectLiteralExpression(options) && options.properties.length === 1 && objectProperty(options, 'data');
    if (!data || !ts.isPropertyAssignment(data)) return;
    item = data.initializer;
    const dataItem = item;
    batchCall = (list, parameter) =>
      `${receiver}.createMany({ data: ${list}.map((${parameter}) => ${wrapped(dataItem)}) })`;
  } else if (family === 'typeorm' && method === 'insert' && statements.length === 1) {
    item = call.arguments[0];
    const insertedItem = item;
    batchCall = (list, parameter) => `${receiver}.insert(${list}.map((${parameter}) => ${wrapped(insertedItem)}))`;
  } else if (family === 'typeorm' && method === 'save') {
    const created = createdEntity(statements, call, receiver);
    if (!created) return;
    item = created;
    batchCall = (list, parameter) =>
      `${receiver}.save(${list}.map((${parameter}) => ${receiver}.create(${textOf(created)})))`;
  } else return;
  const used = parameterNames.filter((name) => references(item, new Set([name])));
  if (!used.length || parameterNames.some((name) => handler && references(handler, new Set([name])))) return;
  return { kind: 'write', receiver, parameterNames, batchCall, handler, used, typed };
}

function wrapped(node: Expression): string {
  return ts.isObjectLiteralExpression(unwrap(node)) ? `(${textOf(node)})` : textOf(node);
}

// The X of `repo.save(repo.create(X))`, or of `const row = repo.create(X); await repo.save(row);`.
function createdEntity(
  statements: readonly Statement[],
  saveCall: MethodCall,
  receiver: string,
): Expression | undefined {
  const argument = unwrap(saveCall.arguments[0]);
  const isCreate = (node: Node): node is MethodCall =>
    isMethodCall(node) &&
    node.expression.name.text === 'create' &&
    textOf(node.expression.expression) === receiver &&
    node.arguments.length === 1;
  if (statements.length === 1) return isCreate(argument) ? argument.arguments[0] : undefined;
  const [first] = statements;
  if (!ts.isVariableStatement(first) || first.declarationList.declarations.length !== 1) return;
  const declaration = first.declarationList.declarations[0];
  const initializer = declaration.initializer && unwrap(declaration.initializer);
  if (!ts.isIdentifier(declaration.name) || !ts.isIdentifier(argument) || argument.text !== declaration.name.text)
    return;
  return initializer && isCreate(initializer) ? initializer.arguments[0] : undefined;
}

function writeLines(callee: CalleeHelper, write: WriteBatch, itemIndex: number, listName: string): string[] {
  const { declaration } = callee;
  const sourceFile = declaration.getSourceFile();
  const indentation = indentationAt(sourceFile.text, declaration.getStart(sourceFile));
  const bodyIndentation = indentationAt(sourceFile.text, declaration.body.statements[0].getStart(sourceFile));
  const parameter = write.parameterNames[itemIndex];
  const handler = write.handler ? `.catch(${textOf(write.handler)})` : '';
  return [
    `${indentation}${signatureText({ declaration, batchName: 'BATCH_NAME', itemIndex, listName, typed: write.typed, returnType: 'void' })}`,
    `${bodyIndentation}if (!${listName}.length) return;`,
    `${bodyIndentation}await ${write.batchCall(listName, parameter)}${handler};`,
    `${indentation}}`,
  ];
}

// --- The call site ---

// `Promise.all(list.map((item) => helper(item)))`: the helper call is the whole callback body.
function promiseAllSite(call: CallExpression): AllSite | undefined {
  let expression: Expression = call;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  const callback = expression.parent;
  if (!callback || !ts.isArrowFunction(callback) || callback.body !== expression || callback.parameters.length !== 1)
    return;
  const map = callback.parent;
  if (!ts.isCallExpression(map) || map.arguments.length !== 1 || !ts.isPropertyAccessExpression(map.expression)) return;
  if (map.expression.name.text !== 'map') return;
  const all = map.parent;
  if (
    !ts.isCallExpression(all) ||
    all.arguments.length !== 1 ||
    all.arguments[0] !== map ||
    textOf(all.expression) !== 'Promise.all'
  )
    return;
  const parameter = callback.parameters[0];
  if (parameter.initializer || parameter.dotDotDotToken) return;
  return {
    kind: 'all',
    all,
    collection: map.expression.expression,
    binding: parameter.name,
    names: loopNames(parameter.name, callback.body),
  };
}

function awaitedStatement(call: CallExpression): AwaitExpression | undefined {
  let expression: Expression = call;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  if (!ts.isAwaitExpression(expression.parent)) return;
  return expression.parent;
}

function forOfBinding(loop: ForOfStatement): BindingName | undefined {
  if (loop.awaitModifier || !ts.isVariableDeclarationList(loop.initializer)) return;
  const declarations = loop.initializer.declarations;
  return declarations.length === 1 ? declarations[0].name : undefined;
}

// `for (const item of list) await helper(item);` with nothing else in the loop.
function soleLoopSite(call: CallExpression): LoopSite | undefined {
  const awaited = awaitedStatement(call);
  const statement = awaited?.parent;
  if (!awaited || !statement || !ts.isExpressionStatement(statement)) return;
  const container = statement.parent;
  const loop = ts.isBlock(container) && container.statements.length === 1 ? container.parent : container;
  if (!ts.isForOfStatement(loop) || (loop.statement !== statement && loop.statement !== container)) return;
  const binding = forOfBinding(loop);
  if (!binding) return;
  return {
    kind: 'loop',
    loop,
    awaited,
    collection: loop.expression,
    binding,
    names: loopNames(binding, loop.statement),
  };
}

// `await helper(key)` anywhere in a for-of body, outside nested functions and try blocks.
function prefetchSite(call: CallExpression): PrefetchSite | undefined {
  const awaited = awaitedStatement(call);
  if (!awaited) return;
  for (let current = awaited.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isTryStatement(current)) return;
    if (ts.isForOfStatement(current)) {
      const binding = forOfBinding(current);
      if (!binding) return;
      return {
        kind: 'prefetch',
        loop: current,
        awaited,
        collection: current.expression,
        binding,
        names: loopNames(binding, current.statement),
      };
    }
    if (ts.isIterationStatement(current, false)) return;
  }
}

// The one argument that differs per item; the others must be the same for the whole loop.
function varyingArgument(call: CallExpression, site: CallSite): { argument: Expression; index: number } | undefined {
  const varying = call.arguments
    .map((argument: Expression, index: number) => ({ argument, index }))
    .filter(({ argument }) => references(argument, site.names));
  if (varying.length !== 1) return;
  if (contains(varying[0].argument, (node: Node) => ts.isAwaitExpression(node) || ts.isFunctionLike(node))) return;
  return varying[0];
}

function isArrayExpression(expression: Expression): boolean {
  const value = unwrap(expression);
  if (ts.isArrayLiteralExpression(value)) return true;
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return false;
  const method = value.expression.name.text;
  const receiver = textOf(value.expression.expression);
  return (
    arrayMethods.has(method) ||
    (receiver === 'Object' && objectListers.has(method)) ||
    (receiver === 'Array' && method === 'from')
  );
}

// The list of per-item argument values, as an expression over the loop's collection.
function listExpression(site: CallSite, argument: Expression, typed: boolean): string {
  const binding = textOf(site.binding);
  const collection = textOf(site.collection);
  const identity = ts.isIdentifier(site.binding) && textOf(argument) === binding;
  // A for-of loop accepts any iterable; .map() needs an array.
  const array =
    site.kind === 'all' || isArrayExpression(site.collection) || (typed && isPlainReference(unwrap(site.collection)));
  if (identity) return array ? collection : `Array.from(${collection})`;
  return array
    ? `${collection}.map((${binding}) => ${textOf(argument)})`
    : `Array.from(${collection}, (${binding}) => ${textOf(argument)})`;
}

function calleeText(call: CallExpression, batchName: string): string {
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) ? `${textOf(callee.expression)}.${batchName}` : batchName;
}

function batchCallText(call: CallExpression, batchName: string, itemIndex: number, list: string): string {
  const parts = call.arguments.map((argument: Expression, index: number) =>
    index === itemIndex ? list : textOf(argument),
  );
  return `${calleeText(call, batchName)}(${parts.join(', ')})`;
}

// --- Assembling the fix ---

function insertMethod(callee: CalleeHelper, batchName: string, lines: string[]): TextEdit {
  const { declaration } = callee;
  return {
    start: declaration.end,
    end: declaration.end,
    text: '\n\n' + lines.join('\n').replace('BATCH_NAME', batchName),
  };
}

// TypeORM's In() must be imported where the batch read is written.
function inImportEdit(sourceFile: SourceFile): { edits: TextEdit[] } | undefined {
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const typeormImport = imports.find(
    (declaration) => ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text === 'typeorm',
  );
  const clause = typeormImport?.importClause;
  const named = clause?.namedBindings;
  if (!clause || !named || !ts.isNamedImports(named) || clause.isTypeOnly) return;
  if (named.elements.some((element) => element.name.text === 'In' && !element.isTypeOnly)) return { edits: [] };
  if (contains(sourceFile, (node: Node) => ts.isIdentifier(node) && node.text === 'In')) return;
  const position = named.elements.length
    ? named.elements[named.elements.length - 1].end
    : named.getStart(sourceFile) + 1;
  return { edits: [{ start: position, end: position, text: named.elements.length ? ', In' : ' In ' }] };
}

// --- Reusing a batch sibling that already exists ---

// The declarations beside the helper: its class members, or the statements of the file holding a
// function.
function siblingDeclarations(declaration: HelperFunction): readonly SiblingDeclaration[] {
  if (ts.isClassLike(declaration.parent)) return declaration.parent.members;
  return ts.isSourceFile(declaration.parent) || ts.isModuleBlock(declaration.parent)
    ? declaration.parent.statements
    : [];
}

function declaredName(declaration: SiblingDeclaration): string | undefined {
  const name =
    ts.isClassElement(declaration) || ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)
      ? declaration.name
      : undefined;
  return name && ts.isIdentifier(name) ? name.text : undefined;
}

function hasModifier(declaration: Node, kind: SyntaxKind): boolean {
  return ts.canHaveModifiers(declaration) && !!ts.getModifiers(declaration)?.some((modifier) => modifier.kind === kind);
}

// Text compared line by line without indentation or line-ending differences, so a sibling an
// earlier fix inserted (possibly reformatted to the file's indentation) is recognised as this one.
function sameLines(declaration: Node, lines: readonly string[]): boolean {
  const normalized = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
  return normalized(textOf(declaration)) === normalized(lines.join('\n'));
}

// A function in the file that takes exactly one parameter, so `list.map(fn)` passes it nothing
// extra that matters.
function unaryFunctionNamed(sourceFile: SourceFile, name: string): boolean {
  return sourceFile.statements.some(
    (statement: Statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      statement.parameters.length === 1 &&
      !statement.parameters[0].dotDotDotToken,
  );
}

// A canonical form of an expression: parameters by position, arrow parameters by depth, `(x) =>
// fn(x)` as `fn` when `fn` is a one-parameter function of `sourceFile`, and no formatting. Two
// expressions with the same form do the same thing.
function canonical(node: Node, names: ReadonlyMap<string, string>, sourceFile: SourceFile, depth = 0): string {
  if (ts.isParenthesizedExpression(node)) return canonical(node.expression, names, sourceFile, depth);
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    const propertyName =
      parent && (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node;
    return propertyName ? node.text : (names.get(node.text) ?? node.text);
  }
  if (ts.isArrowFunction(node) && node.parameters.length === 1 && ts.isIdentifier(node.parameters[0].name)) {
    const parameter = node.parameters[0].name.text;
    const body = ts.isParenthesizedExpression(node.body) ? node.body.expression : node.body;
    const forwards =
      ts.isCallExpression(body) &&
      ts.isIdentifier(body.expression) &&
      body.arguments.length === 1 &&
      ts.isIdentifier(body.arguments[0]) &&
      body.arguments[0].text === parameter &&
      unaryFunctionNamed(sourceFile, body.expression.text);
    if (forwards) return canonical(body.expression, names, sourceFile, depth);
    const inner = new Map(names).set(parameter, `$arrow${depth}`);
    return `(${inner.get(parameter)})=>${canonical(node.body, inner, sourceFile, depth + 1)}`;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return `#${node.getText()}`;
  const children: string[] = [];
  ts.forEachChild(node, (child) => {
    children.push(canonical(child, names, sourceFile, depth));
  });
  return children.length ? `${node.kind}(${children.join(',')})` : `${node.kind}:${node.getText()}`;
}

function parsedExpression(text: string, sourceFile: SourceFile): ParsedExpression {
  const parsed = ts.createSourceFile(sourceFile.fileName, `(${text});`, ts.ScriptTarget.Latest, true);
  const [statement] = parsed.statements;
  return statement && ts.isExpressionStatement(statement) ? { node: statement.expression, sourceFile: parsed } : {};
}

// `if (!list.length) return;` or `if (list.length === 0) return;`: nothing to write for an empty
// list.
function emptyListGuard(statement: Statement, listName: string): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const thenStatement =
    ts.isBlock(statement.thenStatement) && statement.thenStatement.statements.length === 1
      ? statement.thenStatement.statements[0]
      : statement.thenStatement;
  if (!ts.isReturnStatement(thenStatement) || thenStatement.expression) return false;
  const condition = textOf(statement.expression).replaceAll(/\s+/g, '');
  return [`!${listName}.length`, `${listName}.length===0`, `${listName}.length<1`].includes(condition);
}

// The project's own array variant of a write helper: the same parameters with the item one as a
// list, and a body that only skips an empty list and runs the same batch write the generated
// sibling would.
function equivalentWrite(
  member: SiblingDeclaration,
  callee: CalleeHelper,
  write: WriteBatch,
  itemIndex: number,
): boolean {
  const { declaration } = callee;
  if (
    member === declaration ||
    member.kind !== declaration.kind ||
    !(ts.isMethodDeclaration(member) || ts.isFunctionDeclaration(member)) ||
    !member.body ||
    !ts.isBlock(member.body) ||
    member.parameters.length !== declaration.parameters.length ||
    hasModifier(member, ts.SyntaxKind.StaticKeyword) !== hasModifier(declaration, ts.SyntaxKind.StaticKeyword)
  )
    return false;
  const memberParameterNames = simpleParameterNames(member);
  if (!memberParameterNames) return false;
  const sameParameters = declaration.parameters.every((parameter: ParameterDeclaration, index: number) => {
    const other = member.parameters[index];
    const typeText = (candidate: ParameterDeclaration) => (candidate.type ? textOf(candidate.type) : '');
    if (index !== itemIndex) return typeText(parameter) === typeText(other);
    if (!parameter.type || !other.type) return !parameter.type && !other.type;
    const item = textOf(parameter.type);
    return [`${item}[]`, `readonly ${item}[]`, `Array<${item}>`, `ReadonlyArray<${item}>`].includes(textOf(other.type));
  });
  if (!sameParameters) return false;
  const listName = memberParameterNames[itemIndex];
  const statements = member.body.statements.filter((statement: Statement) => !emptyListGuard(statement, listName));
  const [statement] = statements;
  if (statements.length !== 1 || !(ts.isExpressionStatement(statement) || ts.isReturnStatement(statement)))
    return false;
  const awaited = statement.expression && unwrap(statement.expression);
  if (!awaited || !ts.isAwaitExpression(awaited)) return false;
  const positions = (parameterNames: readonly string[], list: string) =>
    new Map(
      parameterNames.map((name, index): [string, string] => [name, index === itemIndex ? list : `$argument${index}`]),
    );
  const handler = write.handler ? `.catch(${textOf(write.handler)})` : '';
  const expected = parsedExpression(
    `${write.batchCall(listName, write.parameterNames[itemIndex])}${handler}`,
    declaration.getSourceFile(),
  );
  if (!expected.node) return false;
  const sourceFile = declaration.getSourceFile();
  const ownNames = positions(memberParameterNames, '$list');
  // The generated call names the list after the member's own parameter; the other parameters use
  // the helper's names.
  const expectedNames = new Map([...positions(write.parameterNames, '$item'), [listName, '$list']]);
  return canonical(awaited.expression, ownNames, sourceFile) === canonical(expected.node, expectedNames, sourceFile);
}

// The batch sibling to call: one already in the file (inserted by an earlier fix, or the project's
// own array variant of the same write), or a new `<helper>Many`. Undefined when that name already
// holds something different.
function batchTarget(
  callee: CalleeHelper,
  lines: string[],
  write: WriteBatch | undefined,
  itemIndex: number,
): BatchTarget | undefined {
  const { declaration } = callee;
  const name = `${textOf(declaration.name)}Many`;
  const siblings = siblingDeclarations(declaration);
  const sameName = siblings.find((sibling) => declaredName(sibling) === name);
  if (sameName) {
    const reusable =
      sameLines(
        sameName,
        lines.map((line) => line.replace('BATCH_NAME', name)),
      ) ||
      (write && equivalentWrite(sameName, callee, write, itemIndex));
    return reusable ? { name, existing: sameName } : undefined;
  }
  const equivalent = write && siblings.find((sibling) => equivalentWrite(sibling, callee, write, itemIndex));
  const equivalentName = equivalent && declaredName(equivalent);
  if (equivalent && equivalentName) return { name: equivalentName, existing: equivalent };
  // A new function shares the file's scope; a new method only the class's members.
  if (ts.isFunctionDeclaration(declaration) && nameTaken(declaration.getSourceFile(), name)) return;
  return { name };
}

// A private or protected sibling can only be called from inside its own class.
function callableFrom(existing: SiblingDeclaration, call: CallExpression): boolean {
  const hidden =
    hasModifier(existing, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(existing, ts.SyntaxKind.ProtectedKeyword) ||
    (ts.isClassElement(existing) && !!existing.name && ts.isPrivateIdentifier(existing.name));
  if (!hidden) return true;
  for (let current = call.parent; current; current = current.parent)
    if (ts.isClassLike(current)) return current === existing.parent;
  return false;
}

// --- Importing a batch function declared in another file ---

const resolvedExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

// Whether a relative module specifier written in `fromFile` names `targetFile` (with or without its
// extension, a
// `.js` written for a `.ts` source, or an index file).
function specifierNames(specifier: string, fromFile: string, targetFile: string): boolean {
  if (!/^\.\.?(?:\/|$)/.test(specifier)) return false;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const stem = base.replace(/\.[cm]?[jt]sx?$/i, '');
  const candidates = [
    base,
    ...resolvedExtensions.flatMap((extension) => [stem + extension, path.join(base, 'index' + extension)]),
  ];
  const target = path.resolve(targetFile).toLowerCase();
  return candidates.some((candidate) => candidate.toLowerCase() === target);
}

// The edit adding `batchName` next to `name` in the call site's named import of the helper's file.
function importBatchEdit(
  sourceFile: SourceFile,
  name: string,
  batchName: string,
  calleeFile: string,
): TextEdit[] | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!clause || clause.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
    if (!specifierNames(statement.moduleSpecifier.text, sourceFile.fileName, calleeFile)) continue;
    const element = bindings.elements.find((candidate) => candidate.name.text === name);
    if (!element || element.propertyName || element.isTypeOnly) return;
    if (bindings.elements.some((candidate) => candidate.name.text === batchName)) return [];
    if (nameTaken(sourceFile, batchName)) return;
    return [{ start: element.end, end: element.end, text: `, ${batchName}` }];
  }
}

// An exported top-level function called by its own name from another file that imports it by name.
function crossFileImport(
  callee: CalleeHelper,
  call: CallExpression,
  sourceFile: SourceFile,
  batchName: string,
): TextEdit[] | undefined {
  const { declaration } = callee;
  if (!ts.isSourceFile(declaration.parent) || !hasModifier(declaration, ts.SyntaxKind.ExportKeyword)) return;
  if (hasModifier(declaration, ts.SyntaxKind.DefaultKeyword) || !ts.isIdentifier(call.expression)) return;
  return importBatchEdit(sourceFile, call.expression.text, batchName, callee.entry.absolute);
}

function targetsOf(editsByFile: ReadonlyMap<string, TextEdit[]>): FileTarget[] {
  return [...editsByFile].map(([file, edits]) => ({ file, edits }));
}

function addEdits(editsByFile: Map<string, TextEdit[]>, file: string, edits: TextEdit[]): void {
  editsByFile.set(file, [...(editsByFile.get(file) ?? []), ...edits]);
}

// loadwise-reviewed high-branch-complexity -- a linear chain of independent bail-outs (family, callee, site, argument, target, import) before one rewrite; each guard depends on the previous result so splitting adds only plumbing
function batchedFix({ finding, call, sourceFile, load }: BatchedFixInput): FixResult | undefined {
  const family = clientFamily(finding.message);
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : textOf(call.expression);
  const related = relatedLocations(finding);
  const callee = family && directCallee(related, name, load);
  if (!family || !callee || related?.length !== 1 || finding.file === undefined) return;
  const crossFile = ts.isFunctionDeclaration(callee.declaration) && callee.entry.sourceFile !== sourceFile;
  const typed = typedExtensions.test(callee.entry.sourceFile.fileName);
  const siteTyped = typedExtensions.test(sourceFile.fileName);
  const read = readBatch(callee, family, typed);
  const write = read ? undefined : writeBatch(callee, family, typed);
  const plan = read ?? write;
  if (!plan) return;
  const site =
    promiseAllSite(call) ?? (write ? soleLoopSite(call) : undefined) ?? (read?.bare ? prefetchSite(call) : undefined);
  if (!site) return;
  const varying = varyingArgument(call, site);
  if (!varying || call.arguments.length !== callee.declaration.parameters.length) return;
  const itemIndex = read ? read.itemIndex : varying.index;
  if (varying.index !== itemIndex) return;
  if (write && !write.used.includes(write.parameterNames[itemIndex])) return;
  if (site.kind === 'all' && write && !ts.isExpressionStatement(awaitedStatement(site.all)?.parent ?? site.all.parent))
    return;
  const listName = read ? read.listName : pluralOf(plan.parameterNames[itemIndex]);
  if (write && contains(callee.declaration, (node: Node) => ts.isIdentifier(node) && node.text === listName)) return;
  const lines = read ? read.lines : write && writeLines(callee, write, itemIndex, listName);
  if (!lines) return;
  const target = batchTarget(callee, lines, write, itemIndex);
  if (!target || (target.existing && !callableFrom(target.existing, call))) return;
  const batch = target.name;
  const imported = crossFile && crossFileImport(callee, call, sourceFile, batch);
  if (crossFile && !imported) return;
  const siteEditList = siteEdits({
    site,
    call,
    batch,
    itemIndex,
    argument: varying.argument,
    read,
    sourceFile,
    typed: siteTyped,
  });
  if (!siteEditList) return;
  const editsByFile = new Map<string, TextEdit[]>();
  addEdits(editsByFile, finding.file, [...(imported || []), ...siteEditList]);
  const calleeFile = callee.entry.filename;
  if (!target.existing) {
    addEdits(editsByFile, calleeFile, [insertMethod(callee, batch, lines)]);
    if (read?.needsIn) {
      const importEdit = inImportEdit(callee.entry.sourceFile);
      if (!importEdit) return;
      addEdits(editsByFile, calleeFile, importEdit.edits);
    }
  }
  return { targets: targetsOf(editsByFile), note: batchNote(site, plan, batch, !!target.existing) };
}

function siteEdits({
  site,
  call,
  batch,
  itemIndex,
  argument,
  read,
  sourceFile,
  typed,
}: SiteEditsInput): TextEdit[] | undefined {
  const list = listExpression(site, argument, typed);
  if (site.kind === 'all')
    return [
      { start: site.all.getStart(sourceFile), end: site.all.end, text: batchCallText(call, batch, itemIndex, list) },
    ];
  if (site.kind === 'loop')
    return [
      {
        start: site.loop.getStart(sourceFile),
        end: site.loop.end,
        text: `await ${batchCallText(call, batch, itemIndex, list)};`,
      },
    ];
  // Prefetch: the key is evaluated again inside the loop, so it must be free of side effects.
  if (!read || !isPlainReference(unwrap(argument)) || !isPlainReference(unwrap(site.collection))) return;
  const keys = freshName(sourceFile, read.listName);
  const byKey = freshName(sourceFile, `${lastSegment(textOf(call.expression))}ByKey`);
  if (!keys || !byKey) return;
  const fallback = read.single ? 'null' : '[]';
  const lookup = `${byKey}.get(${textOf(argument)}) ?? ${fallback}`;
  const parent = site.awaited.parent;
  const inline = ts.isVariableDeclaration(parent) || ts.isReturnStatement(parent) ? lookup : `(${lookup})`;
  const indentation = indentationAt(sourceFile.text, site.loop.getStart(sourceFile));
  const prefetch = [
    `const ${keys} = ${list};`,
    `const ${byKey} = new Map((await ${batchCallText(call, batch, itemIndex, keys)}).map((result, index) => [${keys}[index], result]));`,
  ];
  const anchor = ts.isLabeledStatement(site.loop.parent) ? site.loop.parent : site.loop;
  const loopStart = anchor.getStart(sourceFile);
  return [
    { start: loopStart, end: loopStart, text: prefetch.join('\n' + indentation) + '\n' + indentation },
    { start: site.awaited.getStart(sourceFile), end: site.awaited.end, text: inline },
  ];
}

function batchNote(site: CallSite, plan: BatchPlan, batch: string, existing: boolean): string {
  const verb = existing ? 'Calls the existing' : 'Adds';
  if (plan.kind === 'read') {
    const timing =
      site.kind === 'prefetch'
        ? ' All keys are read before the loop, so rows the loop writes before reading them are not seen, and items the loop skips are still fetched.'
        : '';
    return `${verb} ${batch}(): ${plan.note}${timing}`;
  }
  return `${verb} ${batch}(), which writes all rows in one statement after the loop instead of one per item. The batch is all-or-nothing (a failing row no longer leaves the earlier rows written), ${
    plan.batchCall('x', 'y').includes('createMany')
      ? 'createMany does not run nested writes or return the rows, '
      : 'entity listeners still run per row, '
  }and the rows are written when the loop would have finished.`;
}

// --- Fallback: run the calls a few at a time ---

// The helper only runs cache commands, every one of them listed rather than summarized as "and N
// more".
function lastSegment(qualifiedName: string): string {
  const segments = qualifiedName.split('.');
  return segments[segments.length - 1];
}

function overlapSafe(finding: Finding): boolean {
  if (!/ Redis commands? per item/.test(finding.message) || /\d+ more\)/.test(finding.message)) return false;
  const related = relatedLocations(finding);
  if (!related) return false;
  return related.every((location) => {
    const label = /`([^`]+)`/.exec(location.message ?? '')?.[1];
    return label && overlapSafeCommands.has(lastSegment(label).toLowerCase());
  });
}

function concurrentFix({ finding, call, sourceFile }: Omit<BatchedFixInput, 'load'>): FixResult | undefined {
  // Tests, seeds and scripts run sequentially on purpose more often than not, and their speed
  // rarely matters.
  if (finding.contextualReason || (finding.file !== undefined && migrationSource.test(finding.file))) return;
  if (!overlapSafe(finding)) return;
  const site = soleLoopSite(call);
  // Several statements replace the loop, which only a block (not an `if` body or a label) can hold.
  if (!site || !(ts.isBlock(site.loop.parent) || ts.isSourceFile(site.loop.parent))) return;
  const operand = site.awaited.expression;
  if (contains(operand, ts.isAwaitExpression)) return;
  const handles = new Set<string>();
  (function visit(node: Node): void {
    if (ts.isIdentifier(node) && !isPropertyName(node) && transactionHandle.test(node.text)) handles.add(node.text);
    ts.forEachChild(node, visit);
  })(operand);
  // Calls on one transaction share its connection, so they cannot overlap anyway.
  if (handles.size) return;
  for (let current: Node = site.loop.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const owner = current.parent;
    if (ts.isCallExpression(owner) && /transaction/i.test(textOf(owner.expression))) return;
    break;
  }
  const items = freshName(sourceFile, 'pendingItems');
  const start = freshName(sourceFile, 'start');
  const limit = freshName(sourceFile, 'concurrentCalls');
  if (!items || !start || !limit) return;
  const indentation = indentationAt(sourceFile.text, site.loop.getStart(sourceFile));
  const lines = [
    `const ${limit} = ${CONCURRENT_CALLS};`,
    `const ${items} = Array.from(${textOf(site.collection)});`,
    `for (let ${start} = 0; ${start} < ${items}.length; ${start} += ${limit}) {`,
    `  await Promise.all(${items}.slice(${start}, ${start} + ${limit}).map((${textOf(site.binding)}) => ${textOf(operand)}));`,
    '}',
  ];
  const name = textOf(call.expression);
  return {
    edits: [{ start: site.loop.getStart(sourceFile), end: site.loop.end, text: lines.join('\n' + indentation) }],
    note: `This does not cut the number of queries: no batch variant could be derived from \`${name}()\`, so a set-based version of it, or one multi-key client call such as Redis \`del(...keys)\` or \`mget(...keys)\`, is still the real fix. Meanwhile it runs up to ${CONCURRENT_CALLS} calls at once to cut wall time. Calls now overlap and may finish out of order, and when one fails the others of its group still run (later groups do not start). Apply only if the items are independent of each other.`,
  };
}

function serviceLoopFix({ finding, node, sourceFile, load }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const call = calleeCall(node);
  if (!call) return;
  return batchedFix({ finding, call, sourceFile, load }) ?? concurrentFix({ finding, call, sourceFile });
}

export default { 'service-query-in-loop': serviceLoopFix };
