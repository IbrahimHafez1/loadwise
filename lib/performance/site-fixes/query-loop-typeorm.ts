// TypeORM per-item rewrites: find, findOne, exists and count inside a loop, and the same reads
// mapped through Promise.all, become one query with `In(...)`.
import { ts, textOf, replaceNode, calleeCall, insertLinesBefore, freshName, isPlainReference } from './helpers.js';
import { isMethodCall } from './method-calls.js';
import type {
  AwaitExpression,
  CallExpression,
  Expression,
  ImportDeclaration,
  Node,
  ObjectLiteralElementLike,
  SourceFile,
} from 'typescript';
import { someNode, outerParentheses, startsLine, inSlot, mentions, plainProperties } from './query-loop-nodes.js';
import { plural, capitalized, usableName, asConst, rowsName } from './query-loop-names.js';
import { loopLookup, itemKeyFilter, itemKeys, loopWorkNote } from './query-loop-sites.js';
import { collectionKind } from './query-loop-collections.js';
import {
  keyedLookup,
  groupedLookup,
  groupedKeyNote,
  nullKeyNote,
  ownIdKey,
  mapKeyNote,
  setKeyNote,
  duplicateKeyNote,
  joinNotes,
  invariantOptions,
  whereWith,
} from './query-loop-lookups.js';
import type { MethodCall } from '../types/method-call.js';
import type { LoopKeySite } from '../types/loop-key-site.js';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.js';

type TypeormMode = 'list' | 'one' | 'exists' | 'count';

/** What the `.map` over the loop's items becomes for a repository. */
interface RepositoryNames {
  rowsBase: string;
  rowName: string;
}

/** The local name of TypeORM's `In` and the edits that make it importable. */
interface TypeormInImport {
  name: string;
  edits: TextEdit[];
}

/** A `Promise.all(items.map((item) => read))` the batched read replaces. */
interface PromiseAllRead {
  parameter: string;
  collection: Expression;
  awaited: AwaitExpression;
  statement: Node;
}

function repositoryNames(receiver: Expression): RepositoryNames {
  const last = ts.isPropertyAccessExpression(receiver) ? receiver.name.text : textOf(receiver);
  const base = last.replace(/(?:Repository|Repo|repository|repo)$/, '');
  if (!base || base === 'this') return { rowsBase: 'rows', rowName: 'row' };
  const lowered = base[0].toLowerCase() + base.slice(1);
  // `case`, `default` and other keywords cannot name the callback parameter.
  if (lowered.endsWith('s')) return { rowsBase: lowered, rowName: 'row' };
  if (ts.stringToToken(lowered) !== undefined) return { rowsBase: plural(lowered), rowName: 'row' };
  return { rowsBase: plural(lowered), rowName: lowered };
}

// Names for rows of `repo`, `this.userRepository` or `source.getRepository(User)`, which is safe to
// evaluate once.
function repositoryReceiver(receiver: Expression): RepositoryNames | undefined {
  if (isPlainReference(receiver)) return repositoryNames(receiver);
  const plainGetRepository =
    ts.isCallExpression(receiver) &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    receiver.expression.name.text === 'getRepository' &&
    isPlainReference(receiver.expression.expression) &&
    receiver.arguments.length === 1 &&
    ts.isIdentifier(receiver.arguments[0]);
  if (plainGetRepository) return repositoryNames(receiver.arguments[0]);
}

