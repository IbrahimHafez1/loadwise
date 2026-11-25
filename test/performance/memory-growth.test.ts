import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';
import { reasonOf } from '../types/finding-reason.js';

const CACHE_RULE = 'unbounded-module-cache';
const PAYLOAD_RULE = 'whole-payload-in-memory';
const files = {
  'node_modules/@nestjs/common/index.d.ts': `export declare function Controller(path?: string): ClassDecorator;
    export declare function Get(path?: string): MethodDecorator;
    export declare function Injectable(options?: object): ClassDecorator;
    export declare const Scope: { REQUEST: number };`,
};
const fetchTypes = `interface Response { arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>; body: unknown }
declare function fetch(url: string): Promise<Response>;
declare const Buffer: { from(value: unknown): Uint8Array; concat(chunks: Uint8Array[]): Uint8Array };
declare const sink: { write(value: unknown): void };
`;

function findings(source: string, rule: string) {
  return lint(source, files).filter((finding: Finding) => finding.ruleId === rule);
}

const cacheFindings = (source: string) => findings(source, CACHE_RULE);
const payloadFindings = (source: string) => findings(source, PAYLOAD_RULE);

test('reports a module-level Map that is filled per key and never evicted', () => {
  const [finding] = cacheFindings(`const userCache = new Map<string, object>();
export async function load(id: string) {
  const hit = userCache.get(id);
  if (hit) return hit;
  const value = { id };
  userCache.set(id, value);
  return value;
}`);
  assert.ok(finding);
  assert.match(finding.message, /`userCache` only grows/);
});

test('reports object caches written by key and singleton service fields', () => {
  const found = cacheFindings(`import { Injectable } from '@nestjs/common';
const lookupCache: Record<string, number> = {};
export function remember(key: string) { lookupCache[key] = key.length; }
export function recall(key: string) { return lookupCache[key]; }
@Injectable()
export class Service {
  private readonly computed = new Map<string, number>();
  private readonly resultCache = new Map<string, string>();
  compute(id: string) {
    const hit = this.computed.get(id);
    if (hit !== undefined) return hit;
    this.computed.set(id, id.length);
    return id.length;
  }
  store(id: string) { this.resultCache.set(id, id); }
  fetch(id: string) { return this.resultCache.get(id); }
}`);
  assert.equal(found.length, 3);
});

test('reports one finding per collection however many writes it has', () => {
  assert.equal(
    cacheFindings(`const memoCache = new Map<string, number>();
export function a(key: string) { memoCache.set(key, 1); }
export function b(key: string) { memoCache.set(key, 2); }
export function c(key: string) { return memoCache.get(key); }`).length,
    1,
  );
});

test('stays silent when the collection is evicted, measured, reset, exported or handed elsewhere', () => {
  assert.deepEqual(
    cacheFindings(`declare function track(value: unknown): void;
const deleted = new Map<string, number>();
export function a(key: string) { deleted.set(key, 1); setTimeout(() => deleted.delete(key), 1000); }
const capped = new Map<string, number>();
export function b(key: string) { if (capped.size > 100) capped.clear(); capped.set(key, 1); }
let reset = new Map<string, number>();
export function c(key: string) { reset.set(key, 1); }
export function resetAll() { reset = new Map(); }
export const shared = new Map<string, number>();
export function d(key: string) { shared.set(key, 1); }
const passed = new Map<string, number>();
export function e(key: string) { passed.set(key, 1); track(passed); }`),
    [],
  );
});

test('stays silent for fixed keys, request-scoped services and collections that are not caches', () => {
  assert.deepEqual(
    cacheFindings(`import { Injectable, Scope } from '@nestjs/common';
const fixedCache = new Map<string, number>();
export function a() { fixedCache.set('config', 1); }
const names = new Set<string>();
export function b(name: string) { names.add(name); }
@Injectable({ scope: Scope.REQUEST })
export class PerRequest {
  private readonly cache = new Map<string, string>();
  store(id: string) { this.cache.set(id, id); }
}
const rows: string[] = [];
export function c(row: string) { rows.push(row); }`),
    [],
  );
});

test('reports a growing array only when it is named like a cache or history', () => {
  assert.equal(
    cacheFindings(`const requestHistory: string[] = [];
export function record(url: string) { requestHistory.push(url); }`).length,
    1,
  );
});

