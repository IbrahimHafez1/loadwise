// Read-batch planning: turns a helper that is one keyed read into a sibling that reads all keys
// with one query and matches the rows back.
import { ts, indentationAt, textOf } from './helpers.js';
import {
  unwrap,
  references,
  isPropertyName,
  contains,
  simpleParameterNames,
  objectProperty,
  queryCall,
} from './service-loop-ast.js';
import { signatureText } from './service-loop-signature.js';
import type { Node, ObjectLiteralExpression, Statement, TypeNode } from 'typescript';
import type { MethodCall } from '../types/method-call.js';
import type { ClientFamily } from '../types/client-family.js';
import type { HelperFunction } from '../types/helper-function.js';
import type { PlainProperty } from '../types/plain-property.js';
import type { CalleeHelper } from '../types/callee-helper.js';
import type { ReadBatch } from '../types/batch-plan.js';
import type { TextEdit } from '../../shared/types.js';

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

interface RowLookupInput {
  single: boolean;
  rowsName: string;
  rowName: string;
  key: string;
  parameter: string;
  typed: boolean;
  taken: (name: string) => boolean;
}

// Batch variants of single-row and list reads, by client family.
const batchReads: Record<ClientFamily, Record<string, string>> = {
  typeorm: { find: 'find', findBy: 'findBy', findOne: 'find', findOneBy: 'findBy' },
  prisma: { findMany: 'findMany', findFirst: 'findMany', findUnique: 'findMany' },
};

const singleReads = new Set(['findOne', 'findOneBy', 'findFirst', 'findUnique']);

// Options that change which rows one call returns per key, so they cannot be shared by all keys.
const readOptions = new Set(['where', 'select', 'relations', 'order', 'orderBy', 'include', 'withDeleted']);

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

export function pluralOf(name: string): string {
  if (name.endsWith('s')) return `${name}List`;
  return /[^aeiou]y$/.test(name) ? `${name.slice(0, -1)}ies` : `${name}s`;
}

function promisedType(declaration: HelperFunction): TypeNode | undefined {
  const type = declaration.type;
  if (!type) return;
  if (ts.isTypeReferenceNode(type) && textOf(type.typeName) === 'Promise' && type.typeArguments?.length === 1)
    return type.typeArguments[0];
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
export function readBatch(callee: CalleeHelper, family: ClientFamily, typed: boolean): ReadBatch | undefined {
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
