// Builds the keyed (one row per key) and grouped (rows per key) lookups the loop reads instead of
// querying, with the notes and option checks they share.
import { ts, textOf, replaceNode, insertLinesBefore } from './helpers.js';
import type { Expression, ForOfStatement, ObjectLiteralElementLike } from 'typescript';
import { inSlot, readsOnlyNames, indentationOf } from './query-loop-nodes.js';
import { typeScriptFile, capitalized, usableName, asConst, rowsName } from './query-loop-names.js';
import { distinctKeys } from './query-loop-sites.js';
import type { ForOfLoopBinding, LoopItemKey, LookupRewrite } from '../types/loop-lookup.js';
import type { TextEdit } from '../../shared/types.js';

/** What the batched rows rewrite produces. */
interface BatchedLookup {
  edits: TextEdit[];
  note: string;
}

const sameKey = (text: string) => text;

// Batched rows indexed by one key field, then each iteration reads its row from the Map. `setup`
// lines go first,
// `fetched` replaces `await fetchLine` as the rows' value, and `keyOf` wraps both sides of the Map
// key.
export function keyedLookup({
  site,
  sourceFile,
  rowsBase,
  rowName,
  field,
  keyValue,
  fetchLine,
  note,
  setup = [],
  fetched = `await ${fetchLine}`,
  keyOf = sameKey,
}: LookupRewrite): BatchedLookup | undefined {
  const rows = rowsName(sourceFile, rowsBase);
  const byKey = rows && usableName(sourceFile, `${rows}By${capitalized(field)}`);
  if (!byKey) return;
  const entry = `[${keyOf(`${rowName}.${field}`)}, ${rowName}]${asConst(sourceFile)}`;
  return {
    edits: [
      insertLinesBefore(site.loop, [
        ...setup,
        `const ${rows} = ${fetched};`,
        `const ${byKey} = new Map(${rows}.map((${rowName}) => ${entry}));`,
      ]),
      replaceNode(site.awaited, inSlot(site.awaited, `${byKey}.get(${keyOf(textOf(keyValue))}) ?? null`)),
    ],
    note,
  };
}

// One indentation level of the loop body, so generated blocks match the file's own style.
export function indentationStep(loop: ForOfStatement): string {
  const body = loop.statement;
  const inner = ts.isBlock(body) && body.statements[0];
  const step = inner ? indentationOf(inner).slice(indentationOf(loop).length) : '';
  return step || '  ';
}

// Batched rows grouped by one key field in query order, then each iteration reads its list from the
// Map. Items that may share a key get their own copy of the list, as each per-item query returned a
// fresh array. Takes the same `setup`, `fetched` and `keyOf` options as keyedLookup.
export function groupedLookup({
  site,
  sourceFile,
  rowsBase,
  rowName,
  field,
  keyValue,
  fetchLine,
  note,
  setup = [],
  fetched = `await ${fetchLine}`,
  keyOf = sameKey,
}: LookupRewrite): BatchedLookup | undefined {
  const rows = rowsName(sourceFile, rowsBase);
  const byKey = rows && usableName(sourceFile, `${rows}By${capitalized(field)}`);
  const group = byKey && usableName(sourceFile, 'group');
  if (!group || rowName === rows) return;
  const step = indentationStep(site.loop);
  const mapType = typeScriptFile.test(sourceFile.fileName) ? `<unknown, typeof ${rows}>` : '';
  const lookup = `${byKey}.get(${keyOf(textOf(keyValue))}) ?? []`;
  const rowKey = keyOf(`${rowName}.${field}`);
  return {
    edits: [
      insertLinesBefore(site.loop, [
        ...setup,
        `const ${rows} = ${fetched};`,
        `const ${byKey} = new Map${mapType}();`,
        `for (const ${rowName} of ${rows}) {`,
        `${step}const ${group} = ${byKey}.get(${rowKey}) ?? [];`,
        `${step}${group}.push(${rowName});`,
        `${step}${byKey}.set(${rowKey}, ${group});`,
        '}',
      ]),
      replaceNode(site.awaited, inSlot(site.awaited, distinctKeys(site, keyValue) ? lookup : `[...(${lookup})]`)),
    ],
    note,
  };
}

// List reads that may take `take`, `skip`, `cursor` or `distinct` are never batched: those limit
// rows per key.
export const groupedKeyNote =
  'Rows are grouped through a Map in query order, so the key must be a string or number of the same type the column comes back as (not a Date, Decimal, Buffer or a bigint read as a string), and is compared exactly, without a case-insensitive collation.';
export const nullKeyNote =
  'An item whose key is null or undefined now gets no rows, where its own query matched rows with a null key (or, for undefined, no filter at all).';

// The key is the item's own `id`, which is never null.
export function ownIdKey(keyValue: Expression): boolean {
  const value = ts.skipParentheses(keyValue);
  return ts.isPropertyAccessExpression(value) && value.name.text === 'id';
}

export const mapKeyNote =
  'Rows are matched through a Map, so the key must be a string or number value (not a Date, Decimal or Buffer).';

export const setKeyNote =
  'Keys are matched through a Set, so the key must be a string or number value (not a Date, Decimal or Buffer).';
export const duplicateKeyNote =
  'If several rows share a key, the Map keeps the last one, where the per-item query returned whichever came first.';

export function joinNotes(notes: readonly (string | false | undefined)[]): string {
  return notes.filter(Boolean).join(' ');
}

// The options besides `where`, unchanged: each must be one line and the same on every iteration.
export function invariantOptions(
  options: ReadonlyMap<string, ObjectLiteralElementLike>,
  site: Pick<ForOfLoopBinding, 'names' | 'locals'>,
  allowed: ReadonlySet<string>,
): Map<string, string> | undefined {
  const texts = new Map<string, string>();
  for (const [name, property] of options) {
    if (name === 'where') continue;
    const reads = ts.isPropertyAssignment(property) && readsOnlyNames(property.initializer, site.names, site.locals);
    if (!allowed.has(name) || !reads || reads.usesLoopVariable || textOf(property).includes('\n')) return;
    texts.set(name, textOf(property));
  }
  return texts;
}

export function whereWith(key: LoopItemKey, keyCondition: string): string {
  const parts = [...(key.properties ?? [])].map(([name, property]) =>
    property === key.property ? `${name}: ${keyCondition}` : textOf(property),
  );
  return `{ ${parts.join(', ')} }`;
}
