// Batched fixes for per-item Drizzle, Mongoose and Sequelize reads and per-item push or mail sends:
// the expected rewrite, that the rewritten file type-checks against the package stubs, and the
// shapes left without a fix.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import ts from 'typescript';
import { scanWithFixes } from './site-fix-helpers.cjs';
import { fixNoteOf } from '../types/fix-note.cjs';
import type { FileMap } from '../types/project-files.cjs';

const compilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
};

const drizzleRow = '{ id: number; teamId: number; name: string }';
const drizzleFiles = {
  'node_modules/drizzle-orm/index.d.ts': `export declare function eq(column: unknown, value: unknown): unknown;
export declare function inArray(column: unknown, values: unknown[]): unknown;
export declare function sql(strings: TemplateStringsArray, ...values: unknown[]): unknown;`,
  'node_modules/drizzle-orm/pg-core/db.d.ts': `import { Query } from './query-builders/select';
import { Relations } from './query-builders/query';
export class Database {
  readonly query: { users: Relations };
  select(fields?: object): { from(table: unknown): Query };
  update(table: unknown): { set(fields: object): Query };
}`,
  'node_modules/drizzle-orm/pg-core/query-builders/select.d.ts': `export class Query extends Promise<${drizzleRow}[]> {
  where(predicate: unknown): Query;
}`,
  'node_modules/drizzle-orm/pg-core/query-builders/query.d.ts': `import { Query } from './select';
export class Relations {
  findFirst(options: object): Promise<${drizzleRow} | undefined>;
  findMany(options: object): Query;
}`,
  'src/schema.ts': 'export declare const users: { id: unknown; teamId: unknown; name: unknown };',
};
const mongooseFiles = {
  'node_modules/mongoose/index.d.ts': `export class Query<T> implements PromiseLike<T> {
  exec(): Promise<T>;
  then: Promise<T>['then'];
  lean(): Query<T>;
}
export interface Model<T> {
  find(filter?: object): Query<T[]>;
  findOne(filter?: object): Query<T | null>;
  findById(id: unknown): Query<T | null>;
}`,
};
const sequelizeFiles = {
  'node_modules/sequelize/index.d.ts': `export declare const Op: { readonly in: symbol };
export class Model {
  static findOne<M extends Model>(this: new () => M, options?: object): Promise<M | null>;
  static findAll<M extends Model>(this: new () => M, options?: object): Promise<M[]>;
}`,
};
const notificationFiles = {
  'node_modules/firebase-admin/index.d.ts': `export interface Message { token: string; android?: { priority?: 'high' | 'normal' } }
export class Messaging { send(message: Message): Promise<string>; sendEach(messages: Message[]): Promise<unknown> }
export function messaging(): Messaging;`,
  'node_modules/@sendgrid/mail/index.d.ts': `declare const mail: { send(data: object | object[]): Promise<unknown> }; export default mail;`,
  'node_modules/expo-server-sdk/index.d.ts': `export interface ExpoPushMessage { to: string; sound?: 'default' | null; body?: string }
export class Expo {
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<unknown[]>;
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
}`,
};

function scan(context: TestContext, files: FileMap, source: string, ruleId: string) {
  const { root, findings } = scanWithFixes(context, { ...files, 'src/service.ts': source });
  return { root, findings: findings.filter((finding) => finding.ruleId === ruleId) };
}

// Applies the one fix the rule produced and returns the rewritten file with its type errors.
function fixedSource(context: TestContext, files: FileMap, source: string, ruleId: string) {
  const { root, findings } = scan(context, files, source, ruleId);
  assert.equal(findings.length, 1, 'expected one finding');
  const { fix } = findings[0];
  assert.ok(fix, 'expected a fix');
  let rewritten = source;
  for (const change of fix.changes) {
    assert.ok(rewritten.includes(change.before), 'each change applies to the source');
    rewritten = rewritten.replace(change.before, () => change.after);
  }
  const target = path.join(root, 'src', 'fixed.ts');
  fs.writeFileSync(target, rewritten);
  const errors = ts
    .getPreEmitDiagnostics(ts.createProgram([target], compilerOptions))
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  return { text: rewritten, errors, fix };
}

function assertNoFix(context: TestContext, files: FileMap, source: string, ruleId: string) {
  const { findings } = scan(context, files, source, ruleId);
  assert.ok(findings.length > 0, 'rule should report');
  assert.deepEqual(
    findings.map((finding) => finding.fix),
    findings.map(() => undefined),
  );
}

