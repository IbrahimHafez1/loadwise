import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { withProgram } from './helpers.cjs';
import { check } from '../../lib/performance/backend-mastery.cjs';
import { typeFromPackage } from '../../lib/performance/package-types.cjs';
import fixes from '../../lib/performance/site-fixes/backend-mastery-fixes.cjs';
import type { Node, SourceFile } from 'typescript';
import type { Finding, PerformanceRuleContext, ProgramAdapter, SiteFixInput } from '../../lib/shared/types.cjs';
import { reasonOf } from '../types/finding-reason.cjs';
import type { FileMap } from '../types/project-files.cjs';
import { typeScriptProgramOf } from '../types/program-files.cjs';

interface NodeFinding extends Finding {
  node: Node;
}

// The rules are not registered in analyze.cjs yet, so the check is driven directly with the context
// analyze builds.
function scan(sourceFile: SourceFile, program: ProgramAdapter) {
  const checker = program.getTypeChecker();
  const found: NodeFinding[] = [];
  const context: PerformanceRuleContext = {
    checker,
    program,
    strictNullChecks: true,
    verbatimModuleSyntax: false,
    fireAndForgetNames: new Set(),
    isRepeated: () => false,
    isPackageType: (node: Node, packages: readonly string[], typeNames?: readonly string[]) =>
      typeFromPackage(checker.getTypeAtLocation(node), packages, typeNames),
    report(node: Node, ruleId: string, message: string, contextualReason?: string) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      found.push({ ruleId, line: line + 1, message, contextualReason, node });
    },
  };
  (function visit(node: Node): void {
    if (ts.isCallExpression(node)) check(node, context);
    ts.forEachChild(node, visit);
  })(sourceFile);
  return found;
}

function findings(source: string, files: FileMap, ruleId: string) {
  return withProgram(source, files, (program: ProgramAdapter, sourceFile: SourceFile) =>
    scan(sourceFile, program).filter((finding) => finding.ruleId === ruleId),
  );
}

const pgFiles = {
  'node_modules/pg/index.d.ts': `
    export interface QueryResult { rows: unknown[] }
    export class Pool { query(text: string, values?: unknown[]): Promise<QueryResult> }
  `,
};
const selectStarRule = 'sql-select-star-in-query';

test('SELECT * through a typed pg pool is reported', () => {
  const source = `import { Pool } from 'pg';
const pool = new Pool();
export async function list() { return pool.query('SELECT * FROM orders WHERE status = $1', ['open']); }`;
  const found = findings(source, pgFiles, selectStarRule);
  assert.equal(found.length, 1);
  assert.equal(found[0].contextualReason, undefined);
});

test('SELECT * of one row by id is contextual', () => {
  const source = `import { Pool } from 'pg';
const pool = new Pool();
export async function one(id: string) { return pool.query('SELECT * FROM orders WHERE id = $1', [id]); }`;
  const found = findings(source, pgFiles, selectStarRule);
  assert.equal(found.length, 1);
  assert.match(reasonOf(found[0]), /single-row/);
});

test('SELECT * stays quiet for a column list, an EXISTS subquery, COUNT(*) and a catalog read', () => {
  const source = `import { Pool } from 'pg';
const pool = new Pool();
export async function run() {
  await pool.query('SELECT id, total FROM orders');
  await pool.query('SELECT EXISTS (SELECT * FROM orders)');
  await pool.query('SELECT COUNT(*) FROM orders');
  await pool.query('SELECT * FROM information_schema.tables');
}`;
  assert.deepEqual(findings(source, pgFiles, selectStarRule), []);
});

test('SELECT * on a project-defined query method is quiet', () => {
  const source = `const db = { query(text: string) { return text; } };
db.query('SELECT * FROM orders');`;
  assert.deepEqual(findings(source, {}, selectStarRule), []);
});

const axiosFiles = {
  'node_modules/axios/index.d.ts': `
    export interface AxiosInstance { get(url: string): Promise<{ data: unknown }>; post(url: string, body?: unknown): Promise<unknown> }
    export interface AxiosStatic extends AxiosInstance { create(): AxiosInstance }
    declare const axios: AxiosStatic;
    export default axios;`,
};
const httpRule = 'sequential-http-in-loop';

test('awaited fetch and axios calls in a loop are reported', () => {
  const source = `import axios from 'axios';
export async function run(urls: string[]) {
  for (const url of urls) { await fetch(url); }
  for (const url of urls) { await axios.get(url); }
  const client = axios.create();
  for (const url of urls) { const res = await client.get(url); console.log(res.data); }
  let index = 0;
  while (index < urls.length) { await axios.post(urls[index]); index++; }
}`;
  const found = findings(source, axiosFiles, httpRule);
  assert.deepEqual(
    found.map((finding: Finding) => finding.line),
    [3, 4, 6, 8],
  );
});

