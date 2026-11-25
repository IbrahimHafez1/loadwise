import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { checkSwallowedErrors } from '../../lib/maintainability/swallowed-errors.js';

function check(source: string, file = 'src/example.ts') {
  return checkSwallowedErrors(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), file);
}

test('a loop that tries each server and throws once all fail is not reported', () => {
  const source = `async function predict(urls) {
    for (const url of urls) {
      try {
        const response = await fetch(url);
        if (response.ok) return response.json();
      } catch (error) {
        this.logger.warn('request failed', error);
      }
      this.setHealthy(url, false);
    }
    throw new Error('failed for all URLs');
  }`;
  assert.deepEqual(check(source), []);
});

test('a probe followed directly by a throw is not reported', () => {
  assert.deepEqual(
    check('function parse(value) { try { new URL(value); return; } catch {} throw new Error("bad"); }'),
    [],
  );
});

test('a loop whose failures are not followed by a throw, or that never returns on success, is still reported', () => {
  const sources = [
    'function run(items) { for (const item of items) { try { return work(item); } catch {} next(); } done(); }',
    'function run(items) { for (const item of items) { try { work(item); } catch {} } throw new Error("x"); }',
  ];
  for (const source of sources) assert.equal(check(source).length, 1, source);
});

test('a cache read or write that is allowed to fail is not reported', () => {
  const sources = [
    'async function wrap(key, loader) { try { const hit = await this.cache.get(key); if (hit) return hit; } catch (error) { this.logger.warn(String(error)); } return loader(); }',
    'async function respond(key, payload) { try { await setCacheValue(cache, key, payload); } catch (error) { logger.warn(error); } send(); }',
  ];
  for (const source of sources) assert.deepEqual(check(source), [], source);
});

test('a try that awaits anything besides the cache is still reported', () => {
  const source =
    'async function save(key, row) { try { await this.cache.set(key, row); await db.insert(row); } catch (error) { logger.warn(error); } send(); }';
  assert.equal(check(source).length, 1);
});

test('a catch whose log message explains the fallback is not reported', () => {
  const sources = [
    'async function run() { try { await refresh(); } catch (error) { this.logger.warn(`refresh failed: ${error}. Existing token will continue to work.`); } next(); }',
    'async function run() { try { await enrich(); } catch (error) { this.logger.warn("enrich failed, broadcasting without them"); } publish(); }',
  ];
  for (const source of sources) assert.deepEqual(check(source), [], source);
});

test('a catch whose log message only says what failed is still reported', () => {
  const source =
    'async function run() { try { await refresh(); } catch (error) { this.logger.warn(`refresh failed: ${error}`); } next(); }';
  assert.equal(check(source).length, 1);
});

test('the try/catch fallback idioms are not reported', () => {
  const sources = [
    'function load(path) { let files = []; try { files = readdirSync(path); } catch (error) {} return files; }',
    'function build(text) { try { return new RegExp(text); } catch (error) {} return; }',
    'async function health() { try { return await store.get("health"); } catch (error) { logger.warn(error); } return; }',
  ];
  for (const source of sources) assert.deepEqual(check(source), [], source);
});

test('an empty catch followed by ordinary work is still reported', () => {
  assert.equal(check('function save() { try { write(); } catch (error) {} return 1; }').length, 1);
});