const drizzleHeader = `import { eq } from 'drizzle-orm';
import type { Database } from 'drizzle-orm/pg-core/db';
import { users } from './schema';
declare const db: Database;
`;

test('a Drizzle select by key per item becomes one inArray query grouped by key', (context) => {
  const { text, errors, fix } = fixedSource(
    context,
    drizzleFiles,
    `${drizzleHeader}export async function load(orders: { userId: number }[]) {
  for (const order of orders) {
    const [user] = await db.select().from(users).where(eq(users.id, order.userId));
    console.log(user?.name);
  }
}`,
    'drizzle-query-in-loop',
  );
  assert.deepEqual(errors, []);
  assert.match(text, /^import \{ eq, inArray \} from 'drizzle-orm';/);
  assert.ok(text.includes('const userIds = orders.map((order) => order.userId);'));
  assert.ok(
    text.includes(
      'const userRows = userIds.length ? await db.select().from(users).where(inArray(users.id, userIds)) : [];',
    ),
  );
  assert.ok(text.includes('const [user] = [...(userRowsById.get(order.userId) ?? [])];'));
  assert.match(fixNoteOf(fix), /no keys/);
});

test('a Drizzle relational findFirst per item becomes findMany with inArray and a Map', (context) => {
  const { text, errors } = fixedSource(
    context,
    drizzleFiles,
    `${drizzleHeader}export async function load(orders: { userId: number }[]) {
  for (const order of orders) {
    const user = await db.query.users.findFirst({ where: eq(users.id, order.userId) });
    console.log(user?.name);
  }
}`,
    'drizzle-query-in-loop',
  );
  assert.deepEqual(errors, []);
  assert.ok(
    text.includes(
      'const userRows = userIds.length ? await db.query.users.findMany({ where: inArray(users.id, userIds) }) : [];',
    ),
  );
  assert.ok(text.includes('const user = userRowsById.get(order.userId) ?? null;'));
});

test('Drizzle reads with selected fields, a raw condition or other work on the client are left alone', (context) => {
  for (const body of [
    'const rows = await db.select({ name: users.name }).from(users).where(eq(users.id, order.userId));',
    'const rows = await db.select().from(users).where(sql`id = ${order.userId}`);',
    `const rows = await db.select().from(users).where(eq(users.id, order.userId));
    await db.update(users).set({ seen: true }).where(eq(users.id, order.userId));`,
  ]) {
    assertNoFix(
      context,
      drizzleFiles,
      `${drizzleHeader.replace('{ eq }', '{ eq, sql }')}export async function load(orders: { userId: number }[]) {
  for (const order of orders) {
    ${body}
    console.log(rows);
  }
}`,
      'drizzle-query-in-loop',
    );
  }
});

const mongooseHeader = `import type { Model } from 'mongoose';
declare const User: Model<{ _id: string; email: string; teamId: string }>;
`;

test('a Mongoose findOne per item becomes one $in find matched by String(key), marked for review', (context) => {
  const { text, errors, fix } = fixedSource(
    context,
    mongooseFiles,
    `${mongooseHeader}export async function load(orders: { email: string }[]) {
  for (const order of orders) {
    const user = await User.findOne({ email: order.email }).lean();
    console.log(user);
  }
}`,
    'orm-query-in-loop',
  );
  assert.deepEqual(errors, []);
  assert.ok(
    text.includes('const users = await User.find({ email: { $in: orders.map((order) => order.email) } }).lean();'),
  );
  assert.ok(text.includes('new Map(users.map((user) => [String(user.email), user] as const));'));
  assert.ok(text.includes('const user = usersByEmail.get(String(order.email)) ?? null;'));
  assert.equal(fix.requiresReview, true);
  assert.match(fixNoteOf(fix), /String\(key\)/);
});

test('a Mongoose findById per item becomes one find on _id', (context) => {
  const { text, errors } = fixedSource(
    context,
    mongooseFiles,
    `${mongooseHeader}export async function load(orders: { userId: string }[]) {
  for (const order of orders) {
    const user = await User.findById(order.userId);
    console.log(user);
  }
}`,
    'orm-query-in-loop',
  );
  assert.deepEqual(errors, []);
  assert.ok(text.includes('const users = await User.find({ _id: { $in: orders.map((order) => order.userId) } });'));
});

test('a Mongoose filter with an operator per item is left alone', (context) => {
  assertNoFix(
    context,
    mongooseFiles,
    `${mongooseHeader}export async function load(orders: { email: string }[]) {
  for (const order of orders) {
    const user = await User.findOne({ email: { $regex: order.email } });
    console.log(user);
  }
}`,
    'orm-query-in-loop',
  );
});

