import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { lint } from './helpers.js';
import { scanWithFixes, requireOnlyChange } from './site-fix-helpers.js';

const loopCopy = 'loop-copy-accumulator';
const reduceCopy = 'reduce-copy-accumulator';

function copyFindings(source: string) {
  return lint(source)
    .filter(({ ruleId }) => ruleId === loopCopy || ruleId === reduceCopy)
    .map(({ ruleId, line }) => [ruleId, line]);
}

function findingsFor(context: TestContext, ruleId: string, source: string, filename = 'app.ts') {
  const { findings } = scanWithFixes(context, { [filename]: source });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function changeFor(context: TestContext, ruleId: string, source: string, filename = 'app.ts') {
  const [finding] = findingsFor(context, ruleId, source, filename);
  assert.ok(finding, 'rule should report');
  return { change: requireOnlyChange(finding), note: finding.fix?.note };
}

function assertNoFix(context: TestContext, ruleId: string, source: string, filename = 'app.ts') {
  const findings = findingsFor(context, ruleId, source, filename);
  assert.ok(findings.length > 0, 'rule should report');
  assert.deepEqual(
    findings.map((finding) => finding.fix),
    findings.map(() => undefined),
  );
}

test('loop copies identify object spread and Object.assign accumulators with a per-item key', () => {
  const findings = lint(
    [
      'function index(rows: { id: string }[]) {',
      '  let byId: Record<string, { id: string }> = {}, counts: Record<string, number> = {};',
      '  for (const row of rows) byId = { ...byId, [row.id]: row };',
      '  rows.forEach((row) => { counts = Object.assign({}, counts, { [row.id]: 1 }); });',
      '  return [byId, counts];',
      '}',
    ].join('\n'),
  ).filter(({ ruleId }) => ruleId === loopCopy);
  assert.deepEqual(
    findings.map(({ line }) => line),
    [3, 4],
  );
  assert.match(findings[0].message, /accumulated object/);
});

test('loop object copies skip fixed keys, outer keys, small key domains, escapes and custom assign', () => {
  assert.deepEqual(
    copyFindings(`
    function scenarios(rows: { id: string; kind: 'a' | 'b' }[], key: string, snapshots: object[]) {
      let state: Record<string, number> = { count: 0 };
      for (const row of rows) state = { ...state, count: state.count + 1 };
      for (const row of rows) state = { ...state, [key]: 1 };
      for (const row of rows) state = { ...state, [row.kind]: 1 };
      for (const row of rows) {
        snapshots.push(state);
        state = { ...state, [row.id]: 1 };
      }
      for (const row of rows) {
        state[row.id] = 0;
        state = { ...state, [row.id]: 1 };
      }
      for (const row of rows) state = Object.assign(state, { [row.id]: 1 });
      for (const row of rows) state = Object.assign({}, state, extra(row));
      const custom = { assign(...parts: object[]) { return parts[0]; } };
      for (const row of rows) state = custom.assign({}, state, { [row.id]: 1 }) as Record<string, number>;
      for (const row of rows) {
        let local: Record<string, number> = {};
        local = { ...local, [row.id]: 1 };
      }
    }
    declare function extra(row: object): object;
  `),
    [],
  );
});

test('reduce identifies concat and Object.assign copies of the accumulator', () => {
  assert.deepEqual(
    copyFindings(
      [
        'function summary(rows: { id: string; tags: string[] }[]) {',
        '  rows.reduce<string[]>((tags, row) => tags.concat(row.tags), []);',
        '  rows.reduce<Record<string, number>>((acc, row) => Object.assign({}, acc, { [row.id]: 1 }), {});',
        '}',
      ].join('\n'),
    ),
    [
      [reduceCopy, 2],
      [reduceCopy, 3],
    ],
  );
});

test('reduce concat and Object.assign skip in-place assign, empty concat, fixed keys and string concat', () => {
  assert.deepEqual(
    copyFindings(`
    function summary(rows: { id: string; tags: string[] }[]) {
      rows.reduce<Record<string, number>>((acc, row) => Object.assign(acc, { [row.id]: 1 }), {});
      rows.reduce<Record<string, number>>((acc, row) => Object.assign({}, acc, { total: 1 }), {});
      rows.reduce<string[]>((tags, row) => tags.concat([]), []);
      rows.reduce<string[]>((tags, row) => row.tags.concat(tags), []);
      rows.reduce((label, row) => label.concat(row.id), '');
    }
  `),
    [],
  );
});

test('loop object spread of a local accumulator becomes a keyed assignment', (context) => {
  const { change, note } = changeFor(
    context,
    loopCopy,
    `export function index(rows: { id: string }[]) {
  let byId: Record<string, { id: string }> = {};
  for (const row of rows) {
    byId = { ...byId, [row.id]: row };
  }
  return byId;
}`,
  );
  assert.deepEqual(change, { before: `byId = { ...byId, [row.id]: row };`, after: `byId[row.id] = row;` });
  assert.ok(note);
  assert.match(note, /__proto__/);
});

test('loop object spread keeps reads of the old value on the right-hand side', (context) => {
  const { change } = changeFor(
    context,
    loopCopy,
    `export function count(rows: { id: string }[]) {
  let counts: Record<string, number> = {};
  for (const row of rows) counts = { ...counts, [row.id]: (counts[row.id] ?? 0) + 1 };
  return counts;
}`,
  );
  assert.deepEqual(change, {
    before: `for (const row of rows) counts = { ...counts, [row.id]: (counts[row.id] ?? 0) + 1 };`,
    after: `for (const row of rows) counts[row.id] = (counts[row.id] ?? 0) + 1;`,
  });
});

test('loop object spread fix is withheld for shared starts, aliases, untyped TS, several keys and Object.assign', (context) => {
  const cases = [
    `export function index(rows: { id: string }[], seed: Record<string, object>) {
  let byId = seed;
  for (const row of rows) byId = { ...byId, [row.id]: row };
  return byId;
}`,
    `export function index(rows: { id: string }[]) {
  let byId: Record<string, object> = {};
  const history: object[] = [];
  for (const row of rows) {
    const previous = byId;
    history.push(previous);
    byId = { ...byId, [row.id]: row };
  }
  return history;
}`,
    `export function index(rows: { id: string }[]) {
  let byId = {};
  for (const row of rows) byId = { ...byId, [row.id]: row };
  return byId;
}`,
    `export function index(rows: { id: string; name: string }[]) {
  let byId: Record<string, object> = {};
  for (const row of rows) byId = { ...byId, [row.id]: row, [row.name]: row };
  return byId;
}`,
    `export function index(rows: { id: string }[]) {
  let byId: Record<string, object> = { get size() { return 0; } };
  for (const row of rows) byId = { ...byId, [row.id]: row };
  return byId;
}`,
    `export function index(rows: { id: string }[]) {
  let byId: Record<string, object> = {};
  for (const row of rows) byId = Object.assign({}, byId, { [row.id]: row });
  return byId;
}`,
  ];
  for (const source of cases) assertNoFix(context, loopCopy, source);
});

test('loop object spread is fixed in plain JavaScript without a type annotation', (context) => {
  const { change } = changeFor(
    context,
    loopCopy,
    `export function index(rows) {
  let byId = {};
  for (const row of rows) byId = { ...byId, [row.id]: row };
  return byId;
}`,
    'app.js',
  );
  assert.deepEqual(change, {
    before: `for (const row of rows) byId = { ...byId, [row.id]: row };`,
    after: `for (const row of rows) byId[row.id] = row;`,
  });
});

test('reduce concat and Object.assign copies are reported without an autofix', (context) => {
  assertNoFix(
    context,
    reduceCopy,
    `export function tags(rows: { tags: string[] }[]) {
  return rows.reduce<string[]>((all, row) => all.concat(row.tags), []);
}`,
  );
  assertNoFix(
    context,
    reduceCopy,
    `export function index(rows: { id: string }[]) {
  return rows.reduce<Record<string, number>>((acc, row) => Object.assign({}, acc, { [row.id]: 1 }), {});
}`,
  );
});

const existence = 'filter-for-existence';

test('filter length compared with one or wrapped in Boolean() becomes some()', (context) => {
  const cases = [
    ['items.filter((item) => item.active).length >= 1', 'items.some((item) => item.active)'],
    ['items.filter((item) => item.active).length < 1', '!items.some((item) => item.active)'],
    ['1 <= items.filter((item) => item.active).length', 'items.some((item) => item.active)'],
    ['1 > items.filter((item) => item.active).length', '!items.some((item) => item.active)'],
    ['Boolean(items.filter((item) => item.active).length)', 'Boolean(items.some((item) => item.active))'],
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