const fsImports = `import { readFile } from 'node:fs/promises';
import * as fs from 'node:fs';
declare function readUpload(): Promise<unknown>;
`;

test('reports a request-derived path read whole into memory', () => {
  const found = payloadFindings(`${fsImports}
export async function download(req: { params: { name: string } }, res: { send(value: unknown): void }) {
  const target = '/var/files/' + req.params.name;
  res.send(await readFile(target));
  res.send(fs.readFileSync(req.params.name));
}`);
  assert.equal(found.length, 2);
});

test('stays silent for fixed paths and for reads outside request handlers', () => {
  assert.deepEqual(
    payloadFindings(`${fsImports}
export async function health(req: unknown, res: { send(value: unknown): void }) { res.send(await readFile('/etc/version')); }
export async function job(name: string) { return readFile(name); }`),
    [],
  );
});

test('reports a downloaded body buffered only to be written out', () => {
  const found = payloadFindings(`${fetchTypes}
export async function save(url: string) {
  const response = await fetch(url);
  const bytes = await response.arrayBuffer();
  sink.write(Buffer.from(bytes));
}`);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /pipeline/);
});

test('stays silent when the downloaded body is used for something else', () => {
  assert.deepEqual(
    payloadFindings(`${fetchTypes}
export async function inspect(url: string) {
  const response = await fetch(url);
  const text = await response.text();
  sink.write(text);
  return text.length;
}`),
    [],
  );
});

test('reports stream chunks concatenated only to be written out', () => {
  const found = payloadFindings(`${fetchTypes}
export async function copy(source: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  sink.write(Buffer.concat(chunks));
}`);
  assert.equal(found.length, 1);
});

test('stays silent when the concatenated buffer is parsed or the chunks are not streamed', () => {
  assert.deepEqual(
    payloadFindings(`${fetchTypes}
declare function parse(value: unknown): unknown;
export async function read(source: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return parse(Buffer.concat(chunks));
}
export function join(parts: Uint8Array[]) {
  const chunks: Uint8Array[] = [];
  for (const part of parts) chunks.push(part);
  sink.write(Buffer.concat(chunks));
}`),
    [],
  );
});

test('stays silent for registries filled at startup or by has-then-set without answering from the map', () => {
  assert.deepEqual(
    cacheFindings(`import { Injectable } from '@nestjs/common';
@Injectable()
export class Registry {
  private readonly handlerCache = new Map<string, () => void>();
  private readonly hooks = new Map<string, string[]>();
  onModuleInit(names: string[]) { for (const name of names) this.handlerCache.set(name, () => undefined); }
  find(name: string) { return this.handlerCache.get(name); }
  register(key: string, hook: string) {
    if (!this.hooks.has(key)) this.hooks.set(key, []);
    this.hooks.get(key)?.push(hook);
  }
}`),
    [],
  );
});

test('stays silent when the key type is a small literal union, enum or boolean', () => {
  assert.deepEqual(
    cacheFindings(`type Mode = 'fast' | 'slow';
enum Kind { A, B }
const modeCache = new Map<string, number>();
export function a(mode: Mode) { const hit = modeCache.get(mode); if (hit) return hit; modeCache.set(mode, 1); return 1; }
const kindCache = new Map<number, number>();
export function b(kind: Kind) { const hit = kindCache.get(kind); if (hit) return hit; kindCache.set(kind, 1); return 1; }
const flagCache = new Map<boolean, number>();
export function c(flag: boolean) { const hit = flagCache.get(flag); if (hit) return hit; flagCache.set(flag, 1); return 1; }`),
    [],
  );
});

test('a key that does not look request-derived is reported as contextual only', () => {
  const source = (parameter: string) => `const scriptCache = new Map<string, string>();
export function load(${parameter}: string) {
  const hit = scriptCache.get(${parameter});
  if (hit) return hit;
  scriptCache.set(${parameter}, ${parameter});
  return ${parameter};
}`;
  assert.match(reasonOf(cacheFindings(source('script'))[0]), /configuration or code/);
  assert.equal(cacheFindings(source('workspaceId'))[0].contextualReason, undefined);
});
