'use strict';

// Rewrites per-item Drizzle, Mongoose and Sequelize reads in a for-of into one batched read indexed in a Map, and
// per-item push or mail sends into the provider's batch call. Any shape not proven safe is left to the rule example.
const { ts, textOf, replaceNode, calleeCall, freshName, isPlainReference } = require('./helpers.cjs');
const {
  someNode,
  loopLookup,
  forOfBinding,
  itemKeyFilter,
  itemKeys,
  inlinedLocal,
  loopWorkNote,
  keyedLookup,
  groupedLookup,
  whereWith,
  invariantOptions,
  plainProperties,
  readsOnlyNames,
  mapItems,
  usableName,
  capitalized,
  plural,
  ownIdKey,
  mentions,
  joinNotes,
  textWith,
  indentationOf,
  indentationStep,
  mapKeyNote,
  groupedKeyNote,
  nullKeyNote,
  duplicateKeyNote,
  typeormQueryInLoop,
} = require('./query-loops.cjs').shared;

// ---- shared ----

function namedImports(declaration) {
  const clause = declaration.importClause;
  const bindings = clause?.namedBindings;
  if (!clause || clause.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) return;
  return bindings;
}

function importedElement(bindings, exported) {
  return bindings.elements.find((element) => (element.propertyName ?? element.name).text === exported);
}

// The local name of `exported` from the named import `bindings`, adding it to that import when it is missing.
function importedName(sourceFile, bindings, exported) {
  const existing = importedElement(bindings, exported);
  if (existing) return existing.isTypeOnly ? undefined : { name: existing.name.text, edits: [] };
  if (freshName(sourceFile, exported) !== exported || !bindings.elements.length) return;
  const last = bindings.elements.at(-1);
  return { name: exported, edits: [{ start: last.end, end: last.end, text: `, ${exported}` }] };
}

// The key of a single-argument lookup such as `findById(item.id)`, shaped like itemKeyFilter's result.
function argumentKey(value, site, field) {
  const reads = readsOnlyNames(value, site.names, site.locals);
  const local = !reads && ts.isIdentifier(value) && inlinedLocal(value, site);
  if (!local && !reads?.usesLoopVariable) return;
  return { field, value, perItem: local || value };
}

// Row names for a model or table: `User` or `UserModel` reads as `users` and `user`.
function modelNames(name) {
  const base = name.replace(/Model$/, '');
  if (!base) return { rowsBase: 'rows', rowName: 'row' };
  const lowered = base[0].toLowerCase() + base.slice(1);
  if (lowered.endsWith('s')) return { rowsBase: lowered, rowName: 'row' };
  if (ts.stringToToken(lowered) !== undefined) return { rowsBase: plural(lowered), rowName: 'row' };
  return { rowsBase: plural(lowered), rowName: lowered };
}

function usesLocal(node, site) {
  return someNode(node, (inner) => ts.isIdentifier(inner) && site.locals.has(inner.text));
}

// ---- drizzle-query-in-loop ----

const emptyKeysNote = 'The query is skipped when there are no keys, since older Drizzle versions reject an empty list.';

// The outermost call of the chain whose method name the finding points at.
function chainTop(node) {
  let current = node;
  if (ts.isPropertyAccessExpression(current.parent) && current.parent.name === current) current = current.parent;
  for (;;) {
    const parent = current.parent;
    const continues =
      (ts.isPropertyAccessExpression(parent) && parent.expression === current) ||
      (ts.isCallExpression(parent) && parent.expression === current);
    if (!continues) break;
    current = parent;
  }
  return ts.isCallExpression(current) ? current : undefined;
}

// `eq(table.column, key)` with `eq` imported by name, and the import that holds it.
function eqCondition(expression, sourceFile) {
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return;
  if (expression.arguments.length !== 2) return;
  const [column, value] = expression.arguments;
  if (!ts.isPropertyAccessExpression(column) || !ts.isIdentifier(column.expression)) return;
  for (const statement of sourceFile.statements) {
    const bindings = ts.isImportDeclaration(statement) && namedImports(statement);
    const element = bindings && importedElement(bindings, 'eq');
    if (element && !element.isTypeOnly && element.name.text === expression.expression.text)
      return { call: expression, column, table: column.expression.text, field: column.name.text, value, bindings };
  }
}