test('a request in a loop stays quiet when iterations depend on each other', () => {
  const source = `export async function run(urls: string[], first: string) {
  for (const url of urls) { const res = await fetch(url); if (res.ok) return res; }
  let next: string | undefined = first;
  for (const url of urls) { const res = await fetch(next ?? url); next = res.headers.get('x') ?? undefined; }
  let page = 0;
  while (page < 5) { const res = await fetch('/p?n=' + page); if (!res.ok) break; page++; }
  for await (const url of urls) { await fetch(url); }
}`;
  assert.deepEqual(findings(source, {}, httpRule), []);
});

test('requests already started together, outside a loop, or by a project function are quiet', () => {
  const source = `function get(url: string) { return url; }
export async function run(urls: string[]) {
  await Promise.all(urls.map(async (url) => { await fetch(url); }));
  await fetch('/one');
  for (const url of urls) { await get(url); }
  for (const url of ['a', 'b']) { await fetch(url); }
}`;
  assert.deepEqual(findings(source, {}, httpRule), []);
});

test('a shadowed fetch is quiet', () => {
  const source = `export async function run(urls: string[], fetch: (url: string) => Promise<void>) {
  for (const url of urls) { await fetch(url); }
}`;
  assert.deepEqual(findings(source, {}, httpRule), []);
});

test('a per-item try/catch makes the report contextual', () => {
  const source = `export async function run(urls: string[]) {
  for (const url of urls) { try { await fetch(url); } catch (error) { console.log(error); } }
}`;
  const found = findings(source, {}, httpRule);
  assert.equal(found.length, 1);
  assert.match(reasonOf(found[0]), /try\/catch/);
});

function applyHttpFix(source: string) {
  return withProgram(source, {}, (program: ProgramAdapter, sourceFile: SourceFile) => {
    const [finding] = scan(sourceFile, program).filter((candidate) => candidate.ruleId === httpRule);
    const input: SiteFixInput = { node: finding.node, sourceFile, text: sourceFile.text, finding, load: () => null };
    const fix = fixes[httpRule](input);
    if (!fix) return undefined;
    assert.ok(fix.edits);
    const [edit] = fix.edits;
    return { fix, output: sourceFile.text.slice(0, edit.start) + edit.text + sourceFile.text.slice(edit.end) };
  });
}

test('the fix wraps a plain loop in Promise.all, asks for review and compiles', () => {
  const result = applyHttpFix(
    'export async function run(urls: string[]) {\n  for (const url of urls) {\n    await fetch(url);\n  }\n}\n',
  );
  assert.ok(result);
  assert.equal(result.fix.requiresReview, true);
  assert.match(
    result.output,
    /await Promise\.all\(Array\.from\(urls\)\.map\(async \(url\) => \{\n {4}await fetch\(url\);\n {2}\}\)\);/,
  );
  const errors = withProgram(
    `declare function fetch(url: string): Promise<unknown>;
${result.output}`,
    {},
    (program: ProgramAdapter, sourceFile: SourceFile) =>
      ts
        .getPreEmitDiagnostics(typeScriptProgramOf(program), sourceFile)
        .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')),
  );
  assert.deepEqual(errors, []);
});

test('the fix declines a loop with a comment inside', () => {
  const commented = applyHttpFix(
    'export async function run(urls: string[]) {\n  for (const url of urls) {\n    // keep order\n    await fetch(url);\n  }\n}\n',
  );
  assert.equal(commented, undefined);
});

const mongooseFiles = {
  'node_modules/mongoose/index.d.ts': `
    export interface Query<T> extends PromiseLike<T> { session(value: unknown): Query<T>; lean(): Query<T> }
    export class Model<T> {
      static findById(id: string): Query<{ balance: number; name: string; save(options?: object): Promise<unknown> }>;
      static updateOne(filter: object, update: object, options?: object): Promise<unknown>;
      save(options?: object): Promise<this>;
    }`,
  'models.ts': `
    import { Model } from 'mongoose';
    export class Account extends Model<unknown> { balance!: number; name!: string; }`,
};
const raceRule = 'check-then-update-race';

test('a numeric field changed on a read document and saved is reported', () => {
  const source = `import { Account } from './models';
export async function withdraw(id: string, amount: number) {
  const account = await Account.findById(id);
  account.balance -= amount;
  await account.save();
}
export async function deposit(id: string, amount: number) {
  const account = await Account.findById(id);
  account.balance = account.balance + amount;
  await account.save();
}`;
  const found = findings(source, mongooseFiles, raceRule);
  assert.deepEqual(
    found.map((finding: Finding) => finding.line),
    [5, 10],
  );
  assert.match(reasonOf(found[0]), /request handler/);
});

test('an update computed from the read value is reported', () => {
  const source = `import { Account } from './models';
export async function withdraw(id: string, amount: number) {
  const account = await Account.findById(id);
  await Account.updateOne({ _id: id }, { balance: account.balance - amount });
}`;
  assert.equal(findings(source, mongooseFiles, raceRule).length, 1);
});

