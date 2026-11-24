import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint } from './helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';
import type { FileMap } from '../types/project-files.cjs';

function contexts(source: string, ruleId: string, files: FileMap = {}) {
  return lint(source, files)
    .filter((finding: Finding) => finding.ruleId === ruleId)
    .map(({ line, contextualReason }) => [line, Boolean(contextualReason)]);
}

test('a find over one record child list is contextual, a find over a fetched list is not', () => {
  const source = [
    'type Option = { id: string }; type Product = { options?: Option[] }; type Variant = { options: { option_id: string }[] };',
    'export function flatten(product: Product, variant: Variant) {',
    '  const options = product.options ?? [];',
    '  return variant.options.map((option) => options.find((candidate) => candidate.id === option.option_id));',
    '}',
    'export function restore(ids: string[], fetched: { rows: Option[] }, orders: Option[]) {',
    '  const rows = fetched.rows;',
    '  ids.map((id) => rows.find((row) => row.id === id));',
    '  return ids.map((id) => orders.find((order) => order.id === id));',
    '}',
  ].join('\n');
  assert.deepEqual(contexts(source, 'array-repeated-find'), [
    [4, true],
    [8, false],
    [9, false],
  ]);
});

test('a find in a UI module exporting a hook is contextual, a UI service without hooks is not', () => {
  const hookModule = [
    "import { useMemo } from 'react';",
    'type Option = { value: string };',
    'export function expand(values: string[], options: Option[]) {',
    '  return values.map((value) => options.find((option) => option.value === value));',
    '}',
    'export function useFilters() { return useMemo(() => 1, []); }',
  ].join('\n');
  assert.deepEqual(contexts(hookModule, 'array-repeated-find'), [[4, true]]);
  const service = [
    "import { ref } from 'vue';",
    'type Collection = { id: string; parentID: string };',
    'export const state = ref(0);',
    'export function parents(collections: Collection[]) {',
    '  return collections.map((collection) => collections.find((other) => other.id === collection.parentID));',
    '}',
  ].join('\n');
  assert.deepEqual(contexts(service, 'array-repeated-find'), [[5, false]]);
});

test('sync fs in the function that creates the Nest application is contextual', () => {
  const source = [
    "import fs from 'node:fs';",
    'declare const NestFactory: { create(module: unknown): Promise<{ init(): Promise<void> }> };',
    'export async function emitSchema() {',
    '  const app = await NestFactory.create({});',
    '  await app.init();',
    "  fs.writeFileSync('schema.gql', '');",
    '}',
    'export async function handle(path: string) {',
    '  return fs.readFileSync(path);',
    '}',
  ].join('\n');
  assert.deepEqual(contexts(source, 'node-sync-fs-in-async'), [
    [6, true],
    [9, false],
  ]);
});

test('sync fs in private methods reached only from init or a cached first call is contextual', () => {
  const source = [
    "import { existsSync } from 'node:fs';",
    'export class MapRepository {',
    '  private names?: Promise<string[]>;',
    '  async init() { await this.importGeodata(); }',
    '  private async importGeodata() { await this.loadAdmin("admin1"); }',
    '  private async loadAdmin(path: string) { return existsSync(path); }',
    '  async reverseGeocode() { this.names ??= this.readNames(); return this.names; }',
    '  private async readNames() { existsSync("countries"); return []; }',
    '  async read(path: string) { return this.resolve(path); }',
    '  private async resolve(path: string) { return existsSync(path); }',
    '}',
  ].join('\n');
  assert.deepEqual(contexts(source, 'node-sync-fs-in-async'), [
    [6, true],
    [8, true],
    [10, false],
  ]);
});

test('sync fs in a private method called twice from the same startup-only caller is contextual', () => {
  const source = [
    "import { existsSync } from 'node:fs';",
    'export class MapRepository {',
    '  async init() { await this.importGeodata(); }',
    '  private async importGeodata() { await Promise.all([this.loadAdmin("admin1"), this.loadAdmin("admin2")]); }',
    '  private async loadAdmin(path: string) { return existsSync(path); }',
    '}',
  ].join('\n');
  assert.deepEqual(contexts(source, 'node-sync-fs-in-async'), [[5, true]]);
});

test('reduces over a generic object, enum lists, finite keys or inside a hook callback are contextual', () => {
  const source = [
    "import { useMemo } from 'react';",
    'enum Worker { Mail = "mail", Sms = "sms" }',
    'type Part = { type: "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j"; value: string };',
    'export function nullable<T extends Record<string, unknown>>(data: T) {',
    '  return Object.entries(data).reduce((acc, [key, value]) => ({ ...acc, [key]: value ?? null }), {});',
    '}',
    'export function jobs(workers: Worker[], table: Record<string, string[]>) {',
    '  return workers.reduce<string[]>((acc, worker) => [...acc, ...table[worker]], []);',
    '}',
    'export function parts(list: Part[]) {',
    '  return list.reduce((acc, { type, value }) => ({ ...acc, [type]: value }), {});',
    '}',
    'export function Tree(props: { ids: string[] }) {',
    '  return useMemo(() => props.ids.reduce<string[]>((acc, id) => [...acc, id], []), [props.ids]);',
    '}',
  ].join('\n');
  assert.deepEqual(contexts(source, 'reduce-copy-accumulator'), [
    [5, true],
    [8, true],
    [11, true],
    [14, true],
  ]);
});

test('reduces keyed by stored records stay reported, even in a UI module', () => {
  const source = [
    "import { useMemo } from 'react';",
    'type Row = { id: string; group: string };',
    'export function groups(rows: Row[]) {',
    '  return rows.reduce((acc, row) => ({ ...acc, [row.id]: row.group }), {});',
    '}',
    'export function flatten(fields: { fields?: string[] }[]) {',
    '  return fields.reduce<string[]>((acc, item) => [...acc, ...(item.fields ?? [])], []);',
    '}',
    'export const memo = useMemo;',
  ].join('\n');
  assert.deepEqual(contexts(source, 'reduce-copy-accumulator'), [
    [4, false],
    [7, false],
  ]);
});
