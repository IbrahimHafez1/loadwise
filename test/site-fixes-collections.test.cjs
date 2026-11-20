'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { analyzeSources } = require('../lib/projects.cjs');
const { validateParallelReads } = require('../lib/parallel-reads.cjs');
const { attachSiteFixes } = require('../lib/site-fix.cjs');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

function findingsFor(context, ruleId, source, filename = 'app.ts') {
  const { findings } = scanWithFixes(context, { [filename]: source });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function changeFor(context, ruleId, source, filename) {
  const [finding] = findingsFor(context, ruleId, source, filename);
  assert.ok(finding, 'rule should report');
  return { change: onlyChange(finding), note: finding.fix?.note };
}

function assertNoFix(context, ruleId, source, filename) {
  const findings = findingsFor(context, ruleId, source, filename);
  assert.ok(findings.length > 0, 'rule should report');
  assert.deepEqual(
    findings.map((finding) => finding.fix),
    findings.map(() => undefined),
  );
}

const membership = 'array-repeated-membership';

test('includes inside filter hoists a Set before the statement', (context) => {
  const { change } = changeFor(
    context,
    membership,
    `export function pick(rows: { id: number }[], allowedIds: number[]) {
  return rows.filter((row) => allowedIds.includes(row.id));
}`,
  );
  assert.deepEqual(change, {
    before: `return rows.filter((row) => allowedIds.includes(row.id));`,
    after: `const allowedIdsSet = new Set(allowedIds);
return rows.filter((row) => allowedIdsSet.has(row.id));`,
  });
});

test('includes inside for-of keeps the loop indentation and avoids name clashes', (context) => {
  const { change } = changeFor(
    context,
    membership,
    `export function count(rows: number[], ids: number[]) {
  const idsSet = 1;
  let total = idsSet;
  if (rows.length) {
    for (const row of rows) {
      if (ids.includes(row)) total++;
    }
  }
  return total;
}`,
  );
  assert.deepEqual(change, {
    before: `for (const row of rows) {
  if (ids.includes(row)) total++;`,
    after: `const idsSet2 = new Set(ids);
for (const row of rows) {
  if (idsSet2.has(row)) total++;`,
  });
});

test('includes with a module-level const array in a plain function is hoisted inside the function', (context) => {
  const { change } = changeFor(
    context,
    membership,
    `declare function loadBlocked(): string[];
const blocked = loadBlocked();
export function keep(rows: string[]) {
  return rows.map((row) => blocked.includes(row));
}`,
  );
  assert.equal(change.after.split('\n')[0], 'const blockedSet = new Set(blocked);');
});

test('an expression-bodied arrow function gets a block body that builds the Set first', (context) => {
  const { change } = changeFor(
    context,
    membership,
    `export const pick = (rows: { id: number }[], ids: number[]) => rows.filter((row) => ids.includes(row.id));`,
  );
  assert.equal(
    change.after,
    `export const pick = (rows: { id: number }[], ids: number[]) => {
  const idsSet = new Set(ids);
  return rows.filter((row) => idsSet.has(row.id));
};`,
  );
  const { change: ownLine } = changeFor(
    context,
    membership,
    `export const shares = (left: string[], right: string[]): boolean =>
  left.some((value) => value !== '' && right.includes(value));`,
  );
  assert.equal(
    ownLine.after,
    `export const shares = (left: string[], right: string[]): boolean => {
  const rightSet = new Set(right);
  return left.some((value) => value !== '' && rightSet.has(value));
};`,
  );
});

test('nested iteration callbacks hoist the Set before the outer statement', (context) => {
  const { change } = changeFor(
    context,
    membership,
    `export function shares(classes: string[], drugs: { parts: string[] }[], table: Record<string, string[]>) {
  const wanted = classes.slice();
  return drugs.some((drug) => drug.parts.some((part) => (table[part] ?? []).some((cls) => wanted.includes(cls))));
}`,
  );
  assert.deepEqual(change.after.split('\n'), [
    'const wantedSet = new Set(wanted);',
    'return drugs.some((drug) => drug.parts.some((part) => (table[part] ?? []).some((cls) => wantedSet.has(cls))));',
  ]);
});

test('a property chain receiver is hoisted only when nothing in the statement guards it', (context) => {
  const { change, note } = changeFor(
    context,
    membership,
    `export function escalates(actor: { permissions: string[] }, keys: string[]) {
  const result = keys.includes('*') || !keys.every((key) => actor.permissions.includes(key));
  return result;
}`,
  );
  assert.deepEqual(change.after.split('\n').slice(0, 2), [
    'const permissionsSet = new Set(actor.permissions);',
    "const result = keys.includes('*') || !keys.every((key) => permissionsSet.has(key));",
  ]);
  assert.match(note, /`actor\.permissions` is now read even when the iteration does not run/);
  assertNoFix(
    context,
    membership,
    `export function covered(existing: { names: string[] } | undefined, names: string[]) {
  if (existing && names.every((name) => existing.names.includes(name))) return true;
  return false;
}`,
  );
});

test('membership fix is skipped for loop variables', (context) => {
  assertNoFix(
    context,
    membership,
    `export function nested(groups: number[][], rows: number[]) {
  for (const ids of groups) {
    for (const row of rows) ids.includes(row);
  }
}`,
  );
});

const find = 'array-repeated-find';

test('find by property inside a loop becomes a Map lookup that keeps the first duplicate', (context) => {
  const { change, note } = changeFor(
    context,
    find,
    `interface Item { id: string }
export function link(orders: { itemId: string }[], items: Item[]) {
  return orders.map((order) => items.find((item) => item.id === order.itemId));
}`,
  );
  assert.deepEqual(change, {
    before: `return orders.map((order) => items.find((item) => item.id === order.itemId));`,
    after: `const itemsById = new Map(items.map((item) => [item.id, item] as const).reverse());
return orders.map((order) => itemsById.get(order.itemId));`,
  });
  assert.match(note, /first duplicate wins/);
});

test('find in a JavaScript for-of loop builds the Map without a tuple assertion', (context) => {
  const { change } = changeFor(
    context,
    find,
    `/**
 * @param {{ itemId: string }[]} orders
 * @param {{ id: string }[]} items
 */
export function link(orders, items) {
  const found = [];
  for (const order of orders) {
    found.push(items.find((item) => order.itemId === item.id));
  }
  return found;
}`,
    'app.js',
  );
  assert.deepEqual(change, {
    before: `for (const order of orders) {
  found.push(items.find((item) => order.itemId === item.id));`,
    after: `const itemsById = new Map(items.map((item) => [item.id, item]).reverse());
for (const order of orders) {
  found.push(itemsById.get(order.itemId));`,
  });
});

test('find keeps no fix when the predicate reads the property with optional chaining', (context) => {
  assertNoFix(
    context,
    find,
    `interface Item { id: string }
export function link(orders: { itemId: string }[], items: Item[]) {
  return orders.map((order) => items.find((item) => item?.id === order.itemId));
}`,
  );
});

const existence = 'filter-for-existence';

test('filter length comparisons become some()', (context) => {
  const cases = [
    ['items.filter((item) => item.active).length > 0', 'items.some((item) => item.active)'],
    ['items.filter((item) => item.active).length !== 0', 'items.some((item) => item.active)'],
    ['items.filter((item) => item.active).length === 0', '!items.some((item) => item.active)'],
    ['0 < items.filter((item) => item.active).length', 'items.some((item) => item.active)'],
    ['items.filter((item) => item.active).length <= 0', '!items.some((item) => item.active)'],
  ];
  for (const [before, after] of cases) {
    const { change } = changeFor(
      context,
      existence,
      `export function check(items: { active: boolean }[]) {
  return ${before};
}`,
    );
    assert.deepEqual(change, { before: `return ${before};`, after: `return ${after};` });
  }
});

test('filter length used as a condition becomes some()', (context) => {
  const { change } = changeFor(
    context,
    existence,
    `export function check(items: { active: boolean }[]) {
  if (items.filter((item) => item.active).length) return 1;
  return 0;
}`,
  );
  assert.deepEqual(change, {
    before: `if (items.filter((item) => item.active).length) return 1;`,
    after: `if (items.some((item) => item.active)) return 1;`,
  });
});

test('filter with a count comparison other than zero has no finding to fix', (context) => {
  const findings = findingsFor(
    context,
    existence,
    `export function check(items: { active: boolean }[]) {
  return items.filter((item) => item.active).length > 1;
}`,
  );
  assert.deepEqual(findings, []);
});

const extreme = 'numeric-sort-for-extreme';

test('sorted copy read at an end becomes a single reduce pass', (context) => {
  const cases = [
    ['[...scores].sort((a, b) => a - b)[0]', '<', 'min'],
    ['[...scores].sort((a, b) => b - a)[0]', '>', 'max'],
    ['[...scores].sort((a, b) => a - b).at(-1)', '>=', 'max'],
    ['Array.from(scores).sort((a, b) => b - a).at(-1)', '<=', 'min'],
  ];
  for (const [before, operator, best] of cases) {
    const { change } = changeFor(
      context,
      extreme,
      `export function best(scores: number[]) {
  return ${before};
}`,
    );
    assert.deepEqual(change, {
      before: `return ${before};`,
      after: `return scores.reduce((${best}, value) => (value ${operator} ${best} ? value : ${best}), scores[0]);`,
    });
  }
});

const reduceCopy = 'reduce-copy-accumulator';

test('reduce array spread becomes push on the fresh accumulator', (context) => {
  const { change } = changeFor(
    context,
    reduceCopy,
    `export function names(rows: { name: string }[]) {
  return rows.reduce((acc: string[], row) => [...acc, row.name], []);
}`,
  );
  assert.deepEqual(change, {
    before: `return rows.reduce((acc: string[], row) => [...acc, row.name], []);`,
    after: `return rows.reduce((acc: string[], row) => {
  acc.push(row.name);
  return acc;
}, []);`,
  });
});

test('reduce object spread with a computed key assigns in place', (context) => {
  const { change, note } = changeFor(
    context,
    reduceCopy,
    `export function index(rows: { id: string; name: string }[]) {
  return rows.reduce((acc: Record<string, string>, row) => {
    return { ...acc, [row.id]: row.name };
  }, {});
}`,
  );
  assert.deepEqual(change, {
    before: `return { ...acc, [row.id]: row.name };`,
    after: `acc[row.id] = row.name;
return acc;`,
  });
  assert.match(note, /__proto__/);
});

test('reduce spread is skipped for a shared initial value or an accumulator used twice', (context) => {
  assertNoFix(
    context,
    reduceCopy,
    `export function names(rows: { name: string }[], seed: string[]) {
  return rows.reduce((acc: string[], row) => [...acc, row.name], seed);
}`,
  );
  assertNoFix(
    context,
    reduceCopy,
    `export function names(rows: { name: string }[]) {
  return rows.reduce((acc: string[], row) => [...acc, acc.length + row.name], []);
}`,
  );
});

const loopCopy = 'loop-copy-accumulator';

test('loop array copy of a local accumulator becomes push', (context) => {
  const { change } = changeFor(
    context,
    loopCopy,
    `export function names(rows: { name: string }[]) {
  let result: string[] = [];
  for (const row of rows) {
    result = [...result, row.name];
  }
  return result;
}`,
  );
  assert.deepEqual(change, { before: `result = [...result, row.name];`, after: `result.push(row.name);` });
});

test('loop array copy is skipped when the accumulator starts as another array or is aliased', (context) => {
  assertNoFix(
    context,
    loopCopy,
    `export function names(rows: { name: string }[], seed: string[]) {
  let result = seed;
  for (const row of rows) {
    result = [...result, row.name];
  }
  return result;
}`,
  );
  assertNoFix(
    context,
    loopCopy,
    `export function names(rows: { name: string }[]) {
  let result: string[] = [];
  const snapshots: string[][] = [];
  for (const row of rows) {
    const snapshot = result;
    snapshots.push(snapshot);
    result = [...result, row.name];
  }
  return snapshots;
}`,
  );
});

const rebuild = 'rebuild-lookup-in-loop';

test('Set rebuilt in a loop is built once before it', (context) => {
  const { change } = changeFor(
    context,
    rebuild,
    `export function count(rows: number[], ids: number[]) {
  let total = 0;
  for (const row of rows) {
    if (new Set(ids).has(row)) total++;
  }
  return total;
}`,
  );
  assert.deepEqual(change, {
    before: `for (const row of rows) {
  if (new Set(ids).has(row)) total++;`,
    after: `const idsSet = new Set(ids);
for (const row of rows) {
  if (idsSet.has(row)) total++;`,
  });
});

test('Map rebuilt in a callback is built once before the statement', (context) => {
  const { change } = changeFor(
    context,
    rebuild,
    `export function lookup(rows: string[], entries: [string, number][]) {
  return rows.map((row) => new Map(entries).get(row));
}`,
  );
  assert.deepEqual(change, {
    before: `return rows.map((row) => new Map(entries).get(row));`,
    after: `const entriesMap = new Map(entries);
return rows.map((row) => entriesMap.get(row));`,
  });
});

const promiseRule = 'promise-combinator-serial-await';

test('Promise.all over awaited calls drops the awaits', (context) => {
  const { change, note } = changeFor(
    context,
    promiseRule,
    `declare function loadUser(id: string): Promise<string>;
declare function loadPosts(id: string): Promise<string>;
export async function load(id: string) {
  return Promise.all([await loadUser(id), (await loadPosts(id))]);
}`,
  );
  assert.deepEqual(change, {
    before: `return Promise.all([await loadUser(id), (await loadPosts(id))]);`,
    after: `return Promise.all([loadUser(id), (loadPosts(id))]);`,
  });
  assert.match(note, /rejection/);
});

test('known reads awaited one after another merge into one Promise.all', (context) => {
  const base = path.join(
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir(),
  );
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-fix-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules/@app/reads'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'node_modules/@app/reads/index.d.ts'),
    `export function fetchUser(id?: string): Promise<string>;
export function fetchPosts(id?: string): Promise<string>;`,
  );
  const files = {
    'ok.ts': `import { fetchUser, fetchPosts } from '@app/reads';
export async function dashboard(id: string) {
  const user = await fetchUser(id);
  const posts = await fetchPosts(id);
  return { user, posts };
}`,
    'annotated.ts': `import { fetchUser, fetchPosts } from '@app/reads';
export async function dashboard(id: string) {
  const user: string = await fetchUser(id);
  const posts = await fetchPosts(id);
  return { user, posts };
}`,
  };
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(root, name), contents);
  const policy = {
    parallelReads: validateParallelReads([{ from: '@app/reads', exports: ['fetchUser', 'fetchPosts'] }]),
  };
  const { findings } = analyzeSources({ files: Object.keys(files).map((name) => path.join(root, name)), policy });
  attachSiteFixes(findings);
  const byFile = Object.fromEntries(
    findings
      .filter((finding) => finding.ruleId === 'known-reads-awaited-serially')
      .map((finding) => [path.basename(finding.file), finding]),
  );
  assert.deepEqual(onlyChange(byFile['ok.ts']), {
    before: `const user = await fetchUser(id);
const posts = await fetchPosts(id);`,
    after: `const [user, posts] = await Promise.all([fetchUser(id), fetchPosts(id)]);`,
  });
  assert.equal(byFile['annotated.ts'].fix, undefined);
});
