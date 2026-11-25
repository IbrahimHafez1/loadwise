// Prisma per-item rewrites inside loops: keyed and grouped lookups, counts and aggregates through
// groupBy, createMany for loop inserts and one $transaction for loop writes.
import {
  ts,
  textOf,
  replaceNode,
  calleeCall,
  enclosingIteration,
  insertLinesBefore,
  isPlainReference,
  hasCommentBetween,
} from './helpers.js';
import { isMethodCall } from './method-calls.js';
import type {
  ArrowFunction,
  CallExpression,
  Expression,
  Node,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  SourceFile,
  Statement,
} from 'typescript';
import {
  someNode,
  inSlot,
  localNames,
  readsOnly,
  receiverRoot,
  readsOnlyNames,
  plainProperties,
  indentationOf,
} from './query-loop-nodes.js';
import { plural, capitalized, usableName, asConst } from './query-loop-names.js';
import { forOfBinding, loopLookup, itemKeyFilter, itemKeys, loopWorkNote } from './query-loop-sites.js';
import { mapParts, mapItems } from './query-loop-collections.js';
import {
  keyedLookup,
  groupedLookup,
  groupedKeyNote,
  nullKeyNote,
  ownIdKey,
  mapKeyNote,
  duplicateKeyNote,
  joinNotes,
  invariantOptions,
  whereWith,
} from './query-loop-lookups.js';
import type { ForOfLoopBinding } from '../types/loop-lookup.js';
import type { MethodCall } from '../types/method-call.js';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.js';

/** A for-of whose whole body is one statement. */
type LoopWrite = ForOfLoopBinding & { statement: Statement };

/** The select that holds the key field: left as it is, or rewritten to add the field. */
type KeySelection = { added: false } | { added: true; text: string };

type PrismaMode = 'one' | 'list' | 'count' | 'aggregate';

type CallbackIteration = Extract<NonNullable<ReturnType<typeof enclosingIteration>>, { kind: 'callback' }>;

// `{ field: true }` with the key field selected, adding it when missing.
function selectingKey(select: ObjectLiteralElementLike, field: string): KeySelection | undefined {
  const selected = ts.isPropertyAssignment(select) && plainProperties(select.initializer);
  if (!selected) return;
  const current = selected.get(field);
  if (current)
    return ts.isPropertyAssignment(current) && current.initializer.kind === ts.SyntaxKind.TrueKeyword
      ? { added: false }
      : undefined;
  const fields = [...selected.values()].map(textOf);
  return { text: `select: { ${[...fields, `${field}: true`].join(', ')} }`, added: true };
}

const prismaModes: Record<string, PrismaMode> = {
  findUnique: 'one',
  findFirst: 'one',
  findMany: 'list',
  count: 'count',
  aggregate: 'aggregate',
};
const prismaAggregates = new Set(['_avg', '_sum', '_min', '_max', '_count']);

// What `aggregate` returns for a key with no rows, which groupBy leaves out.
function emptyAggregate(options: ReadonlyMap<string, ObjectLiteralElementLike>): string | undefined {
  const parts: string[] = [];
  for (const [name, property] of options) {
    if (name === 'where') continue;
    const fields = ts.isPropertyAssignment(property) ? plainProperties(property.initializer) : undefined;
    if (!prismaAggregates.has(name) || !fields?.size) return;
    const empty = name === '_count' ? '0' : 'null';
    for (const field of fields.values())
      if (!ts.isPropertyAssignment(field) || field.initializer.kind !== ts.SyntaxKind.TrueKeyword) return;
    parts.push(`${name}: { ${[...fields.keys()].map((field) => `${field}: ${empty}`).join(', ')} }`);
  }
  return parts.length ? `{ ${parts.join(', ')} }` : undefined;
}

