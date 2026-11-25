import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf, defaultFindingsOf } from './exposure-helpers.js';

const ruleId = 'database-error-in-response';
const declarations = [
  'declare const prisma: any; declare const res: any; declare const app: any; declare const ping: () => Promise<void>;',
  'declare class ValidationError extends Error {} declare class PrismaClientKnownRequestError extends Error { code: string; }',
  'declare const logger: any;',
  '',
].join('\n');

function inCatch(tryBody: string, catchBody: string) {
  return `${declarations}async function handler() { try { ${tryBody} } catch (err) { ${catchBody} } }`;
}

test('err.message or the whole err from a database try is reported', () => {
  const catches = [
    'res.status(500).json({ error: err.message });',
    'res.json({ error: err.message });',
    'res.status(500).send(err.message);',
    'res.status(500).json(err);',
    'res.status(500).json({ err });',
    'res.status(500).json({ error: `Failed: ${err.message}` });',
    'res.status(500).json({ error: err.message.slice(0, 100) });',
  ];
  for (const body of catches)
    assert.equal(defaultFindingsOf(ruleId, inCatch('await prisma.user.create({});', body)).length, 1, body);
});

test('other database call shapes in the try block are recognised', () => {
  const calls = [
    'await this.prisma.user.findMany();',
    'await userRepository.save({});',
    'await Promise.all([db.query("select 1")]);',
    'await User.findOne({});',
  ];
  for (const call of calls) {
    const source = `${declarations}declare const db: any; declare const userRepository: any; declare const User: any;
      class Service { prisma: any; async run() { try { ${call} } catch (err) { res.status(500).json({ message: err.message }); } } }`;
    assert.equal(defaultFindingsOf(ruleId, source).length, 1, call);
  }
});

test('a driver error type or instanceof test is enough without a database call in the try', () => {
  const typed = `${declarations}function fail(err: PrismaClientKnownRequestError) { res.status(500).json({ error: err.message }); }`;
  assert.equal(defaultFindingsOf(ruleId, typed).length, 1);
  const narrowed = inCatch(
    'await ping();',
    'if (err instanceof PrismaClientKnownRequestError) res.status(500).json({ error: err.message });',
  );
  assert.equal(defaultFindingsOf(ruleId, narrowed).length, 1);
});

test('an Express error middleware sending err.message is contextual only', () => {
  const source = `${declarations}app.use((err: Error, req: any, res: any, next: any) => { res.status(500).json({ error: err.message }); });`;
  assert.equal(findingsOf(ruleId, source).length, 1);
  assert.equal(defaultFindingsOf(ruleId, source).length, 0);
});

test('generic messages, mapped errors, 4xx and non-database tries are clean', () => {
  const database = 'await prisma.user.create({});';
  const clean = [
    inCatch(database, 'logger.error(err); res.status(500).json({ error: "Internal error" });'),
    inCatch(
      database,
      'res.status(500).json({ error: err instanceof ValidationError ? err.message : "Internal error" });',
    ),
    inCatch(database, 'if (err instanceof ValidationError) { res.status(500).json({ error: err.message }); }'),
    inCatch(database, 'res.status(400).json({ error: err.message });'),
    inCatch(database, 'res.status(409).json({ error: err.message });'),
    inCatch(database, 'if (err.code === "P2002") { res.json({ error: err.message }); }'),
    inCatch(database, 'res.status(500).json({ code: err.code });'),
    inCatch(database, 'res.status(500).json({ error: sanitize(err.message) });'),
    inCatch('await ping();', 'res.status(500).json({ error: err.message });'),
    inCatch(database, 'logger.error(err.message);'),
    inCatch(database, 'if (process.env.NODE_ENV !== "production") res.status(500).json({ error: err.message });'),
  ];
  for (const source of clean) assert.equal(findingsOf(ruleId, source).length, 0, source);
});