// `db.select().from(table).where(eq(...))`, read per item as a list.
function drizzleSelect(top, sourceFile) {
  const where = top.expression;
  if (!ts.isPropertyAccessExpression(where) || where.name.text !== 'where' || top.arguments.length !== 1) return;
  const from = where.expression;
  if (!ts.isCallExpression(from) || !ts.isPropertyAccessExpression(from.expression)) return;
  if (from.expression.name.text !== 'from' || from.arguments.length !== 1) return;
  const select = from.expression.expression;
  // Selected fields would rename the row's properties, so only the whole row is batched.
  if (!ts.isCallExpression(select) || select.arguments.length || !ts.isPropertyAccessExpression(select.expression))
    return;
  if (select.expression.name.text !== 'select' || !isPlainReference(select.expression.expression)) return;
  const condition = eqCondition(top.arguments[0], sourceFile);
  if (!condition || textOf(from.arguments[0]) !== condition.table) return;
  return { mode: 'list', database: select.expression.expression, condition, renames: [] };
}

const drizzleRelationalModes = { findFirst: 'one', findMany: 'list' };
const drizzleRelationalOptions = { one: new Set(['with']), list: new Set(['with', 'orderBy']) };

// `db.query.table.findFirst({ where: eq(...) })` or findMany, with the other options the same for every item.
function drizzleRelational(top, sourceFile, site) {
  const access = top.expression;
  if (!ts.isPropertyAccessExpression(access) || top.arguments.length !== 1) return;
  const mode = drizzleRelationalModes[access.name.text];
  if (!mode || !isPlainReference(access.expression)) return;
  const options = plainProperties(top.arguments[0]);
  const where = options?.get('where');
  if (!where || !ts.isPropertyAssignment(where)) return;
  const condition = eqCondition(where.initializer, sourceFile);
  if (!condition || !invariantOptions(options, site, drizzleRelationalOptions[mode])) return;
  const renames = mode === 'one' ? [{ start: access.name.getStart(), end: access.name.end, text: 'findMany' }] : [];
  return { mode, database: access.expression, condition, renames };
}

function drizzleQueryInLoop({ node, sourceFile }) {
  const top = chainTop(node);
  const site = top && loopLookup(top);
  if (!site) return;
  const query = drizzleSelect(top, sourceFile) ?? drizzleRelational(top, sourceFile, site);
  if (!query || usesLocal(query.database, site) || site.locals.has(query.condition.table)) return;
  const { condition } = query;
  const key = argumentKey(condition.value, site, condition.field);
  const keys = key && itemKeys(site, key);
  const inArray = keys && importedName(sourceFile, condition.bindings, 'inArray');
  const root = textOf(query.database).split('.')[0];
  // Drizzle writes are chains the shared work check cannot see into, so any other await on the same client stays.
  const otherUse = [...site.earlierAwaits, ...site.laterAwaits].some((awaited) => mentions(textOf(awaited), root));
  const workNotes = inArray && !otherUse && loopWorkNote(site, textOf(query.database), undefined, key.perItem);
  if (!workNotes) return;
  const singular = condition.table.replace(/s$/, '');
  const rowName = ts.stringToToken(singular) === undefined ? singular : 'row';
  const keysName = usableName(sourceFile, `${singular}${capitalized(plural(condition.field))}`);
  if (!keysName) return;
  const batched = `${inArray.name}(${textOf(condition.column)}, ${keysName})`;
  const fetchText = textWith(top, [...query.renames, replaceNode(condition.call, batched)]);
  const lookup = {
    site,
    sourceFile,
    rowsBase: `${singular}Rows`,
    rowName,
    field: condition.field,
    keyValue: key.value,
    setup: [`const ${keysName} = ${keys};`],
    fetched: `${keysName}.length ? await ${fetchText} : []`,
  };
  const unique = condition.field === 'id';
  const fix =
    query.mode === 'list'
      ? groupedLookup({ ...lookup, note: joinNotes([groupedKeyNote, emptyKeysNote, ...workNotes]) })
      : keyedLookup({
          ...lookup,
          note: joinNotes([mapKeyNote, !unique && duplicateKeyNote, emptyKeysNote, ...workNotes]),
        });
  return fix && { edits: [...fix.edits, ...inArray.edits], note: fix.note };
}

// ---- orm-query-in-loop: Mongoose and Sequelize ----

const mongooseModes = { findOne: 'one', findById: 'one', find: 'list' };
const mongooseChained = new Set(['lean', 'exec']);
const mongooseNote =
  'Documents are matched by String(key), so ObjectId and string keys meet; check keys of other types, and that the projection or `lean()` still returns the key field.';

// The read and the call the loop awaits: `Model.findOne(filter)`, optionally followed by `.lean()` or `.exec()`.
function mongooseCall(node) {
  const outer = calleeCall(node);
  if (!outer || !ts.isPropertyAccessExpression(outer.expression)) return;
  let inner = outer;
  if (mongooseChained.has(outer.expression.name.text) && !outer.arguments.length) {
    const chained = outer.expression.expression;
    if (!ts.isCallExpression(chained) || !ts.isPropertyAccessExpression(chained.expression)) return;
    inner = chained;
  }
  return { outer, inner };
}