// loadwise-reviewed high-branch-complexity -- each branch is an independent bail-out of the safety proof (shape, key, options, notes) followed by one exclusive count/aggregate vs list/one build; splitting scatters the checks from the rewrite they guard
function prismaLookup(call: MethodCall, sourceFile: SourceFile): FixResult | undefined {
  const delegate = call.expression.expression;
  const mode = prismaModes[call.expression.name.text];
  if (!mode || !ts.isPropertyAccessExpression(delegate) || !isPlainReference(delegate) || call.arguments.length !== 1)
    return;
  const site = loopLookup(call);
  if (!site) return;
  const options = plainProperties(call.arguments[0]);
  const where = options?.get('where');
  if (!options || !where || !ts.isPropertyAssignment(where)) return;
  const key = itemKeyFilter(where.initializer, site);
  if (!key) return;
  const keys = itemKeys(site, key);
  if (!keys) return;
  const workNotes = loopWorkNote(site, textOf(delegate), receiverRoot(delegate), key.perItem);
  if (!workNotes) return;
  const model = delegate.name.text;
  const condition = whereWith(key, `{ in: ${keys} }`);
  if (mode === 'count' || mode === 'aggregate') {
    let empty: string | undefined = '0';
    let extra = '_count: { _all: true }';
    if (mode === 'count' && options.size !== 1) return;
    if (mode === 'aggregate') {
      empty = emptyAggregate(options);
      const others = empty && invariantOptions(options, site, prismaAggregates);
      if (!others) return;
      extra = [...others.values()].join(', ');
    }
    const groups = usableName(sourceFile, `${model}${mode === 'count' ? 'Counts' : 'Totals'}`);
    const byKey = groups && usableName(sourceFile, `${groups.replace(/s$/, '')}By${capitalized(key.field)}`);
    if (!byKey) return;
    const value = mode === 'count' ? 'row._count._all' : 'row';
    return {
      edits: [
        insertLinesBefore(site.loop, [
          `const ${groups} = await ${textOf(delegate)}.groupBy({ by: ['${key.field}'], where: ${condition}, ${extra} });`,
          `const ${byKey} = new Map(${groups}.map((row) => [row.${key.field}, ${value}]${asConst(sourceFile)}));`,
        ]),
        replaceNode(site.awaited, inSlot(site.awaited, `${byKey}.get(${textOf(key.value)}) ?? ${empty}`)),
      ],
      note: joinNotes([mapKeyNote, ...workNotes]),
    };
  }
  const allowed = new Set(mode === 'list' ? ['select', 'include', 'orderBy'] : ['select', 'include']);
  const others = invariantOptions(options, site, allowed);
  const selectProperty = options.get('select');
  const select = selectProperty && selectingKey(selectProperty, key.field);
  if (!others || (selectProperty && !select)) return;
  if (select?.added) others.set('select', select.text);
  const fetchLine = `${textOf(delegate)}.findMany({ ${[`where: ${condition}`, ...others.values()].join(', ')} })`;
  if (mode === 'list')
    return groupedLookup({
      site,
      sourceFile,
      rowsBase: plural(model),
      rowName: model,
      field: key.field,
      keyValue: key.value,
      fetchLine,
      note: joinNotes([
        groupedKeyNote,
        !ownIdKey(key.value) && nullKeyNote,
        select?.added && `The select now also reads \`${key.field}\` to group rows by item.`,
        ...workNotes,
      ]),
    });
  const unique = call.expression.name.text === 'findUnique' || key.field === 'id';
  return keyedLookup({
    site,
    sourceFile,
    rowsBase: plural(model),
    rowName: model,
    field: key.field,
    keyValue: key.value,
    fetchLine,
    note: joinNotes([
      mapKeyNote,
      !unique && duplicateKeyNote,
      select?.added && `The select now also reads \`${key.field}\` to match rows to items.`,
      ...workNotes,
    ]),
  });
}

