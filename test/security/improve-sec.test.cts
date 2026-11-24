import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findVulnerabilities } from '../../lib/security/deps/osv.cjs';
import { asResponse } from '../types/osv-fake.cjs';
import { withContext, sinkArgument, lintBothWays, stubs } from './helpers.cjs';
import type { SourceFile } from 'typescript';
import type { TestContext } from 'node:test';
import type { SecurityRuleContext } from '../../lib/shared/types.cjs';
import type { OsvBatchQuery } from '../types/osv-fake.cjs';

function cacheDirectory(context: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-improve-cache-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const record = (id: string) => ({ id, summary: id, affected: [] });
const answer = (body: unknown): Response => asResponse({ ok: true, status: 200, json: async () => body });

test('OSV querybatch pages are followed with page_token for the packages that have more', async (context) => {
  const batchBodies: OsvBatchQuery[][] = [];
  async function fetchImpl(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = String(input);
    if (!url.endsWith('/v1/querybatch')) return answer(record(decodeURIComponent(url.split('/v1/vulns/')[1])));
    const { queries }: { queries: OsvBatchQuery[] } = JSON.parse(String(init?.body));
    batchBodies.push(queries);
    const results = queries.map((query) => {
      if (query.package.name !== 'alpha') return {};
      return query.page_token === 'page-2'
        ? { vulns: [{ id: 'GHSA-late' }] }
        : { vulns: [{ id: 'GHSA-early' }], next_page_token: 'page-2' };
    });
    return answer({ results });
  }
  const packages = [
    { name: 'alpha', version: '1.0.0' },
    { name: 'beta', version: '2.0.0' },
  ];
  const found = await findVulnerabilities(packages, { fetchImpl, cacheDirectory: cacheDirectory(context) });
  assert.deepEqual(
    found.get('alpha@1.0.0')?.map(({ id }) => id),
    ['GHSA-early', 'GHSA-late'],
  );
  assert.equal(found.has('beta@2.0.0'), false);
  assert.deepEqual(batchBodies[1], [
    { package: { name: 'alpha', ecosystem: 'npm' }, version: '1.0.0', page_token: 'page-2' },
  ]);
});

test('an OSV answer that is not JSON or is null fails with the friendly database message', async (context) => {
  const packages = [{ name: 'alpha', version: '1.0.0' }];
  const notJson = async () =>
    asResponse({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });
  const nullBody = async () => answer(null);
  for (const fetchImpl of [notJson, nullBody]) {
    await assert.rejects(
      findVulnerabilities(packages, { fetchImpl, cacheDirectory: cacheDirectory(context) }),
      /^Error: The OSV vulnerability database returned an unexpected answer/,
    );
  }
});

test('an OSV batch that never stops paging fails instead of looping', async (context) => {
  let batches = 0;
  async function fetchImpl() {
    batches++;
    return answer({ results: [{ vulns: [], next_page_token: `page-${batches}` }] });
  }
  await assert.rejects(
    findVulnerabilities([{ name: 'alpha', version: '1.0.0' }], { fetchImpl, cacheDirectory: cacheDirectory(context) }),
    /kept paging/,
  );
  assert.equal(batches, 100);
});

function tracedInRoute(body: string, files: Record<string, string> = stubs.express) {
  const source = [
    "import express from 'express';",
    'declare function sink(value: unknown): void;',
    'const app = express();',
    `app.get('/items', async (req, res) => { ${body} });`,
  ].join('\n');
  return withContext(source, files, (context: SecurityRuleContext, sourceFile: SourceFile) =>
    context.taint.trace(sinkArgument(sourceFile), 'sql'),
  );
}

test('taint passes through Promise.resolve, await and a then callback, with and without types', () => {
  for (const files of [stubs.express, {}]) {
    assert.equal(
      tracedInRoute('const q = await Promise.resolve(req.query.q); sink("x" + q);', files)?.label,
      'req.query.q',
    );
    assert.equal(
      tracedInRoute('Promise.resolve(req.query.q).then((v) => sink("x" + v));', files)?.label,
      'req.query.q',
    );
    assert.equal(tracedInRoute('sink(`${String(req.query.q).trim().toLowerCase()}`);', files)?.label, 'req.query.q');
  }
});

test('a numeric conversion inside the promise or the callback still clears taint', () => {
  assert.equal(tracedInRoute('sink(await Promise.resolve(Number(req.query.q)));'), undefined);
  assert.equal(tracedInRoute('Promise.resolve(req.query.q).then((v) => sink(parseInt(v, 10)));'), undefined);
  assert.equal(tracedInRoute('fetch("https://example.com").then((v) => sink(v));'), undefined);
});

function pathTraversals(body: string) {
  const source = [
    "import express from 'express';",
    "import path from 'path';",
    "import { readFile } from 'fs/promises';",
    'const app = express();',
    `app.get('/files/:name', async (req, res) => { ${body} });`,
  ].join('\n');
  return lintBothWays(source, stubs.express).typed.filter(({ ruleId }) => ruleId === 'path-traversal');
}

test('a containment check against the literal root with a trailing separator quiets path-traversal', () => {
  const guarded = (root: string, prefix: string) =>
    `const full = path.resolve(${root}, req.params.name); if (!full.startsWith(${prefix})) throw new Error('outside'); await readFile(full);`;
  assert.equal(pathTraversals(guarded("'/srv'", "'/srv/'")).length, 0);
  assert.equal(pathTraversals(guarded("'/srv/'", "'/srv/'")).length, 0);
  assert.equal(pathTraversals(guarded("'C:\\srv'", "'C:\\srv\\'")).length, 0);
});

test('a literal prefix without a separator or for another root is still path-traversal', () => {
  const guarded = (root: string, prefix: string) =>
    `const full = path.resolve(${root}, req.params.name); if (!full.startsWith(${prefix})) throw new Error('outside'); await readFile(full);`;
  assert.equal(pathTraversals(guarded("'/srv'", "'/srv'")).length, 1);
  assert.equal(pathTraversals(guarded("'/srv'", "'/sr/'")).length, 1);
  assert.equal(pathTraversals(guarded("'/srv'", "'/'")).length, 1);
  assert.equal(pathTraversals(guarded("'/'", "'/'")).length, 1);
  assert.equal(pathTraversals(guarded("'/srv'", "'/srv/other/'")).length, 1);
});