// The local name of TypeORM's `In`, adding it to an existing named import, or as a new import, when
// needed.
function typeormIn(sourceFile: SourceFile): TypeormInImport | undefined {
  let lastImport: ImportDeclaration | undefined;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    lastImport = statement;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (
      !clause ||
      clause.isTypeOnly ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'typeorm' ||
      !bindings ||
      !ts.isNamedImports(bindings)
    )
      continue;
    const existing = bindings.elements.find((element) => (element.propertyName ?? element.name).text === 'In');
    if (existing) return existing.isTypeOnly ? undefined : { name: existing.name.text, edits: [] };
    if (freshName(sourceFile, 'In') !== 'In' || !bindings.elements.length) return;
    const last = bindings.elements[bindings.elements.length - 1];
    return { name: 'In', edits: [{ start: last.end, end: last.end, text: ', In' }] };
  }
  if (!lastImport || freshName(sourceFile, 'In') !== 'In') return;
  const quote = textOf(lastImport.moduleSpecifier)[0];
  const line = `\nimport { In } from ${quote}typeorm${quote};`;
  return { name: 'In', edits: [{ start: lastImport.end, end: lastImport.end, text: line }] };
}

const typeormModes: Record<string, TypeormMode> = {
  find: 'list',
  findBy: 'list',
  findOne: 'one',
  findOneBy: 'one',
  exists: 'exists',
  existsBy: 'exists',
  count: 'count',
  countBy: 'count',
};
const typeormRowOptions = new Set(['relations', 'select', 'withDeleted', 'loadEagerRelations']);
// A shared `order` keeps each key's rows in the same order once they are grouped; `take` and `skip`
// would not.
const typeormListOptions = new Set([...typeormRowOptions, 'order']);
const typeormOptionsByMode: Partial<Record<TypeormMode, ReadonlySet<string>>> = {
  one: typeormRowOptions,
  list: typeormListOptions,
};

// `select` naming the key column, as an object or an array of property names.
function typeormSelectsKey(select: ObjectLiteralElementLike, field: string): boolean {
  const value = ts.isPropertyAssignment(select) ? select.initializer : undefined;
  if (value && ts.isArrayLiteralExpression(value))
    return value.elements.some((element) => ts.isStringLiteral(element) && element.text === field);
  const current = value && plainProperties(value)?.get(field);
  return !!current && ts.isPropertyAssignment(current) && current.initializer.kind === ts.SyntaxKind.TrueKeyword;
}

// The options and the filter of a `find*` call: the `where` object, or the argument of a `*By`
// method.
function lookupFilter(
  call: MethodCall,
  byFilter: boolean,
): { options: ReadonlyMap<string, ObjectLiteralElementLike>; filter: Expression } | undefined {
  if (byFilter) return { options: new Map(), filter: call.arguments[0] };
  const options = plainProperties(call.arguments[0]);
  const where = options?.get('where');
  if (!options || !where || !ts.isPropertyAssignment(where)) return;
  return { options, filter: where.initializer };
}

