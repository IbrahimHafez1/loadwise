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