function mongooseLookup({ node, sourceFile }) {
  const calls = mongooseCall(node);
  if (!calls) return;
  const { outer, inner } = calls;
  const method = inner.expression.name.text;
  const model = inner.expression.expression;
  const mode = mongooseModes[method];
  if (!mode || inner.arguments.length !== 1 || !isPlainReference(model)) return;
  const site = loopLookup(outer);
  if (!site || usesLocal(model, site)) return;
  const [argument] = inner.arguments;
  const key = method === 'findById' ? argumentKey(argument, site, '_id') : itemKeyFilter(argument, site);
  const keys = key && itemKeys(site, key);
  const workNotes = keys && loopWorkNote(site, textOf(model), undefined, key.perItem);
  if (!workNotes) return;
  const filter = key.properties ? whereWith(key, `{ $in: ${keys} }`) : `{ _id: { $in: ${keys} } }`;
  const edits = [replaceNode(argument, filter)];
  if (method !== 'find')
    edits.push({ start: inner.expression.name.getStart(), end: inner.expression.name.end, text: 'find' });
  const lookup = {
    site,
    sourceFile,
    ...modelNames(textOf(model).split('.').at(-1)),
    field: key.field,
    keyValue: key.value,
    fetchLine: textWith(outer, edits),
    keyOf: (text) => `String(${text})`,
  };
  const nullNote = !ownIdKey(key.value) && key.field !== '_id' && nullKeyNote;
  const fix =
    mode === 'list'
      ? groupedLookup({ ...lookup, note: joinNotes([mongooseNote, nullNote, ...workNotes]) })
      : keyedLookup({
          ...lookup,
          note: joinNotes([mongooseNote, key.field !== '_id' && duplicateKeyNote, nullNote, ...workNotes]),
        });
  return fix && { ...fix, requiresReview: true };
}

const sequelizeModes = { findOne: 'one', findAll: 'list' };
const sequelizeOptions = {
  one: new Set(['include', 'raw', 'paranoid']),
  list: new Set(['include', 'raw', 'paranoid', 'order']),
};
const sequelizeKeyNote =
  'Rows are matched through a Map, so the key must be a string or number of the same type the column comes back as (BIGINT and DECIMAL columns often come back as strings).';

// Sequelize's `Op`, only through a named import from `sequelize` the file already has.
function sequelizeOp(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'sequelize') continue;
    const bindings = namedImports(statement);
    if (bindings) return importedName(sourceFile, bindings, 'Op');
  }
}

function sequelizeLookup({ node, sourceFile }) {
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.arguments.length !== 1) return;
  const mode = sequelizeModes[call.expression.name.text];
  const model = call.expression.expression;
  if (!mode || !isPlainReference(model)) return;
  const site = loopLookup(call);
  const options = site && !usesLocal(model, site) && plainProperties(call.arguments[0]);
  const where = options?.get('where');
  if (!where || !ts.isPropertyAssignment(where)) return;
  const key = itemKeyFilter(where.initializer, site);
  const others = key && invariantOptions(options, site, sequelizeOptions[mode]);
  const keys = others && itemKeys(site, key);
  const operator = keys && sequelizeOp(sourceFile);
  const workNotes = operator && loopWorkNote(site, textOf(model), undefined, key.perItem);
  if (!workNotes) return;
  const condition = whereWith(key, `{ [${operator.name}.in]: ${keys} }`);
  const lookup = {
    site,
    sourceFile,
    ...modelNames(textOf(model).split('.').at(-1)),
    field: key.field,
    keyValue: key.value,
    fetchLine: `${textOf(model)}.findAll({ ${[`where: ${condition}`, ...others.values()].join(', ')} })`,
  };
  const nullNote = !ownIdKey(key.value) && nullKeyNote;
  const fix =
    mode === 'list'
      ? groupedLookup({ ...lookup, note: joinNotes([groupedKeyNote, nullNote, ...workNotes]) })
      : keyedLookup({
          ...lookup,
          note: joinNotes([sequelizeKeyNote, key.field !== 'id' && duplicateKeyNote, nullNote, ...workNotes]),
        });
  return fix && { edits: [...fix.edits, ...operator.edits], note: fix.note };
}

function ormQueryInLoop(input) {
  const message = input.finding.message ?? '';
  if (message.startsWith('Mongoose ')) return mongooseLookup(input);
  if (message.startsWith('Sequelize.')) return sequelizeLookup(input);
  return typeormQueryInLoop(input);
}

// ---- notification-send-in-loop ----