// loadwise-reviewed high-branch-complexity -- a linear chain of independent safety bail-outs followed by one exclusive list/one/exists rewrite choice; splitting scatters the proof from the rewrite
function typeormLookup(call: MethodCall, sourceFile: SourceFile): FixResult | undefined {
  const method = call.expression.name.text;
  const mode = typeormModes[method];
  const receiver = call.expression.expression;
  if (!mode || call.arguments.length !== 1) return;
  const names = repositoryReceiver(receiver);
  if (!names) return;
  const site = loopLookup(call);
  if (!site || someNode(receiver, (node: Node) => ts.isIdentifier(node) && site.locals.has(node.text))) return;
  const byFilter = method.endsWith('By');
  const filterParts = lookupFilter(call, byFilter);
  if (!filterParts) return;
  const { options, filter } = filterParts;
  const key = itemKeyFilter(filter, site);
  if (!key) return;
  const others = invariantOptions(options, site, typeormOptionsByMode[mode] ?? new Set<string>());
  const keys = others && itemKeys(site, key);
  const operator = keys ? typeormIn(sourceFile) : undefined;
  const workNotes = operator && loopWorkNote(site, textOf(receiver), undefined, key.perItem);
  const selectProperty = options.get('select');
  if (!others || !operator || !workNotes || (selectProperty && !typeormSelectsKey(selectProperty, key.field))) return;
  const condition = whereWith(key, `${operator.name}(${keys})`);
  const repository = textOf(receiver);
  const keyText = textOf(key.value);
  const base = names.rowName === 'row' ? names.rowsBase.replace(/s$/, '') : names.rowName;
  const notes = [mapKeyNote, ...workNotes];
  const fetchLine = byFilter
    ? `${repository}.findBy(${condition})`
    : `${repository}.find({ ${[`where: ${condition}`, ...others.values()].join(', ')} })`;
  let fix: { edits: TextEdit[] } | undefined;
  if (mode === 'list') {
    notes[0] = groupedKeyNote;
    if (!ownIdKey(key.value)) notes.splice(1, 0, nullKeyNote);
    fix = groupedLookup({ site, sourceFile, ...names, field: key.field, keyValue: key.value, fetchLine, note: '' });
  } else if (mode === 'one') {
    if (key.field !== 'id') notes.splice(1, 0, duplicateKeyNote);
    fix = keyedLookup({ site, sourceFile, ...names, field: key.field, keyValue: key.value, fetchLine, note: '' });
  } else if (mode === 'exists') {
    notes[0] = setKeyNote;
    const rows = usableName(sourceFile, names.rowsBase);
    const keySet = rows && usableName(sourceFile, `${base}${capitalized(plural(key.field))}`);
    if (!keySet) return;
    fix = {
      edits: [
        insertLinesBefore(site.loop, [
          `const ${rows} = await ${repository}.find({ where: ${condition}, select: { ${key.field}: true } });`,
          `const ${keySet} = new Set(${rows}.map((row) => row.${key.field}));`,
        ]),
        replaceNode(site.awaited, inSlot(site.awaited, `${keySet}.has(${keyText})`)),
      ],
    };
  } else {
    const counts = usableName(sourceFile, `${base}Counts`);
    const byKey = counts && usableName(sourceFile, `${base}CountBy${capitalized(key.field)}`);
    if (!byKey) return;
    fix = {
      edits: [
        insertLinesBefore(site.loop, [
          `const ${counts} = await ${repository}`,
          `  .createQueryBuilder('row')`,
          `  .select('row.${key.field}', 'groupKey')`,
          `  .addSelect('COUNT(*)', 'total')`,
          `  .where(${condition})`,
          `  .groupBy('row.${key.field}')`,
          `  .getRawMany();`,
          `const ${byKey} = new Map(${counts}.map((row) => [row.groupKey, Number(row.total)]${asConst(sourceFile)}));`,
        ]),
        replaceNode(site.awaited, inSlot(site.awaited, `${byKey}.get(${keyText}) ?? 0`)),
      ],
    };
  }
  return fix && { edits: [...fix.edits, ...operator.edits], note: joinNotes(notes) };
}

// The `items.map((item) => <read>)` handed straight to an awaited `Promise.all`, with the read as
// the whole callback body (optionally `async` and awaited), and the statement the await sits in.
function promiseAllRead(call: CallExpression): PromiseAllRead | undefined {
  let body = outerParentheses(call);
  if (ts.isAwaitExpression(body.parent)) body = outerParentheses(body.parent);
  const callback = body.parent;
  if (!ts.isArrowFunction(callback) || callback.body !== body || callback.parameters.length !== 1) return;
  const parameter = callback.parameters[0];
  if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) return;
  const mapCall = callback.parent;
  if (
    !ts.isCallExpression(mapCall) ||
    mapCall.arguments.length !== 1 ||
    mapCall.arguments[0] !== callback ||
    !ts.isPropertyAccessExpression(mapCall.expression) ||
    mapCall.expression.name.text !== 'map' ||
    mapCall.expression.questionDotToken
  )
    return;
  const collection = mapCall.expression.expression;
  if (!isPlainReference(collection) || collectionKind(collection) !== 'array') return;
  const all = mapCall.parent;
  if (!ts.isCallExpression(all) || all.arguments.length !== 1 || textOf(all.expression) !== 'Promise.all') return;
  const awaited = all.parent;
  if (!ts.isAwaitExpression(awaited)) return;
  const holder = awaited.parent;
  const statement = ts.isVariableDeclaration(holder) ? holder.parent.parent : holder;
  const plainStatement =
    (ts.isVariableDeclaration(holder) && holder.initializer === awaited && ts.isVariableStatement(statement)) ||
    (ts.isReturnStatement(holder) && holder.expression === awaited) ||
    (ts.isExpressionStatement(holder) && holder.expression === awaited);
  if (!plainStatement || !(ts.isBlock(statement.parent) || ts.isSourceFile(statement.parent))) return;
  if (!startsLine(statement)) return;
  return { parameter: parameter.name.text, collection, awaited, statement };
}

