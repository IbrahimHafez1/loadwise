'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { assertReportedWithoutFix, scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const typeormStub = {
  'node_modules/typeorm/index.d.ts': `export declare class Repository<Entity> { save(entity: Entity): Promise<Entity>; }
export declare class EntityManager {
  save<Entity>(entity: Entity): Promise<Entity>;
  withRepository<Entity>(repository: Repository<Entity>): Repository<Entity>;
  transaction<Result>(run: (manager: EntityManager) => Promise<Result>): Promise<Result>;
}
export declare class DataSource extends EntityManager { manager: EntityManager; }`,
};

function findingsFor(context, ruleId, source, extraFiles = {}) {
  const { findings } = scanWithFixes(context, { 'src.ts': source, ...extraFiles });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function escapeSource(callbackBody, declarations = '') {
  return `import { DataSource, Repository } from 'typeorm';
declare const dataSource: DataSource;
declare const users: Repository<{ id: number }>;
${declarations}
export async function run() {
  await dataSource.transaction(async (manager) => {
${callbackBody}
  });
}
`;
}

const escapeRule = 'typeorm-transaction-client-escape';

test('a repository write inside a transaction is bound to the transaction manager, for review', (context) => {
  const [finding] = findingsFor(context, escapeRule, escapeSource('    await users.save({ id: 1 });'), typeormStub);
  assert.equal(finding.fix.requiresReview, true);
  assert.deepEqual(onlyChange(finding), {
    before: 'await users.save({ id: 1 });',
    after: 'await manager.withRepository(users).save({ id: 1 });',
  });
});

test('a manager write inside a transaction swaps in the transaction manager', (context) => {
  const [finding] = findingsFor(
    context,
    escapeRule,
    escapeSource('    await dataSource.manager.save({ id: 1 });'),
    typeormStub,
  );
  assert.equal(onlyChange(finding).after, 'await manager.save({ id: 1 });');
});

test('no escape fix when the write goes through a helper or the callback redeclares the manager name', (context) => {
  const helper = findingsFor(
    context,
    escapeRule,
    escapeSource(
      '    await persist({ id: 1 });',
      'async function persist(user: { id: number }) { await users.save(user); }',
    ),
    typeormStub,
  );
  const redeclared = findingsFor(
    context,
    escapeRule,
    escapeSource(
      ['    await users.save({ id: 1 });', '    const unrelated = (manager: number) => manager;'].join('\n'),
    ),
    typeormStub,
  );
  assertReportedWithoutFix(helper);
  assertReportedWithoutFix(redeclared);
});

const jsonRule = 'json-parse-unguarded';

function handlerSource(handlerText) {
  return `declare const app: { post(path: string, handler: unknown): void };
declare function readInput(): string;
${handlerText}
`;
}

test('a plain request parse in a handler answers 400, for review', (context) => {
  const [finding] = findingsFor(
    context,
    jsonRule,
    handlerSource(`app.post('/items', async (req: { body: string }, res: { status(code: number): { json(body: object): void } }) => {
  const filter = JSON.parse(req.body);
  res.status(200).json({ filter });
});`),
  );
  assert.equal(finding.fix.requiresReview, true);
  assert.equal(
    onlyChange(finding).after,
    [
      'let filter;',
      'try {',
      '  filter = JSON.parse(req.body);',
      '} catch {',
      "  res.status(400).json({ error: 'Invalid JSON' });",
      '  return;',
      '}',
    ].join('\n'),
  );
});

test('a handler that returns values answers with a returned response', (context) => {
  const [finding] = findingsFor(
    context,
    jsonRule,
    handlerSource(`app.post('/items', (req: { body: string }, res: { status(code: number): { json(body: object): string } }) => {
  const filter = JSON.parse(req.body);
  return res.status(200).json({ filter });
});`),
  );
  assert.match(onlyChange(finding).after, /return res\.status\(400\)\.json\(\{ error: 'Invalid JSON' \}\);/);
});

test('no json parse fix when the failure response is not clear', (context) => {
  const cases = {
    'argument can throw by itself': `app.post('/a', (req: { body: string }, res: { status(code: number): { json(body: object): void } }) => {
  const filter = JSON.parse(String(req.body));
  res.status(200).json({ filter });
});`,
    'not a request handler': `export async function load(req: { body: string }) {
  const filter = JSON.parse(req.body);
  return filter;
}`,
    'destructured result': `app.post('/b', (req: { body: string }, res: { status(code: number): { json(body: object): void } }) => {
  const { filter } = JSON.parse(req.body);
  res.status(200).json({ filter });
});`,
    'response parameter is shadowed': `app.post('/c', (req: { body: string }, res: { status(code: number): { json(body: object): void } }) => {
  const filter = JSON.parse(req.body);
  const run = (res: number) => res;
  res.status(200).json({ filter, run });
});`,
    'declared return type': `app.post('/d', (req: { body: string }, res: { status(code: number): { json(body: object): void } }): void => {
  const filter = JSON.parse(req.body);
  res.status(200).json({ filter });
});`,
  };
  for (const [name, source] of Object.entries(cases)) {
    const findings = findingsFor(context, jsonRule, handlerSource(source));
    assert.ok(
      findings.every((finding) => finding.fix === undefined),
      name,
    );
  }
});
