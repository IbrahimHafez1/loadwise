import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { checkReactBugs } from '../../lib/reliability/react-bugs.js';
import { withProgram } from '../performance/helpers.js';

const packages = {
  'node_modules/react/index.d.ts': `
    export declare function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
    export declare function useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void];
  `,
};
const options = { lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], jsx: ts.JsxEmit.Preserve };

function ruleIds(source: string, fileName = 'view.tsx'): string[] {
  return withProgram(
    'export {};',
    { ...packages, [fileName]: source },
    (program) => {
      assert.ok(program.getSourceFiles);

      const sourceFile = program.getSourceFiles().find((file) => file.fileName.endsWith(fileName));
      assert.ok(sourceFile);
      return checkReactBugs(sourceFile, fileName, program.getTypeChecker()).map(({ ruleId }) => ruleId);
    },
    options,
  );
}

const reactImport = "import { useEffect, useState } from 'react';\n";

test('react-effect-sets-state-every-render reports a fresh value set by an effect with no dependencies', () => {
  const source = `${reactImport}export function View() {
    const [items, setItems] = useState<number[]>([]);
    useEffect(() => {
      setItems([1, 2]);
    });
    return null;
  }`;
  assert.deepEqual(ruleIds(source), ['react-effect-sets-state-every-render']);
});

test('react-effect-sets-state-every-render ignores dependency arrays, guards and values that bail out', () => {
  const body = (effect: string) => `${reactImport}export function View() {
    const [count, setCount] = useState(0);
    const [mounted, setMounted] = useState(false);
    ${effect}
    return null;
  }`;
  assert.deepEqual(ruleIds(body('useEffect(() => { setCount((previous) => previous + 1); }, []);')), []);
  assert.deepEqual(ruleIds(body('useEffect(() => { setMounted(true); });')), []);
  assert.deepEqual(ruleIds(body('useEffect(() => { if (count < 3) setCount((previous) => previous + 1); });')), []);
  assert.deepEqual(
    ruleIds(body('useEffect(() => { if (mounted) return; setCount((previous) => previous + 1); });')),
    [],
  );
});

test('react-effect-sets-state-every-render needs the hook to come from react', () => {
  const source = `function useEffect(callback: () => void) { callback(); }
    export function View() {
      const [items, setItems] = [[], (value: unknown) => value];
      useEffect(() => { setItems([1]); });
    }`;
  assert.deepEqual(ruleIds(source), []);
});

test('react-async-effect-callback reports an async effect and accepts an inner async function', () => {
  assert.deepEqual(ruleIds(`${reactImport}useEffect(async () => { await fetch('/a'); }, []);`), [
    'react-async-effect-callback',
  ]);
  assert.deepEqual(
    ruleIds(`${reactImport}useEffect(() => { const load = async () => { await fetch('/a'); }; void load(); }, []);`),
    [],
  );
});

test('react-state-mutated-in-place reports a mutation passed to its own setter', () => {
  const source = (statements: string) => `${reactImport}export function View() {
    const [items, setItems] = useState<number[]>([]);
    function add(item: number) {
      ${statements}
    }
    return null;
  }`;
  assert.deepEqual(ruleIds(source('items.push(item); setItems(items);')), ['react-state-mutated-in-place']);
  assert.deepEqual(ruleIds(source('items.sort(); setItems(items);')), ['react-state-mutated-in-place']);
  assert.deepEqual(ruleIds(source('items[0] = item; setItems(items);')), ['react-state-mutated-in-place']);
  assert.deepEqual(ruleIds(source('const next = [...items]; next.push(item); setItems(next);')), []);
  assert.deepEqual(ruleIds(source('setItems([...items, item]);')), []);
  assert.deepEqual(ruleIds(source('items.push(item);')), []);
});

test('react-list-missing-key reports elements and fragments without a key', () => {
  const source = (item: string) => `export function List({ rows }: { rows: string[] }) {
    return <ul>{rows.map((row) => ${item})}</ul>;
  }`;
  assert.deepEqual(ruleIds(source('<li>{row}</li>')), ['react-list-missing-key']);
  assert.deepEqual(ruleIds(source('<><li>{row}</li></>')), ['react-list-missing-key']);
  assert.deepEqual(ruleIds(source('<li key={row}>{row}</li>')), []);
  assert.deepEqual(ruleIds(source('<li {...{ key: row }}>{row}</li>')), []);
  assert.deepEqual(ruleIds(source('row.length')), []);
});

