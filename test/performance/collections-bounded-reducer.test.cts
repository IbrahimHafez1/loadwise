import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { lint, withProgram } from './helpers.cjs';
import { analyzeFile } from '../../lib/performance/analyze.cjs';
import type { ProgramAdapter } from '../../lib/shared/types.cjs';
import type { FileMap } from '../types/project-files.cjs';
import { reasonOf } from '../types/finding-reason.cjs';
import { sourceFileOf } from '../types/program-files.cjs';

function copyingReducers(source: string) {
  return lint(source).filter(({ ruleId }) => ruleId === 'reduce-copy-accumulator');
}

test('reducers over a small fixed set of own object properties do not report growing copies', () => {
  const findings = copyingReducers(`
    function options(port: number) {
      Object.entries({ host: 'localhost', port, tls: true, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })
        .reduce<Record<string, unknown>>((result, [key, value]) => {
        if (value !== undefined) return { ...result, [key]: value };
        return result;
      }, {});
      Object.keys({ host: 'localhost', port }).reduce<string[]>((list, key) => [...list, key], []);
      Object.values({ host: 'localhost', port }).reduce<unknown[]>((list, value) => [...list, value], []);
    }
  `);
  assert.equal(findings.length, 0);
});

test('reducers still report when the object source or enumeration is not statically bounded', () => {
  const findings = copyingReducers(`
    function options(options: Record<string, number>, key: string) {
      Object.keys(options).reduce<string[]>((list, name) => [...list, name], []);
      Object.keys({ ...options }).reduce<string[]>((list, name) => [...list, name], []);
      Object.keys({ [key]: 1 }).reduce<string[]>((list, name) => [...list, name], []);
      Object.keys({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9,
        j: 10, k: 11, l: 12, m: 13, n: 14, o: 15, p: 16, q: 17 })
        .reduce<string[]>((list, name) => [...list, name], []);
    }
    function custom(names: string[]) {
      const Object = { keys(_input: object) { return names; } };
      Object.keys({ a: 1 }).reduce<string[]>((list, name) => [...list, name], []);
    }
  `);
  assert.equal(findings.length, 5);
});

test('reducers still report when the same file replaces the built-in enumeration method', () => {
  const findings = copyingReducers(`
    function options(names: string[]) {
      Object.keys = () => names;
      return Object.keys({ a: 1 }).reduce<string[]>((list, name) => [...list, name], []);
    }
  `);
  assert.equal(findings.length, 1);
});

function reducerContexts(source: string, files: FileMap = {}) {
  return lint(source, files)
    .filter(({ ruleId }) => ruleId === 'reduce-copy-accumulator')
    .map(({ line, contextualReason }) => [line, Boolean(contextualReason)]);
}

test('reducers over a constant lookup table or a const-asserted short list are contextual', () => {
  const files = {
    'constants.ts': [
      "export const LANGUAGE_CODES = ['de', 'en', 'fr', 'es', 'it', 'nl', 'pl', 'pt', 'ja', 'ko', 'zh'] as const;",
      'export const HEADER_CONFIG: Record<string, { required: boolean }> = { a: { required: true }, b: { required: false } };',
    ].join('\n'),
  };
  const source = [
    "import { LANGUAGE_CODES, HEADER_CONFIG } from './constants';",
    'export const instances = LANGUAGE_CODES.reduce((acc, code) => ({ ...acc, [code]: code }), {});',
    'export const headers = Object.entries(HEADER_CONFIG).reduce((acc, [name, header]) => ({ ...acc, [name]: header }), {});',
  ].join('\n');
  assert.deepEqual(reducerContexts(source, files), [
    [2, true],
    [3, true],
  ]);
});

test('reducers over a growing list stay reported at default level beside the bounded shapes', () => {
  const files = { 'constants.ts': 'export const HEADER_CONFIG: Record<string, number> = { a: 1 };' };
  const source = [
    "import { HEADER_CONFIG } from './constants';",
    'export function grow(ids: string[]) {',
    '  Object.keys(HEADER_CONFIG).push("x");',
    '  return ids.reduce((acc, id) => ({ ...acc, [id]: true }), {});',
    '}',
  ].join('\n');
  assert.deepEqual(reducerContexts(source, files), [[4, false]]);
});

test('reducers over the entries of a small declared object type are contextual', () => {
  const source = [
    'interface Channels { email?: boolean; sms?: boolean; push?: boolean }',
    'export function toPreferences(channels: Channels) {',
    '  return Object.entries(channels).reduce((acc, [channel, enabled]) => ({ ...acc, [channel]: { enabled } }), {});',
    '}',
    'export function toIndexed(channels: Record<string, boolean>) {',
    '  return Object.entries(channels).reduce((acc, [channel, enabled]) => ({ ...acc, [channel]: { enabled } }), {});',
    '}',
  ].join('\n');
  assert.deepEqual(reducerContexts(source), [
    [3, true],
    [6, false],
  ]);
});

