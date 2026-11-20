'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');
const { validateParallelReads } = require('../lib/parallel-reads.cjs');

const files = { 'node_modules/@app/reads/index.d.ts': `
export function fetchUser(id?: string): Promise<string>;
export function fetchPosts(id?: string): Promise<string>;
export function fetchVotes(id?: string): Promise<string>;
export function save(id?: string): Promise<string>;
export function cached(id?: string): string;
export { fetchUser as sameUser };
` };
const groups = [{ from: '@app/reads', exports: ['fetchUser', 'fetchPosts', 'cached', 'sameUser'] },
  { from: '@app/reads', exports: ['fetchVotes', 'fetchPosts'] }];

function findings(source, configured = true) {
  const policy = configured ? { parallelReads: validateParallelReads(groups) } : undefined;
  return lint(source, files, policy).map(({ ruleId, line }) => [ruleId, line]);
}

test('adjacent configured reads resolve aliases, namespace imports and default-library Promises', () => {
  const source = `import { fetchUser, fetchPosts as posts } from '@app/reads';
import * as reads from '@app/reads';
export async function dashboard(id: string) {
  const user = await fetchUser(id);
  const articles = await posts(id);
  return { user, articles };
}
export const overview = async () => {
  const votes = await reads.fetchVotes('theme');
  const articles = await reads.fetchPosts('news');
  return { votes, articles };
};`;
  assert.deepEqual(findings(source), [5, 10].map(line => ['known-reads-awaited-serially', line]));
  assert.deepEqual(findings(source, false), []);
});

test('dependent, unconfigured, synchronous, shadowed, identical or cross-group reads stay quiet', () => {
  const source = `import { fetchUser, fetchPosts, fetchVotes, save, cached, sameUser } from '@app/reads';
async function dependent() { const id = await fetchUser(); const posts = await fetchPosts(id); }
async function persist(id: string) { const saved = await save(id); const fresh = await fetchUser(id); }
async function synchronous() { const first = await cached(); const next = await fetchUser(); }
async function repeated() { const first = await fetchPosts(); const next = await fetchPosts(); }
async function sameExport() { const first = await fetchUser(); const next = await sameUser(); }
async function separate() { const first = await fetchUser(); const next = await fetchVotes(); }
async function shadow(fetchPosts: () => Promise<string>) { const first = await fetchUser(); const next = await fetchPosts(); }
async function unknownArgument(getId: () => string) { const first = await fetchUser(); const next = await fetchPosts(getId()); }
async function mutable() { let id = 'stale'; const first = await fetchUser(); const next = await fetchPosts(id); }`;
  assert.deepEqual(findings(source), []);
});

test('only uninterrupted adjacent declarations in a straight-line read context produce advice', () => {
  const source = `import { fetchUser, fetchPosts } from '@app/reads';
declare function transaction(fn: () => Promise<void>): void;
declare const client: { query(text: string): Promise<unknown> };
async function guarded() {
  try { const first = await fetchUser(); const next = await fetchPosts(); } finally {}
}
transaction(async () => { const first = await fetchUser(); const next = await fetchPosts(); });
async function manual() {
  await client.query('BEGIN');
  const first = await fetchUser(); const next = await fetchPosts();
  await client.query('COMMIT');
}
async function interrupted() { const first = await fetchUser(); await client.query('SELECT 1'); const next = await fetchPosts(); }
async function singleDeclaration() { const first = await fetchUser(), next = await fetchPosts(); }
async function nested(id: string) { if (id) { const first = await fetchUser(id); const next = await fetchPosts(id); } }
async function safe() { const id = 'stable'; const first = await fetchUser(id); const next = await fetchPosts(id); }
async function opaqueSetup(id: string, setup = client.query('BEGIN')) { const first = await fetchUser(id); const next = await fetchPosts(id); }`;
  assert.deepEqual(findings(source), [['known-reads-awaited-serially', 16]]);
});

test('parallelReads rejects ambiguous groups and validates without selecting a compiler', () => {
  for (const invalid of [null, {}, [], [{}], [{ from: '../reads', exports: ['a', 'b'] }],
    [{ from: '@app/reads', exports: ['a'] }], [{ from: '@app/reads', exports: ['a', 'a'] }],
    [{ from: '@app/reads', exports: ['a', 'bad*'] }], [{ ...groups[0], unexpected: true }]]) {
    assert.throws(() => validateParallelReads(invalid), /parallelReads/);
  }
});

test('overlapping groups do not suggest overlapping rewrites for three consecutive reads', () => {
  const source = `import { fetchUser, fetchPosts, fetchVotes } from '@app/reads';
async function dashboard() {
  const first = await fetchUser();
  const second = await fetchPosts();
  const third = await fetchVotes();
}`;
  assert.deepEqual(findings(source), [['known-reads-awaited-serially', 4]]);
});

test('branded arguments and satisfies annotations preserve read dependencies', () => {
  const source = `import { fetchUser, fetchPosts } from '@app/reads';
type UserId = string & { readonly brand: unique symbol };
async function independent(id: UserId) {
  const user = await fetchUser(id satisfies string);
  const posts = await fetchPosts(id);
}
async function dependent(id: UserId) {
  const user = await fetchUser(id);
  const posts = await fetchPosts(user satisfies string);
}`;
  assert.deepEqual(findings(source), [['known-reads-awaited-serially', 5]]);
  for (const from of ['#reads', '@/queries']) {
    assert.ok(validateParallelReads([{ from, exports: ['first', 'second'] }]).has(from));
  }
  assert.throws(() => validateParallelReads([{ from: 'reads', exports: ['one', ,] }]), /parallelReads/);
});