test('react-list-missing-key skips Children.map, non-array receivers and non-React JSX', () => {
  const children = `import { Children } from 'react';
    export const View = ({ children }: { children: unknown }) => <div>{Children.map(children, (child) => <b>{child}</b>)}</div>;`;
  assert.deepEqual(ruleIds(children), []);
  const solid = `import { For } from 'solid-js';
    export const View = ({ rows }: { rows: string[] }) => <ul>{rows.map((row) => <li>{row}</li>)}</ul>;`;
  assert.deepEqual(ruleIds(solid), []);
  const collection = `declare const list: { map(callback: (value: string) => unknown): unknown };
    export const View = () => <ul>{list.map((row) => <li>{row}</li>)}</ul>;`;
  assert.deepEqual(ruleIds(collection), []);
});

test('next-server-env-in-client reports server variables in a use client file only', () => {
  const read = (directive: string, expression: string) => `${directive}\nexport const value = ${expression};`;
  assert.deepEqual(ruleIds(read("'use client';", 'process.env.DATABASE_URL'), 'client.ts'), [
    'next-server-env-in-client',
  ]);
  assert.deepEqual(ruleIds(read("'use client';", "process.env['API_SECRET']"), 'client.ts'), [
    'next-server-env-in-client',
  ]);
  assert.deepEqual(ruleIds(read("'use client';", 'process.env.NEXT_PUBLIC_URL'), 'client.ts'), []);
  assert.deepEqual(ruleIds(read("'use client';", 'process.env.NODE_ENV'), 'client.ts'), []);
  assert.deepEqual(ruleIds(read('', 'process.env.DATABASE_URL'), 'server.ts'), []);
  assert.deepEqual(
    ruleIds(
      "'use client';\nexport const value = typeof window === 'undefined' ? process.env.DATABASE_URL : undefined;",
      'client.ts',
    ),
    [],
  );
});

const stateView = (effect: string) => `${reactImport}export function View() {
    const [items, setItems] = useState<number[]>([]);
    const [ready, setReady] = useState(false);
    const [count, setCount] = useState(0);
    ${effect}
    return null;
  }`;
const loopRule = ['react-effect-sets-state-every-render'];

test('react-effect-sets-state-every-render covers expression bodies, returns, undefined dependencies and block updaters', () => {
  assert.deepEqual(ruleIds(stateView('useEffect(() => setItems([]));')), loopRule);
  assert.deepEqual(ruleIds(stateView('useEffect(() => { return setItems([1]); });')), loopRule);
  assert.deepEqual(ruleIds(stateView('useEffect(() => { setItems([1]); }, undefined);')), loopRule);
  assert.deepEqual(
    ruleIds(stateView('useEffect(() => { setCount((previous) => { return previous + 1; }); });')),
    loopRule,
  );
});

test('react-effect-sets-state-every-render ignores updaters that settle on the current value', () => {
  assert.deepEqual(ruleIds(stateView('useEffect(() => { setReady((previous) => previous || true); });')), []);
  assert.deepEqual(ruleIds(stateView('useEffect(() => { setCount((previous) => previous + 0); });')), []);
  assert.deepEqual(ruleIds(stateView('useEffect(() => { setCount((previous) => previous * 1); });')), []);
});

test('react-async-effect-callback resolves an effect callback passed by name', () => {
  const declared = `${reactImport}async function load() { await fetch('/a'); }
    useEffect(load, []);`;
  assert.deepEqual(ruleIds(declared), ['react-async-effect-callback']);
  const assigned = `${reactImport}const load = async () => { await fetch('/a'); };
    useEffect(load, []);`;
  assert.deepEqual(ruleIds(assigned), ['react-async-effect-callback']);
});