// `data: { ... }` holding only scalar values; nested objects may be relation writes createMany
// cannot run.
function flatData(options: Expression | undefined): ObjectLiteralExpression | undefined {
  const properties = plainProperties(options);
  const data = properties?.size === 1 && properties.get('data');
  if (!data || !ts.isPropertyAssignment(data) || !ts.isObjectLiteralExpression(data.initializer)) return;
  const nested = someNode(
    data.initializer,
    (node: Node) =>
      node !== data.initializer &&
      (ts.isObjectLiteralExpression(node) || ts.isFunctionLike(node) || ts.isAwaitExpression(node)),
  );
  return nested ? undefined : data.initializer;
}

const createManyNote =
  'createMany inserts every row in one statement: it returns only a count, runs no nested writes, and one failing row now rejects the whole batch.';

function reindent(text: string, from: string, to: string): string {
  return text
    .split('\n')
    .map((line, index) => (index > 0 && line.startsWith(from) ? to + line.slice(from.length) : line))
    .join('\n');
}

function prismaCreateMany(call: MethodCall): FixResult | undefined {
  const delegate = call.expression.expression;
  const data = call.arguments.length === 1 && flatData(call.arguments[0]);
  if (!ts.isPropertyAccessExpression(delegate) || !isPlainReference(delegate) || !data) return;
  const createMany = (items: string) => `await ${textOf(delegate)}.createMany({ data: ${items} })`;
  const iteration = enclosingIteration(call);
  if (iteration?.kind === 'callback') return prismaCreateManyFromMap(call, iteration, data, createMany);
  const site = loopWrite(call);
  if (!site || !readsOnlyNames(data, site.names, site.locals)) return;
  const edits = wrapLoop(
    {
      site,
      inner: data,
    },
    (items) => `${createMany(items)};`,
    ['(', ')'],
    `await ${textOf(delegate)}.createMany({ data: `,
    ' });',
  );
  return edits && { edits, note: createManyNote };
}

// A for-of whose whole body is one awaited write with an unused result.
function loopWrite(call: CallExpression): LoopWrite | undefined {
  const iteration = enclosingIteration(call);
  const site = iteration?.kind === 'loop' && forOfBinding(iteration.node);
  if (!site) return;
  const body = site.loop.statement;
  const statement = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : body;
  if (
    !ts.isExpressionStatement(statement) ||
    statement.expression !== call.parent ||
    !ts.isAwaitExpression(call.parent)
  )
    return;
  return { ...site, statement };
}

// Replaces the loop with one call over every item: whole when short, else only its head and tail so
// the per-item text between keeps its lines (one level deeper than the new code expects).
function wrapLoop(
  { site, inner }: { site: LoopWrite; inner: Node },
  whole: (items: string) => string,
  [innerOpen, innerClose]: readonly [string, string],
  head: string,
  tail: string,
): TextEdit[] | undefined {
  // Only the per-item text survives the rewrite, so a comment elsewhere in the loop would be
  // silently dropped.
  const text = site.loop.getSourceFile().text;
  if (hasCommentBetween(text, site.loop.getStart(), inner.getStart())) return;
  if (hasCommentBetween(text, inner.end, site.loop.end)) return;
  const loopText = textOf(site.loop);
  const innerText = reindent(textOf(inner), indentationOf(site.statement), indentationOf(site.loop));
  const items = mapItems(site, innerText);
  if (loopText.split('\n').length <= 6) return [replaceNode(site.loop, whole(items))];
  const [open, close] = mapParts(site, textOf(inner));
  return [
    { start: site.loop.getStart(), end: inner.getStart(), text: `${head}${open}${innerOpen}` },
    { start: inner.end, end: site.loop.end, text: `${innerClose}${close}${tail}` },
  ];
}

const transactionNote =
  'The writes now run in one transaction: if one fails, the earlier ones roll back instead of staying applied.';
const prismaWriteMethods = new Set(['create', 'update', 'upsert', 'delete']);