test('a session, a transaction callback or a non-numeric edit is quiet', () => {
  const source = `import { Account } from './models';
declare const session: object;
declare const connection: { transaction(run: () => Promise<void>): Promise<void> };
export async function a(id: string, amount: number) {
  const account = await Account.findById(id).session(session);
  account.balance -= amount;
  await account.save({ session });
}
export async function b(id: string, amount: number) {
  await connection.transaction(async () => {
    const account = await Account.findById(id);
    account.balance -= amount;
    await account.save();
  });
}
export async function c(id: string) {
  const account = await Account.findById(id);
  account.name = 'x';
  await account.save();
}
export async function d(id: string, amount: number) {
  const account = await Account.findById(id);
  await Account.updateOne({ _id: id }, { balance: amount });
}`;
  assert.deepEqual(findings(source, mongooseFiles, raceRule), []);
});

const stripeFiles = {
  'node_modules/stripe/index.d.ts': `
    declare class Stripe {
      paymentIntents: { create(params: object, options?: { idempotencyKey?: string }): Promise<unknown> };
      customers: { create(params: object, options?: { idempotencyKey?: string }): Promise<unknown> };
    }
    export default Stripe;`,
};
const paymentRule = 'payment-missing-idempotency-key';

test('a Stripe money call without an idempotency key is reported', () => {
  const source = `import Stripe from 'stripe';
const stripe = new Stripe();
export async function charge(amount: number) { return stripe.paymentIntents.create({ amount }); }`;
  assert.equal(findings(source, stripeFiles, paymentRule).length, 1);
});

test('a Stripe call with a key, a non-money resource, or a non-Stripe client is quiet', () => {
  const source = `import Stripe from 'stripe';
const stripe = new Stripe();
const other = { paymentIntents: { create(params: object) { return params; } } };
export async function run(amount: number, options: { idempotencyKey: string }, key: string) {
  await stripe.paymentIntents.create({ amount }, { idempotencyKey: key });
  await stripe.paymentIntents.create({ amount }, options);
  await stripe.customers.create({ name: 'x' });
  other.paymentIntents.create({ amount });
}`;
  assert.deepEqual(findings(source, stripeFiles, paymentRule), []);
});

const expressFiles = {
  'node_modules/express/index.d.ts': `
    export interface Request { body: { id: string } }
    export interface Response { sendStatus(code: number): void }
    export interface Application {
      post(path: string, handler: (req: Request, res: Response) => unknown): void;
      get(path: string, handler: (req: Request, res: Response) => unknown): void;
    }
    declare function express(): Application;
    export default express;`,
  'node_modules/mongoose/index.d.ts': `
    export class Model<T> {
      static create(doc: object): Promise<unknown>;
      static findOne(filter: object): Promise<unknown>;
      static updateOne(filter: object, update: object): Promise<unknown>;
    }`,
  'models.ts': "import { Model } from 'mongoose';\nexport class Payment extends Model<unknown> {}",
};
const webhookRule = 'webhook-missing-idempotency-check';

test('a webhook route that inserts without a prior lookup is reported as contextual', () => {
  const source = `import express from 'express';
import { Payment } from './models';
const app = express();
app.post('/webhooks/stripe', async (req, res) => {
  await Payment.create({ eventId: req.body.id });
  res.sendStatus(200);
});`;
  const found = findings(source, expressFiles, webhookRule);
  assert.equal(found.length, 1);
  assert.ok(found[0].contextualReason);
});

test('a webhook that looks the event up first, only updates, or is not a webhook is quiet', () => {
  const source = `import express from 'express';
import { Payment } from './models';
const app = express();
app.post('/webhooks/stripe', async (req, res) => {
  const seen = await Payment.findOne({ eventId: req.body.id });
  if (!seen) await Payment.create({ eventId: req.body.id });
  res.sendStatus(200);
});
app.post('/webhooks/paddle', async (req, res) => {
  await Payment.updateOne({ eventId: req.body.id }, { status: 'paid' });
  res.sendStatus(200);
});
app.post('/orders', async (req, res) => {
  await Payment.create({ eventId: req.body.id });
  res.sendStatus(200);
});
app.get('/webhooks/ping', async (req, res) => {
  await Payment.create({ eventId: req.body.id });
  res.sendStatus(200);
});`;
  assert.deepEqual(findings(source, expressFiles, webhookRule), []);
});

test('a post() on an untyped object is quiet for webhook paths', () => {
  const source = `const app = { post(path: string, handler: () => void) { handler(); } };
const db = { create(doc: object) { return doc; } };
app.post('/webhooks/stripe', () => { db.create({}); });`;
  assert.deepEqual(findings(source, {}, webhookRule), []);
});