test('react-state-mutated-in-place sees compound writes, collections, aliases and nested state', () => {
  const view = (statements: string) => `${reactImport}export function View() {
    const [items, setItems] = useState<number[]>([]);
    const [state, setState] = useState({ count: 0, items: [] as number[] });
    const [seen, setSeen] = useState(new Set<number>());
    const [lookup, setLookup] = useState(new Map<number, number>());
    function update(item: number) {
      ${statements}
    }
    return null;
  }`;
  const flagged = ['react-state-mutated-in-place'];
  assert.deepEqual(ruleIds(view('state.count += 1; setState(state);')), flagged);
  assert.deepEqual(ruleIds(view('state.count++; setState(state);')), flagged);
  assert.deepEqual(ruleIds(view('state.items.push(item); setState(state);')), flagged);
  assert.deepEqual(ruleIds(view('seen.add(item); setSeen(seen);')), flagged);
  assert.deepEqual(ruleIds(view('lookup.delete(item); setLookup(lookup);')), flagged);
  assert.deepEqual(ruleIds(view('const alias = items; alias.push(item); setItems(items);')), flagged);
  assert.deepEqual(ruleIds(view('const next = [...items]; next.push(item); setItems(next);')), []);
  assert.deepEqual(ruleIds(view('items.map((value) => value).sort(); setItems(items);')), []);
  assert.deepEqual(ruleIds(view('const helper = () => { items.push(item); }; setItems(items);')), []);
  assert.deepEqual(ruleIds(view('[1].forEach((value) => items.push(value)); setItems(items);')), flagged);
});

test('react-list-missing-key resolves named callbacks, array unions and JavaScript files', () => {
  const named = `const renderRow = (row: string) => <li>{row}</li>;
    export const List = ({ rows }: { rows: string[] }) => <ul>{rows.map(renderRow)}</ul>;`;
  assert.deepEqual(ruleIds(named), ['react-list-missing-key']);
  const union = `export const List = ({ rows }: { rows: string[] | number[] }) => <ul>{rows.map((row) => <li>{row}</li>)}</ul>;`;
  assert.deepEqual(ruleIds(union), ['react-list-missing-key']);
  const script = `export const List = ({ rows }) => <ul>{rows.map((row) => <li>{row}</li>)}</ul>;`;
  assert.deepEqual(ruleIds(script, 'list.js'), ['react-list-missing-key']);
});

test('react-list-missing-key skips a file that selects a keyless JSX runtime without importing it', () => {
  const solid = `/** @jsxImportSource solid-js */
    export const List = ({ rows }: { rows: string[] }) => <ul>{rows.map((row) => <li>{row}</li>)}</ul>;`;
  assert.deepEqual(ruleIds(solid), []);
});

test('next-server-env-in-client follows the guard branch, computed keys and destructuring', () => {
  const client = (expression: string) => `'use client';\nexport const value = ${expression};`;
  const flagged = ['next-server-env-in-client'];
  const serverFirst = "typeof window === 'undefined'";
  const browserFirst = "typeof window !== 'undefined'";
  assert.deepEqual(ruleIds(client(`${serverFirst} ? undefined : process.env.API_SECRET`), 'client.ts'), flagged);
  assert.deepEqual(ruleIds(client(`${browserFirst} ? process.env.API_SECRET : undefined`), 'client.ts'), flagged);
  assert.deepEqual(ruleIds(client(`${browserFirst} ? undefined : process.env.API_SECRET`), 'client.ts'), []);
  assert.deepEqual(ruleIds(client('process.env[String(Math.random())]'), 'client.ts'), flagged);
  assert.deepEqual(ruleIds("'use client';\nconst { API_SECRET } = process.env;\nexport {};", 'client.ts'), flagged);
  assert.deepEqual(ruleIds("'use client';\nconst { NEXT_PUBLIC_URL } = process.env;\nexport {};", 'client.ts'), []);
});

test('next-server-env-in-client never tells developers to pass the raw value to a Client Component', () => {
  const sourceText = "'use client';\nexport const value = process.env.DATABASE_URL;";
  const messages = withProgram(
    'export {};',
    { 'client.ts': sourceText },
    (program) => {
      assert.ok(program.getSourceFiles);
      const sourceFile = program.getSourceFiles().find((file) => file.fileName.endsWith('client.ts'));
      assert.ok(sourceFile);
      return checkReactBugs(sourceFile, 'client.ts', program.getTypeChecker()).map(({ message }) => message);
    },
    options,
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? '', /non-sensitive derived value/);
  assert.doesNotMatch(messages[0] ?? '', /pass it down/);
});

test('react-async-effect-callback resolves an overloaded function to its async implementation', () => {
  const overloaded = `${reactImport}function load(kind: string): Promise<void>;
function load(kind: number): Promise<void>;
async function load(kind: unknown): Promise<void> { await fetch(String(kind)); }
useEffect(load, []);`;
  assert.deepEqual(ruleIds(overloaded), ['react-async-effect-callback']);
  assert.deepEqual(
    ruleIds(`${reactImport}declare function load(): void;
useEffect(load, []);`),
    [],
  );
});