// `await Promise.all(ids.map((id) => repo.findOne({ where: { id } })))` becomes one `find` with
// `In(ids)` and a Map, read back in the same order, with null for a missing row as before.
function promiseAllLookup(call: MethodCall, sourceFile: SourceFile): FixResult | undefined {
  const method = call.expression.name.text;
  const receiver = call.expression.expression;
  if (typeormModes[method] !== 'one' || call.arguments.length !== 1) return;
  const names = repositoryReceiver(receiver);
  const read = names && promiseAllRead(call);
  if (!names || !read || mentions(textOf(receiver), read.parameter)) return;
  // The shape itemKeyFilter expects of a loop: the per-item name, and no locals or earlier
  // statements in the body.
  const site: LoopKeySite = { names: new Set([read.parameter]), locals: new Set<string>() };
  const byFilter = method.endsWith('By');
  const filterParts = lookupFilter(call, byFilter);
  if (!filterParts) return;
  const { options, filter } = filterParts;
  const key = itemKeyFilter(filter, site);
  // The key is read twice, once to list the keys and once to look the row up, so it must have no
  // side effects.
  if (!key || key.perItem !== key.value || !isPlainReference(key.value)) return;
  const others = invariantOptions(options, site, typeormRowOptions);
  const operator = others && typeormIn(sourceFile);
  const selectProperty = options.get('select');
  if (!others || !operator || (selectProperty && !typeormSelectsKey(selectProperty, key.field))) return;
  const items = textOf(read.collection);
  const keyText = textOf(key.value);
  const keys = keyText === read.parameter ? items : `${items}.map((${read.parameter}) => ${keyText})`;
  const condition = whereWith(key, `${operator.name}(${keys})`);
  const repository = textOf(receiver);
  const fetchLine = byFilter
    ? `${repository}.findBy(${condition})`
    : `${repository}.find({ ${[`where: ${condition}`, ...others.values()].join(', ')} })`;
  const rows = rowsName(sourceFile, names.rowsBase);
  const byKey = rows && usableName(sourceFile, `${rows}By${capitalized(key.field)}`);
  if (!byKey) return;
  const entry = `[${names.rowName}.${key.field}, ${names.rowName}]${asConst(sourceFile)}`;
  const lookup = `${items}.map((${read.parameter}) => ${byKey}.get(${keyText}) ?? null)`;
  return {
    edits: [
      insertLinesBefore(read.statement, [
        `const ${rows} = await ${fetchLine};`,
        `const ${byKey} = new Map(${rows}.map((${names.rowName}) => ${entry}));`,
      ]),
      replaceNode(read.awaited, lookup),
      ...operator.edits,
    ],
    note: joinNotes([mapKeyNote, key.field === 'id' ? '' : duplicateKeyNote]),
  };
}

export function ormQueryInLoop({ node, finding, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || !finding.message?.startsWith('TypeORM.')) return;
  const call = calleeCall(node);
  if (!call || !isMethodCall(call)) return;
  return typeormLookup(call, sourceFile) ?? promiseAllLookup(call, sourceFile);
}
