// pg per-item key lookups and Redis per-item commands inside loops (GET to MGET, DEL and SET
// batched) rewritten into one round trip.
import {
  ts,
  textOf,
  replaceNode,
  calleeCall,
  enclosingIteration,
  insertLinesBefore,
  isPlainReference,
} from './helpers.cjs';
import { isMethodCall } from './method-calls.cjs';
import type { ArrowFunction, CallExpression, Expression, Node, SourceFile } from 'typescript';
import {
  outerParentheses,
  inSlot,
  readsOnly,
  readsOnlyNames,
  indentationOf,
  singleLineLiteral,
} from './query-loop-nodes.cjs';
import { capitalized, camelCase, usableName, asConst } from './query-loop-names.cjs';
import { loopSite, loopLookup, inlinedLocal, itemKeys, loopWorkNote } from './query-loop-sites.cjs';
import { mapCollection } from './query-loop-collections.cjs';
import type { MethodCall } from '../types/method-call.cjs';
import type { FixResult, SiteFixInput } from '../../shared/types.cjs';

/** How the loop reads the pg result, and what replaces that read. */
interface PgRowsUse {
  target: Node;
  text: (lookup: string) => string;
}

/** `items.map((item) => redis.command(...))` handed to `Promise.all`. */
interface MappedRedisCommands {
  mapCall: MethodCall;
  callback: ArrowFunction;
  all: CallExpression;
  client: string;
  parameter: string;
}

const sqlName = '[a-z_][a-z0-9_$]*';
const sqlQualifiedName = `${sqlName}(?:\\.${sqlName})?`;
const keyLookupSql = new RegExp(
  `^(\\s*select\\s+(\\*|${sqlQualifiedName}(?:\\s*,\\s*${sqlQualifiedName})*)\\s+from\\s+(${sqlQualifiedName})` +
    `\\s+where\\s+(${sqlQualifiedName})\\s*=\\s*)\\$1(\\s*;?\\s*)$`,
  'i',
);

// How the loop reads the pg result: `const { rows } = await ...` or `(await ...).rows`.
function pgRowsUse(awaited: Expression): PgRowsUse | undefined {
  const parent = awaited.parent;
  if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
    const [element, ...rest] = parent.name.elements;
    if (rest.length || element.dotDotDotToken || element.initializer || !ts.isIdentifier(element.name)) return;
    const exportedName = element.propertyName ?? element.name;
    if (!(ts.isIdentifier(exportedName) || ts.isStringLiteral(exportedName)) || exportedName.text !== 'rows') return;
    const boundName = element.name.text;
    return { target: parent, text: (lookup: string) => `${boundName} = ${lookup}` };
  }
  const outer = outerParentheses(awaited);
  const access = outer.parent;
  if (outer !== awaited && ts.isPropertyAccessExpression(access) && access.name.text === 'rows')
    return { target: access, text: (lookup: string) => inSlot(access, lookup) };
}

function lastSegment(qualifiedName: string): string {
  const segments = qualifiedName.split('.');
  return segments[segments.length - 1];
}