// Firebase `sendEach` takes at most 500 messages; SendGrid sends an array as concurrent requests, so it is bounded.
const firebaseBatchSize = 500;
const sendgridBatchSize = 1000;
const sendProviders = [
  {
    label: 'firebase-admin messaging',
    method: 'send',
    batchMethod: 'sendEach',
    batchSize: firebaseBatchSize,
    note: 'Messages now go out through sendEach in batches of 500, which resolves with a per-message BatchResponse instead of rejecting: a bad token no longer throws or stops the remaining sends, so check `failureCount` if failures matter.',
  },
  {
    label: '@sendgrid/mail',
    method: 'send',
    batchMethod: 'send',
    batchSize: sendgridBatchSize,
    note: 'An array is sent as concurrent requests, up to 1000 at a time: messages no longer go out one after another, and one failing message rejects the call while the others in its batch may still be sent.',
  },
  {
    label: 'expo-server-sdk',
    method: 'sendPushNotificationsAsync',
    chunked: true,
    note: 'Messages now go out in Expo chunks of up to 100 per request: a failed request loses its whole chunk and stops later chunks, and per-message errors still come back only as tickets.',
  },
];

// `messaging`, `expo` or `getMessaging()`: a sender that is the same for every item.
function plainSender(receiver) {
  if (isPlainReference(receiver)) return true;
  return ts.isCallExpression(receiver) && !receiver.arguments.length && isPlainReference(receiver.expression);
}

// The message object the send takes, or undefined when the call does not take exactly one.
function sentMessage(call, provider) {
  if (call.arguments.length !== 1) return;
  const [argument] = call.arguments;
  if (!provider.chunked) return ts.isObjectLiteralExpression(argument) ? argument : undefined;
  if (!ts.isArrayLiteralExpression(argument) || argument.elements.length !== 1) return;
  const [element] = argument.elements;
  return ts.isObjectLiteralExpression(element) ? element : undefined;
}

// A for-of whose whole body is `await sender.send(message);`, so nothing else depends on each send or its result.
function sendLoop(call) {
  const awaited = call.parent;
  const statement = awaited?.parent;
  if (!ts.isAwaitExpression(awaited) || !ts.isExpressionStatement(statement)) return;
  const body = ts.isBlock(statement.parent) && statement.parent.statements.length === 1 ? statement.parent : statement;
  const loop = body.parent;
  return ts.isForOfStatement(loop) && loop.statement === body ? forOfBinding(loop) : undefined;
}

function notificationSendInLoop({ node, finding, sourceFile }) {
  const message = finding.message ?? '';
  const provider = sendProviders.find((candidate) => message.includes(`one ${candidate.label} message per item, so`));
  const call = provider && calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== provider.method) return;
  const receiver = call.expression.expression;
  const payload = sentMessage(call, provider);
  const binding = payload && plainSender(receiver) && sendLoop(call);
  if (!binding) return;
  const receiverReads = readsOnlyNames(receiver, binding.names, binding.locals);
  if (!receiverReads || receiverReads.usesLoopVariable || !readsOnlyNames(payload, binding.names, binding.locals))
    return;
  const sender = textOf(receiver);
  const indentation = indentationOf(binding.loop);
  const step = indentationStep(binding.loop);
  const payloadText = textOf(payload);
  let lines;
  if (provider.chunked) {
    const chunk = usableName(sourceFile, 'chunk');
    if (!chunk) return;
    lines = [
      `for (const ${chunk} of ${sender}.chunkPushNotifications(${mapItems(binding, payloadText)})) {`,
      `${step}await ${sender}.${provider.method}(${chunk});`,
      '}',
    ];
  } else {
    // The batch is sliced straight from the list so the send keeps typing each message in place.
    const start = binding.source.kind === 'array' && !binding.source.method && usableName(sourceFile, 'start');
    if (!start) return;
    const items = binding.source.text;
    const slice = `${items}.slice(${start}, ${start} + ${provider.batchSize})`;
    const batch = mapItems({ ...binding, source: { ...binding.source, text: slice } }, payloadText);
    lines = [
      `for (let ${start} = 0; ${start} < ${items}.length; ${start} += ${provider.batchSize}) {`,
      `${step}await ${sender}.${provider.batchMethod}(${batch});`,
      '}',
    ];
  }
  const text = lines.map((line, index) => (index ? indentation + line : line)).join('\n');
  return { edits: [replaceNode(binding.loop, text)], note: provider.note, requiresReview: true };
}

module.exports = {
  'drizzle-query-in-loop': drizzleQueryInLoop,
  'orm-query-in-loop': ormQueryInLoop,
  'notification-send-in-loop': notificationSendInLoop,
};