test('a Sequelize findOne per item becomes findAll with Op.in, adding Op to the sequelize import', (context) => {
  const { text, errors, fix } = fixedSource(
    context,
    sequelizeFiles,
    `import { Model } from 'sequelize';
class User extends Model {
  declare id: number;
  declare email: string;
}
export async function load(orders: { userId: number }[]) {
  for (const order of orders) {
    const user = await User.findOne({ where: { id: order.userId }, raw: true });
    console.log(user);
  }
}`,
    'orm-query-in-loop',
  );
  assert.deepEqual(errors, []);
  assert.match(text, /^import \{ Model, Op \} from 'sequelize';/);
  assert.ok(
    text.includes(
      'const users = await User.findAll({ where: { id: { [Op.in]: orders.map((order) => order.userId) } }, raw: true });',
    ),
  );
  assert.ok(text.includes('const user = usersById.get(order.userId) ?? null;'));
  assert.equal(fix.requiresReview, undefined);
});

test('a Sequelize lookup without a named sequelize import or with per-item options is left alone', (context) => {
  assertNoFix(
    context,
    sequelizeFiles,
    `import * as sequelize from 'sequelize';
class User extends sequelize.Model {}
export async function load(orders: { userId: number }[]) {
  for (const order of orders) {
    const user = await User.findOne({ where: { id: order.userId } });
    console.log(user);
  }
}`,
    'orm-query-in-loop',
  );
  assertNoFix(
    context,
    sequelizeFiles,
    `import { Model } from 'sequelize';
class User extends Model {}
export async function load(orders: { userId: number; scope: string[] }[]) {
  for (const order of orders) {
    const user = await User.findOne({ where: { id: order.userId }, include: order.scope });
    console.log(user);
  }
}`,
    'orm-query-in-loop',
  );
});

test('a Firebase send per item becomes sendEach over slices of 500', (context) => {
  const { text, errors, fix } = fixedSource(
    context,
    notificationFiles,
    `import { messaging } from 'firebase-admin';
export async function run(devices: { token: string }[]) {
  for (const device of devices) {
    await messaging().send({ token: device.token, android: { priority: 'high' } });
  }
}`,
    'notification-send-in-loop',
  );
  assert.deepEqual(errors, []);
  assert.ok(
    text.includes(`  for (let start = 0; start < devices.length; start += 500) {
    await messaging().sendEach(devices.slice(start, start + 500).map((device) => ({ token: device.token, android: { priority: 'high' } })));
  }`),
  );
  assert.equal(fix.requiresReview, true);
  assert.match(fixNoteOf(fix), /failureCount/);
});

test('SendGrid sends per item become array sends; Expo sends go through chunkPushNotifications', (context) => {
  const sendgrid = fixedSource(
    context,
    notificationFiles,
    `import mail from '@sendgrid/mail';
export async function run(emails: string[]) {
  for (const email of emails) await mail.send({ to: email, subject: 'Hi' });
}`,
    'notification-send-in-loop',
  );
  assert.deepEqual(sendgrid.errors, []);
  assert.ok(
    sendgrid.text.includes(
      "await mail.send(emails.slice(start, start + 1000).map((email) => ({ to: email, subject: 'Hi' })));",
    ),
  );
  assert.equal(sendgrid.fix.requiresReview, true);
  const expo = fixedSource(
    context,
    notificationFiles,
    `import { Expo } from 'expo-server-sdk';
declare const expo: Expo;
export async function run(tokens: string[]) {
  for (const token of tokens) {
    await expo.sendPushNotificationsAsync([{ to: token, sound: 'default' }]);
  }
}`,
    'notification-send-in-loop',
  );
  assert.deepEqual(expo.errors, []);
  assert.ok(
    expo.text
      .includes(`  for (const chunk of expo.chunkPushNotifications(tokens.map((token) => ({ to: token, sound: 'default' })))) {
    await expo.sendPushNotificationsAsync(chunk);
  }`),
  );
});

test('sends whose result is used, that share the loop with other work or read loop locals are left alone', (context) => {
  for (const body of [
    'const id = await messaging().send({ token: device.token });\n    console.log(id);',
    'console.log(device);\n    await messaging().send({ token: device.token });',
    'await messaging().send({ token: device.token, data: { at: String(Date.now()) } }).then(() => device);',
  ]) {
    assertNoFix(
      context,
      notificationFiles,
      `import { messaging } from 'firebase-admin';
export async function run(devices: { token: string }[]) {
  for (const device of devices) {
    ${body}
  }
}`,
      'notification-send-in-loop',
    );
  }
});