export function pgQueryInLoop({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const call = calleeCall(node);
  if (!call || !isMethodCall(call) || call.arguments.length !== 2) return;
  const [query, parameters] = call.arguments;
  if (!singleLineLiteral(query) || !ts.isArrayLiteralExpression(parameters) || parameters.elements.length !== 1) return;
  const match = keyLookupSql.exec(query.text);
  const key = parameters.elements[0];
  if (!match || ts.isSpreadElement(key)) return;
  const site = loopSite(call);
  const use = site && pgRowsUse(site.awaited);
  if (!site || !use || !readsOnly(key, site.loopVariable, site.locals)?.usesLoopVariable) return;
  const [, head, projection, table, column, tail] = match;
  const field = lastSegment(column).toLowerCase();
  const projected =
    projection === '*' || projection.split(',').some((name) => lastSegment(name.trim()).toLowerCase() === field);
  const keys = mapCollection(site.loop.expression, site.loopVariable, textOf(key));
  const rows = usableName(sourceFile, camelCase(lastSegment(table).toLowerCase()));
  const byKey = rows && usableName(sourceFile, `${rows}By${capitalized(camelCase(field))}`);
  if (!projected || !keys || !byKey) return;
  const quote = textOf(query)[0];
  const batched = `${quote}${head}ANY($1)${tail}${quote}`;
  const groupKey = `String(row.${field})`;
  return {
    edits: [
      insertLinesBefore(site.loop, [
        `const { rows: ${rows} } = await ${textOf(call.expression)}(${batched}, [${keys}]);`,
        `const ${byKey} = new Map();`,
        `for (const row of ${rows}) ${byKey}.set(${groupKey}, [...(${byKey}.get(${groupKey}) ?? []), row]);`,
      ]),
      replaceNode(use.target, use.text(`${byKey}.get(String(${textOf(key)})) ?? []`)),
    ],
    note: 'Rows are grouped by String(key) because pg returns bigint and numeric columns as strings; check date or case-insensitive keys.',
  };
}

function redisBatchMethod(message: string): 'mGet' | 'mget' | undefined {
  if (message?.includes('.mGet(')) return 'mGet';
  if (message?.includes('.mget(')) return 'mget';
}

const redisWriteNote =
  'Values are now read once before the loop, so a value the loop itself writes is not seen by a later item that reads the same key.';

function redisGetInLoop(call: MethodCall, batch: string, sourceFile: SourceFile): FixResult | undefined {
  const client = call.expression.expression;
  if (call.arguments.length !== 1) return;
  const key = call.arguments[0];
  if (ts.isSpreadElement(key) || !isPlainReference(client)) return;
  const site = loopLookup(call);
  if (!site) return;
  const reads = readsOnlyNames(key, site.names, site.locals);
  const local = !reads && ts.isIdentifier(key) ? inlinedLocal(key, site) : undefined;
  if (!(reads?.usesLoopVariable || local)) return;
  const keyList = itemKeys(site, { perItem: local || key });
  const workNotes = keyList && loopWorkNote(site, textOf(client), undefined, local || key);
  if (!keyList || !workNotes) return;
  const declared = site.awaited.parent;
  const base = ts.isVariableDeclaration(declared) && ts.isIdentifier(declared.name) ? declared.name.text : 'cached';
  const keys = usableName(sourceFile, 'keys');
  const values = keys && usableName(sourceFile, 'values');
  const byKey = values && usableName(sourceFile, `${base}ByKey`);
  if (!byKey) return;
  return {
    edits: [
      insertLinesBefore(site.loop, [
        `const ${keys} = ${keyList};`,
        // MGET with no keys is a Redis error, while the loop simply ran zero times.
        `const ${values} = ${keys}.length ? await ${textOf(client)}.${batch}(${keys}) : [];`,
        `const ${byKey} = new Map(${keys}.map((key, index) => [key, ${values}[index]]${asConst(sourceFile)}));`,
      ]),
      replaceNode(site.awaited, inSlot(site.awaited, `${byKey}.get(${textOf(key)}) ?? null`)),
    ],
    ...(workNotes.length ? { note: redisWriteNote } : {}),
  };
}

// `Promise.all(items.map((item) => redis.command(...)))`: the mapped call, its client and the
// Promise.all.
function mappedRedisCommands(call: MethodCall): MappedRedisCommands | undefined {
  const iteration = enclosingIteration(call);
  if (iteration?.kind !== 'callback') return;
  const { node: mapCall, callback, method } = iteration;
  const all = mapCall.parent;
  const client = call.expression.expression;
  if (
    method !== 'map' ||
    !ts.isArrowFunction(callback) ||
    callback.body !== call ||
    callback.modifiers?.length ||
    callback.parameters.length !== 1 ||
    !ts.isIdentifier(callback.parameters[0].name) ||
    !isMethodCall(mapCall) ||
    !isPlainReference(client) ||
    !ts.isCallExpression(all) ||
    textOf(all.expression) !== 'Promise.all' ||
    all.arguments.length !== 1 ||
    all.arguments[0] !== mapCall ||
    call.arguments.some(ts.isSpreadElement)
  )
    return;
  return { mapCall, callback, all, client: textOf(client), parameter: callback.parameters[0].name.text };
}

// Awaited `Promise.all` of DELs as a statement becomes one variadic DEL, skipped when there is
// nothing to delete.
function redisDelAll(call: MethodCall, sourceFile: SourceFile): FixResult | undefined {
  const mapped = mappedRedisCommands(call);
  if (!mapped) return;
  const awaited = mapped.all.parent;
  if (!ts.isAwaitExpression(awaited) || !ts.isExpressionStatement(awaited.parent)) return;
  // Two statements replace one, which only a block (not an `if` or loop body) can hold.
  if (!ts.isBlock(awaited.parent.parent) && !ts.isSourceFile(awaited.parent.parent)) return;
  if (call.arguments.length !== 1) return;
  const [key] = call.arguments;
  const collection = textOf(mapped.mapCall.expression.expression);
  const keyText = textOf(key);
  const list = keyText === mapped.parameter ? collection : `${collection}.map((${mapped.parameter}) => ${keyText})`;
  const keys = usableName(sourceFile, 'keysToDelete');
  if (!keys) return;
  return {
    edits: [
      replaceNode(
        awaited.parent,
        `const ${keys} = ${list};\n${indentationOf(awaited.parent)}if (${keys}.length) await ${mapped.client}.del(...${keys});`,
      ),
    ],
    note: 'On Redis Cluster every key must hash to the same slot (use a {hash tag}), or keep one DEL per slot.',
  };
}

// `Promise.all` of SETs becomes one ioredis pipeline that still rejects on the first failed reply.
function redisSetPipeline(call: MethodCall): FixResult | undefined {
  const mapped = mappedRedisCommands(call);
  if (!mapped || call.arguments.length < 2) return;
  const collection = textOf(mapped.mapCall.expression.expression);
  const stringArgument = call.arguments.find(ts.isStringLiteral);
  const quote = stringArgument ? textOf(stringArgument)[0] : "'";
  const command = `[${quote}set${quote}, ${call.arguments.map(textOf).join(', ')}]`;
  const replies = `(replies ?? []).map(([error, reply]) => { if (error) throw error; return reply; })`;
  const pipeline = `${mapped.client}.pipeline(${collection}.map((${mapped.parameter}) => ${command})).exec().then((replies) => ${replies})`;
  return {
    edits: [replaceNode(mapped.all, pipeline)],
    note: 'A pipeline sends every command in one round trip; it resolves to unknown[] replies, so retype any use of the result.',
  };
}

export function redisCommandInLoop({ node, finding, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const call = calleeCall(node);
  if (!call || !isMethodCall(call)) return;
  const command = call.expression.name.text;
  const batch = redisBatchMethod(finding.message);
  if (command === 'get' && batch) return redisGetInLoop(call, batch, sourceFile);
  if (command === 'del' && finding.message?.includes('.del(...keys)')) return redisDelAll(call, sourceFile);
  if (command === 'set' && finding.message?.includes('.pipeline()') && finding.message.includes('.mset('))
    return redisSetPipeline(call);
}