// The client of `client.model.method(...)` when it can open a batch transaction (not an interactive
// `tx`).
function prismaClientOf(delegate: Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(delegate) || !isPlainReference(delegate)) return;
  const client = delegate.expression;
  const name = ts.isPropertyAccessExpression(client) ? client.name.text : textOf(client);
  if (/prisma/i.test(name)) return textOf(client);
}

// Per-item Prisma writes become one `$transaction([...])`: one round trip to the engine and one
// database transaction.
function prismaWriteTransaction(call: MethodCall): FixResult | undefined {
  const client = prismaClientOf(call.expression.expression);
  if (!client) return;
  const iteration = enclosingIteration(call);
  if (iteration?.kind === 'callback') {
    const { node: mapCall, callback, method } = iteration;
    const all = mapCall.parent;
    if (
      method !== 'map' ||
      !ts.isArrowFunction(callback) ||
      callback.body !== call ||
      callback.modifiers?.length ||
      !ts.isCallExpression(all) ||
      textOf(all.expression) !== 'Promise.all' ||
      all.arguments.length !== 1 ||
      all.arguments[0] !== mapCall
    )
      return;
    return { edits: [replaceNode(all.expression, `${client}.$transaction`)], note: transactionNote };
  }
  const site = loopWrite(call);
  if (!site || call.arguments.some((argument: Expression) => !readsOnlyNames(argument, site.names, site.locals)))
    return;
  const transaction = (items: string) => `await ${client}.$transaction(${items});`;
  const edits = wrapLoop({ site, inner: call }, transaction, ['', ''], `await ${client}.$transaction(`, ');');
  return edits && { edits, note: transactionNote };
}

// The callback's whole job is the create: `(item) => db.m.create(...)` or a block that only awaits
// or returns it.
function onlyCreates(callback: ArrowFunction, call: CallExpression): boolean {
  const outer = ts.isAwaitExpression(call.parent) ? call.parent : call;
  if (callback.body === outer) return true;
  if (!ts.isBlock(callback.body) || callback.body.statements.length !== 1) return false;
  const [statement] = callback.body.statements;
  return (
    (ts.isExpressionStatement(statement) && statement.expression === outer && outer !== call) ||
    (ts.isReturnStatement(statement) && statement.expression === outer)
  );
}

function prismaCreateManyFromMap(
  call: CallExpression,
  iteration: CallbackIteration,
  data: ObjectLiteralExpression,
  createMany: (items: string) => string,
): FixResult | undefined {
  const { node: mapCall, callback, method } = iteration;
  const all = mapCall.parent;
  const awaited = all?.parent;
  if (
    method !== 'map' ||
    !ts.isArrowFunction(callback) ||
    callback.parameters.length !== 1 ||
    !ts.isIdentifier(callback.parameters[0].name) ||
    callback.parameters[0].initializer ||
    callback.parameters[0].dotDotDotToken ||
    mapCall.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(mapCall.expression) ||
    !isPlainReference(mapCall.expression.expression) ||
    !onlyCreates(callback, call) ||
    !ts.isCallExpression(all) ||
    textOf(all.expression) !== 'Promise.all' ||
    all.arguments.length !== 1 ||
    !ts.isAwaitExpression(awaited) ||
    !ts.isExpressionStatement(awaited.parent)
  )
    return;
  const parameter = callback.parameters[0].name.text;
  if (!readsOnly(data, parameter, localNames(callback.body))) return;
  const items = `${textOf(mapCall.expression)}((${textOf(callback.parameters[0])}) => (${textOf(data)}))`;
  return { edits: [replaceNode(awaited, createMany(items))], note: createManyNote };
}

export function prismaQueryInLoop({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const call = calleeCall(node);
  if (!call || !isMethodCall(call)) return;
  const method = call.expression.name.text;
  if (prismaWriteMethods.has(method)) {
    const createMany = method === 'create' ? prismaCreateMany(call) : undefined;
    return createMany ?? prismaWriteTransaction(call);
  }
  if (prismaModes[method]) return prismaLookup(call, sourceFile);
}
