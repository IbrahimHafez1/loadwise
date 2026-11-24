import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { lint, withProgram } from './helpers.cjs';
import type { SourceFile } from 'typescript';
import type { Finding, ProgramAdapter } from '../../lib/shared/types.cjs';
import { typeScriptProgramOf } from '../types/program-files.cjs';
import type * as PerformanceAnalyze from '../../lib/performance/analyze.cjs';

test('pure probes into typed data properties and caller-sized public predicates receive distinct advice', () => {
  const source = `interface Holder { keys: string[] }
    interface Custom { keys: { includes(value: string): boolean } }
    class Dynamic { get keys(): string[] { return []; } }
    class Policy {
      matches(held:string[], keys:string[]) { return keys.every(key => held.includes(key)); }
      private grants(holder:Holder, keys:string[]) { return keys.every(key => holder.keys.includes(key)); }
      private invokes(holder:Holder, keys:string[]) { return keys.every(key => { holder.keys = []; return holder.keys.includes(key); }); }
      private getter(holder:Dynamic, keys:string[]) { return keys.every(key => holder.keys.includes(key)); }
      private custom(holder:Custom, keys:string[]) { return keys.every(key => holder.keys.includes(key)); }
      private tiny(holder:Holder) { return ['a','b'].every(key=>holder.keys.includes(key)); }
    }`;
  assert.deepEqual(
    lint(source)
      .filter((finding: Finding) => finding.ruleId === 'array-repeated-membership')
      .map((finding: Finding) => [finding.line, Boolean(finding.contextualReason)]),
    [
      [5, true],
      // Both receivers come from parameters, so neither array size is known.
      [6, true],
    ],
  );
});

test('membership checks identify reusable array scans in loops and built-in callbacks', () => {
  const findings = lint(
    [
      'function allowed(rows: readonly number[], ids: readonly number[] = []) {',
      '  for (const row of rows) ids.includes(row);',
      '  return rows.filter(row => ids.includes(row));',
      '}',
      'function allowedByGroup(groups: number[][], rows: number[]) {',
      '  for (const ids of groups) {',
      '    for (const row of rows) ids.includes(row);',
      '  }',
      '}',
      'function collected(rows: number[]) {',
      '  const ids: number[] = [];',
      '  for (const row of rows) ids.push(row);',
      '  return rows.map(row => ids.includes(row));',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['array-repeated-membership', 2],
      ['array-repeated-membership', 3],
      ['array-repeated-membership', 7],
      ['array-repeated-membership', 13],
    ],
  );
});

test('membership skips per-item arrays, small literals, non-array methods, mutable and offset lookups', () => {
  const findings = lint(`
    function lookups(groups: number[][], ids: number[], query: number) {
      ids.includes(query);
      const flags = [1, 2] as const;
      const allowedIds = new Set(ids);
      groups.forEach(group => {
        group.includes(query);
        flags.includes(1);
        ids.includes(query, 1);
        'labels'.includes('a');
        const derived = [...ids];
        derived.includes(query);
        allowedIds.has(query);
        const deferred = () => ids.includes(query);
      });
      for (const group of groups) {
        ids.push(group.length);
        ids.includes(query);
      }
      for (const group of groups) {
        ids = group;
        ids.includes(query);
      }
      for (const group of groups) {
        ids[query] = group.length;
        ids.includes(query);
      }
      const lookup = { includes(value: number) { return value === 3; } };
      groups.forEach(() => lookup.includes(query));
    }
  `);
  assert.deepEqual(findings, []);
});

test('single-item literals do not turn one lookup into repeated work', () => {
  const findings = lint(
    [
      'function review(ids: number[], value: number) {',
      '  [value].map(id => ids.includes(id));',
      '  for (const id of ([value] as const)) ids.includes(id);',
      '  [].forEach(id => ids.includes(id));',
      '  for (const outer of ids) [value].forEach(id => ids.includes(id));',
      '  for (const outer of ids) [].forEach(id => ids.includes(id));',
      '  for (const id of [...ids]) ids.includes(id);',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['array-repeated-membership', 5],
      ['array-repeated-membership', 7],
    ],
  );
});