test('reducers over the arguments of a param decorator are contextual', () => {
  const source = [
    'declare function createParamDecorator(factory: (data: string[] | undefined, context: unknown) => unknown): unknown;',
    'export const Pick = createParamDecorator((data, context) => {',
    '  if (!data) return undefined;',
    '  return data.reduce((prev, curr) => ({ ...prev, [curr]: curr }), {});',
    '});',
    'export function pickAll(keys: string[]) {',
    '  return keys.reduce((prev, curr) => ({ ...prev, [curr]: curr }), {});',
    '}',
  ].join('\n');
  assert.deepEqual(reducerContexts(source), [
    [4, true],
    [7, false],
  ]);
});

test('reducers in a test source are contextual while server sources stay reported', () => {
  const source =
    'export const index = (names: string[]) => names.reduce((acc, name) => ({ ...acc, [name]: name }), {});';
  const contexts = (fileName: string) =>
    withProgram('export {};', { [fileName]: source }, (program: ProgramAdapter) =>
      analyzeFile(program, sourceFileOf(program, path.join(__dirname, 'virtual-project', fileName)))
        .filter(({ ruleId }) => ruleId === 'reduce-copy-accumulator')
        .map(({ contextualReason }) => Boolean(contextualReason)),
    );
  assert.deepEqual(contexts('helpers.spec.ts'), [true]);
  assert.deepEqual(contexts('service.ts'), [false]);
});

test('a top-level reduce runs once at module load and is contextual, while the same reduce in a function still reports', () => {
  const findings = copyingReducers(`
    declare const exportedNames: string[];
    export const atLoad = exportedNames.reduce<Record<string, boolean>>((acc, name) => ({ ...acc, [name]: true }), {});
    export function perRequest(names: string[]) {
      return names.reduce<Record<string, boolean>>((acc, name) => ({ ...acc, [name]: true }), {});
    }
  `);
  const [atLoad, perRequest] = findings;
  assert.match(reasonOf(atLoad), /once when the module loads/);
  assert.equal(perRequest.contextualReason, undefined);
});

test('a reduce in a JSX component module is contextual, while the same reduce in a server module still reports', () => {
  const source =
    'export const index = (names: string[]) => names.reduce((acc, name) => ({ ...acc, [name]: name }), {});';
  const contexts = (fileName: string) =>
    withProgram('export {};', { [fileName]: source }, (program: ProgramAdapter) =>
      analyzeFile(program, sourceFileOf(program, path.join(__dirname, 'virtual-project', fileName)))
        .filter(({ ruleId }) => ruleId === 'reduce-copy-accumulator')
        .map(({ contextualReason }) => Boolean(contextualReason)),
    );
  assert.deepEqual(contexts('Panel.tsx'), [true]);
  assert.deepEqual(contexts('panel.ts'), [false]);
});

test('a reduce whose object accumulator is typed with fixed named keys is contextual, while an indexed accumulator still reports', () => {
  const source = [
    "enum Channel { Email = 'email', Sms = 'sms' }",
    'type ChannelSettings = Record<Channel, { enabled: boolean }>;',
    'export function toSettings(entries: [string, boolean][]) {',
    '  return entries.reduce((acc, [channel, enabled]) => ({ ...acc, [channel]: { enabled } }), {} as ChannelSettings);',
    '}',
    'export function toIndexed(entries: [string, boolean][]) {',
    '  return entries.reduce<Record<string, boolean>>((acc, [channel, enabled]) => ({ ...acc, [channel]: enabled }), {});',
    '}',
    'export function toUntyped(names: string[]) {',
    '  return names.reduce((acc, name) => ({ ...acc, [name]: true }), {});',
    '}',
    'export function toList(names: string[]) {',
    '  return names.reduce((acc, name) => [...acc, name], [] as string[]);',
    '}',
  ].join('\n');
  assert.deepEqual(reducerContexts(source), [
    [4, true],
    [7, false],
    [10, false],
    [13, false],
  ]);
});

test('a reduce whose accumulator type mixes named keys with an index signature still reports', () => {
  const source = [
    'interface Totals { count: number; [key: string]: number }',
    'export function toTotals(names: string[]) {',
    '  return names.reduce((acc, name) => ({ ...acc, [name]: 1 }), { count: 0 } as Totals);',
    '}',
  ].join('\n');
  assert.deepEqual(reducerContexts(source), [[3, false]]);
});

test('a reduce over the properties of a JSON Schema object is contextual, while other property maps still report', () => {
  const source = [
    'type SchemaDto = { type?: string; required?: string[]; properties?: Record<string, SchemaDto | boolean> };',
    'type Lookup = { properties?: Record<string, number> };',
    'export function defaults(schema: SchemaDto | boolean) {',
    "  const properties = typeof schema === 'object' ? (schema.properties ?? {}) : {};",
    '  return Object.keys(properties).reduce((acc, key) => ({ ...acc, [key]: null }), {});',
    '}',
    'export function direct(schema: SchemaDto) {',
    '  return Object.entries(schema.properties ?? {}).reduce((acc, [key]) => ({ ...acc, [key]: null }), {});',
    '}',
    'export function indexed(lookup: Lookup) {',
    '  return Object.keys(lookup.properties ?? {}).reduce((acc, key) => ({ ...acc, [key]: null }), {});',
    '}',
  ].join('\n');
  assert.deepEqual(reducerContexts(source), [
    [5, true],
    [8, true],
    [11, false],
  ]);
});