test('short fixed readonly tuples need no index, while variadic tuples and wide arrays remain candidates', () => {
  const findings = lint(
    [
      'function choose(keys: string[], pair: readonly [first: string, second?: string],',
      '  open: readonly [first: string, ...rest: string[]], list: readonly string[]) {',
      '  keys.filter(key => pair.includes(key));',
      '  keys.filter(key => open.includes(key));',
      '  keys.filter(key => list.includes(key));',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['array-repeated-membership', 4],
      ['array-repeated-membership', 5],
    ],
  );
});

test('fixed probe lists and capped native array pipelines stay linear', () => {
  const findings = lint(
    [
      'function choose(keys: string[], rows: string[], extra: boolean) {',
      '  ["a", "b"].every(key => keys.includes(key));',
      '  const fixed = ["a", ...(extra ? ["b"] : [])];',
      '  for (const key of fixed) keys.find(item => item === key);',
      '  const visible = fixed.filter(key => key !== "b");',
      '  visible.map(key => keys.includes(key));',
      '  const sample = rows.slice(0, 4).map(row => row.trim());',
      '  rows.filter(row => sample.includes(row));',
      '  rows.slice(0, 3).some(row => keys.includes(row));',
      '  rows.slice(0, 100).some(row => keys.includes(row));',
      '  [ ...rows ].some(row => keys.includes(row));',
      '  for (const row of rows) ["a", "b"].some(key => keys.includes(key));',
      '  for (const row of rows) { const local = row.split(","); ["a", "b"].some(key => local.includes(key)); }',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map((finding: Finding) => finding.line),
    [10, 11, 12],
  );
});

test('growing or escaped sources and custom slice implementations remain candidates', () => {
  const findings = lint(
    [
      'function choose(keys: string[], rows: string[], change: (items: string[]) => void) {',
      '  const grow = ["a", "b"]; grow.push(...rows);',
      '  grow.some(row => keys.includes(row));',
      '  const escaped = ["a"]; change(escaped);',
      '  escaped.some(row => keys.includes(row));',
      '  const original = ["a"]; const alias = original; alias.push(...rows);',
      '  original.some(row => keys.includes(row));',
      '  const unbounded = { slice(_start: number, _end: number) { return rows; } };',
      '  unbounded.slice(0, 2).some(row => keys.includes(row));',
      '  rows.slice(0, -1).some(row => keys.includes(row));',
      '  const mutable = ["a"]; mutable.forEach((_id, _index, observed) => observed.push(...rows));',
      '  mutable.some(row => keys.includes(row));',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map((finding: Finding) => finding.line),
    [3, 5, 7, 9, 10, 12],
  );
});

test('membership guidance identifies untransformed copies of existing Sets', () => {
  const findings = lint(
    [
      'function check(rows: number[], stored: ReadonlySet<number>) {',
      '  const ids = Array.from(new Set(rows));',
      '  rows.filter(id => ids.includes(id));',
      '  const copied = [...stored];',
      '  rows.filter(id => copied.includes(id));',
      '  const changed = Array.from(stored, id => id + 1);',
      '  rows.filter(id => changed.includes(id));',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map((finding: Finding) => finding.line),
    [3, 5, 7],
  );
  assert.deepEqual(
    findings.map((finding: Finding) => finding.message.includes('Keep the original Set')),
    [true, true, false],
  );
});

test('small literal lookup tables remain quiet when exported or reused in a fixture table', () => {
  const findings = lint(
    [
      'export const frozen = ["a", "b"] as const;',
      'export const readonlyKeys: readonly string[] = ["a", "b"];',
      'export const roleKeys: string[] = ["a", "b"];',
      'export const grown: string[] = ["a", "b"];',
      'function use(rows: string[]) {',
      '  const cases = [{id: "a"}, {id: "b"}];',
      '  for (const [, group] of [["fixture", cases]] as const) for (const item of group) item.id;',
      '  rows.map(row => cases.find(item => item.id === row));',
      '  rows.filter(row => frozen.includes(row as "a" | "b"));',
      '  rows.filter(row => readonlyKeys.includes(row));',
      '  rows.filter(row => roleKeys.includes(row));',
      '  grown.push(...rows);',
      '  rows.filter(row => grown.includes(row));',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map((finding: Finding) => finding.line),
    [13],
  );
});

test('rebuilding native indexes from stable collections flags Set.has, Map.get and Map.has', () => {
  const findings = lint(
    [
      'function indexLookups(ids: number[], entries: [number, string][], previous: ReadonlyMap<number, string>) {',
      '  for (const id of ids) new Set(ids).has(id);',
      '  ids.map(id => new Map(entries).get(id));',
      '  ids.filter(id => new Map(previous).has(id));',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['rebuild-lookup-in-loop', 2],
      ['rebuild-lookup-in-loop', 3],
      ['rebuild-lookup-in-loop', 4],
    ],
  );
});

test('rebuilding a lookup omits changing sources, one-shot iterables and shadowed constructors', () => {
  assert.deepEqual(
    lint(`
    function unchanged(groups: number[][], ids: number[], stream: IterableIterator<number>, keys: Set<number>) {
      new Set(ids).has(3);
      const existing = new Set(ids);
      for (const group of groups) {
        existing.has(3);
        new Set(group).has(3);
        new Set(stream).has(3);
        keys.add(group.length);
        new Set(keys).has(3);
      }
      for (const group of groups) {
        ids.length = 0;
        new Set(ids).has(3);
      }
      { class Set { constructor(source: number[]) {} has(key: number) { return true; } }
        groups.map(group => new Set(ids).has(3));
      }
    }
  `),
    [],
  );
});

test('loop copies identify spread and native concat on an external growing array', () => {
  const findings = lint(
    [
      'function flatten(groups: number[][]) {',
      '  let left: number[] = [], right: number[] = [], appended: number[] = [];',
      '  for (const group of groups) left = [...left, ...group];',
      '  groups.forEach(group => { right = [...group, ...right]; });',
      '  for (const group of groups) appended = appended.concat(group);',
      '  return [left, right, appended];',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['loop-copy-accumulator', 3],
      ['loop-copy-accumulator', 4],
      ['loop-copy-accumulator', 5],
    ],
  );
});

test('loop copies skip resets, fixed-size copies, escaped arrays, per-item temporaries and custom concat', () => {
  assert.deepEqual(
    lint(`
    function scenarios(groups: number[][], snapshots: number[][]) {
      let rows: number[] = [];
      rows = [...rows, 1];
      for (const group of groups) {
        rows = [];
        rows = [...rows, ...group];
      }
      for (const group of groups) {
        rows.length = 0;
        rows = rows.concat(group);
      }
      for (const group of groups) {
        snapshots.push(rows);
        rows = [...rows, ...group];
      }
      for (const group of groups) {
        let local = group;
        local = [...local, 1];
        rows = [...rows, ...[]];
      }
      for (const group of groups) rows = rows.concat([]);
      let label = 'a';
      for (const group of groups) label = label.concat('a');
      let custom = { concat(entry: number[]) { return this; } };
      for (const group of groups) custom = custom.concat(group);
    }
  `),
    [],
  );
});

test('reduce identifies copying a growing array or dynamically keyed object', () => {
  const findings = lint(
    [
      'function summary(rows: {id: string}[]) {',
      '  rows.reduce<string[]>((result, row) => [...result, row.id], []);',
      '  rows.reduce<Record<string, number>>((result, {id}) => ({ ...result, [id]: 1 }), {});',
      '  rows.reduce<number[]>((result, row) => {',
      '    if (row.id) return [...result, 1];',
      '    return result;',
      '  }, []);',
      '  rows.reduce<number[]>((result, row) => row.id ? [...result, 3] : result, []);',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['reduce-copy-accumulator', 2],
      ['reduce-copy-accumulator', 3],
      ['reduce-copy-accumulator', 5],
      ['reduce-copy-accumulator', 8],
    ],
  );
});

test('reduce ignores fixed shapes, nested returns, unrelated spreads and custom reducers', () => {
  const findings = lint(`
    function summaries(rows: string[]) {
      rows.reduce((result, row) => ({...result, count: result.count + 1}), {count: 0});
      rows.reduce<string[]>((result, row) => { result.push(row); return result; }, []);
      rows.reduce<string[]>((result, row) => [...row, row], []);
      rows.reduce<string[]>((result, row) => {
        const snapshot = () => [...result, row];
        if (row) { const result = [row]; return [...result, row]; }
        return result;
      }, []);
      const stableKey = 'total';
      rows.reduce((result, row) => ({...result, [stableKey]: row}), {});
      const custom = { reduce(fn: (list: string[], value: string) => string[]) { return fn([], 'once'); } };
      custom.reduce((result, value) => [...result, value]);
    }
  `);
  assert.deepEqual(findings, []);
});

test('find reports strict equality joins when keys belong to each current item', () => {
  const findings = lint(
    [
      'function enrich(orders: {customerId: string}[], customers: readonly {id: string}[]) {',
      '  orders.map(order => customers.find(customer => customer.id === order.customerId));',
      '  for (const order of orders) {',
      '    customers.find(function(customer) { return order.customerId === customer.id; });',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['array-repeated-find', 2],
      ['array-repeated-find', 4],
    ],
  );
});

test('find skips other predicates, changing collections, nested deferred searches and fixed queries', () => {
  assert.deepEqual(
    lint(`
    function examples(ids: number[], groups: number[][], target: number) {
      ids.map(id => ids.find(entry => entry === target));
      ids.map(id => ids.find(entry => entry > id));
      ids.map(id => ids.find(entry => entry === id || entry === 0));
      groups.map(group => group.find(entry => entry === group.length));
      ids.map(id => () => ids.find(entry => entry === id));
      for (const id of ids) {
        ids.push(id);
        ids.find(entry => entry === id);
      }
    }
  `),
    [],
  );
});

test('collection suggestions preserve optional semantics and skip asynchronous or bounded reducers and predicates', () => {
  assert.deepEqual(
    lint(`
    function examples(ids: number[], optionalIds: number[] | undefined, statuses: ('active' | 'inactive')[]) {
      ids.map(id => optionalIds?.includes(id));
      ids.map(id => optionalIds?.find(entry => entry === id));
      ids.map(id => ids.find(async entry => entry === id));
      ids.map(id => ids.find(function* (entry) { return entry === id; }));
      statuses.reduce((counts, status) => ({...counts, [status]: 1}), {});
      ids.reduce<number[]>((result, entry) => { result = []; return [...result, entry]; }, []);
    }
  `),
    [],
  );
});

test('fixed-size and one-step reductions do not grow an accumulator repeatedly', () => {
  const findings = lint(
    [
      'declare const ids: number[];',
      'ids.reduce<number[]>((items, id) => [...items, ...[]], []);',
      "ids.reduce<number[]>((items, id) => [...'', ...items], []);",
      '[1].reduce<number[]>((items, id) => [...items, id], []);',
      '[[1], [2]].reduce((items, row) => [...items, ...row]);',
      'ids.reduce<number[]>((items, id) => { items.length = 0; return [...items, id]; }, []);',
      '[...ids].reduce<number[]>((items, id) => [...items, id], []);',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [['reduce-copy-accumulator', 7]],
  );
});

test('a changing lookup cannot be indexed once for the entire loop', () => {
  const findings = lint(
    [
      'function check(allowed: number[], batches: number[][], ids: number[]) {',
      "  for (const id of ids) { allowed['push'](id); allowed.includes(id); }",
      '  for (allowed of batches) { allowed.includes(1); }',
      "  for (const id of ids) { allowed['at'](id); allowed.includes(id); }",
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [['array-repeated-membership', 4]],
  );
});

test(
  'a rebuilt program checks writes again when it reuses source trees',
  { skip: process.env.PERF_CHECK_TEST_NATIVE === '1' && 'rebuilds a TypeScript 6 program' },
  (context) => {
    const source = 'function run(ids: number[]) { for (const id of ids) { ids.push(id); ids.includes(id); } }';
    const { analyzeFile }: typeof PerformanceAnalyze = require('../../lib/performance/analyze.cjs');
    withProgram(source, {}, (program: ProgramAdapter, sourceFile: SourceFile) => {
      assert.deepEqual(analyzeFile(program, sourceFile), []);
      const options = program.getCompilerOptions();
      const host = ts.createCompilerHost(options, true);
      const original = typeScriptProgramOf(program);
      host.getSourceFile = (filename) => original.getSourceFile(filename);
      const rebuilt = ts.createProgram(original.getRootFileNames(), options, host, original);
      assert.equal(rebuilt.getSourceFile(sourceFile.fileName), sourceFile);
      assert.notEqual(rebuilt.getTypeChecker(), program.getTypeChecker());
      const symbolLookup = context.mock.method(rebuilt.getTypeChecker(), 'getSymbolAtLocation');
      assert.deepEqual(analyzeFile(rebuilt, sourceFile), []);
      const mutationPosition = source.indexOf('ids.push');
      assert.ok(symbolLookup.mock.calls.some(({ arguments: [node] }) => node.getStart() === mutationPosition));
    });
  },
);

test('existence checks use the filtered length only for truthiness or comparison with zero', () => {
  const findings = lint(
    [
      'function accepts(version: (string | symbol)[], extractedVersion: string[], ready: boolean) {',
      '  if (ready && version.filter(v => extractedVersion.includes(v as string)).length) return true;',
      '  if (!version.filter(v => v === "latest").length) return false;',
      '  if (0 < version.filter(v => v === "v2").length) return true;',
      '  if (version.filter(v => v === "v3").length > 0) return true;',
      '  if (version.filter(v => v === "v4").length !== 0) return true;',
      '  return version.filter(v => v === "v5").length === 0;',
      '}',
    ].join('\n'),
  ).filter((finding: Finding) => finding.ruleId === 'filter-for-existence');
  assert.deepEqual(
    findings.map((finding: Finding) => finding.line),
    [2, 3, 4, 5, 6, 7],
  );
  const last = findings.at(-1);
  assert.ok(last);
  assert.match(last.message, /!some\(\)/);
});

test('filter skips observed counts, numeric thresholds, effects, accessors and unknown implementations', () => {
  const findings = lint(`
    function observed(rows: number[], audit: (id: number) => boolean) {
      let count = 0;
      const exact = rows.filter(row => row > 0).length;
      if (rows.filter(row => row > 0).length > 1) return exact;
      if (rows.filter(async row => row > 0).length) return 1;
      if (rows.filter(row => ++count > row).length) return 2;
      if (rows.filter(row => audit(row)).length) return 3;
      if (rows.filter(row => { audit(row); return row > 0; }).length) return 4;
      const custom = { filter(fn: (value: number) => boolean) { return [fn(2)]; } };
      if (custom.filter(value => value > 0).length) return 5;
      class Row { get active() { count++; return count > 0; } }
      if ([new Row()].filter(row => row.active).length) return 6;
      return rows.filter(row => row > 0).length && exact;
    }
  `).filter((finding: Finding) => finding.ruleId === 'filter-for-existence');
  assert.deepEqual(findings, []);
});

test('findIndex inside a loop is reported like find, without the find fix details', () => {
  const findings = lint(`export function positions(items: { id: string }[], rows: { id: string }[]) {
  return rows.map((row) => items.findIndex((item) => item.id === row.id));
}`).filter((finding: Finding) => finding.ruleId === 'array-repeated-find');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /with findIndex\(\)/);
  assert.equal(findings[0].fix, undefined);
});
