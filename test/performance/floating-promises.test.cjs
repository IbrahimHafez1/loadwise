'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { lint } = require('./helpers.cjs');
const { loadQueryPolicy } = require('../../lib/performance/query-policy.cjs');
const { scanWithFixes } = require('./site-fix-helpers.cjs');

const rule = 'floating-promise';
const header = `declare function sendEmail(to: string): Promise<void>;
declare function trackEvent(name: string): Promise<void>;
declare function syncValue(): number;
declare const items: string[];
declare const maybe: Promise<void> | undefined;
interface Thenable { then(onFulfilled: () => void): void }
declare function thenable(): Thenable;
`;

function reported(body, policy) {
  return lint(header + body, {}, policy).filter((finding) => finding.ruleId === rule);
}

test('a promise-returning call used as a statement in an async function is reported', () => {
  const [finding] = reported(`export async function signup(email: string) {
  sendEmail(email);
}`);
  assert.equal(finding.line, 9);
  assert.match(
    finding.message,
    /^`sendEmail\(\)` returns a promise that is neither awaited nor given a rejection handler/,
  );
});

test('a request handler that is not async is covered by its request parameter', () => {
  assert.equal(reported(`export function handle(req: object) {\n  sendEmail('a');\n}`).length, 1);
  assert.equal(reported(`export function helper(value: object) {\n  sendEmail('a');\n}`).length, 0);
});

test('thenables, unions with undefined and .then without a rejection handler are reported', () => {
  assert.equal(reported(`export async function run() {\n  thenable();\n}`).length, 1);
  assert.equal(reported(`export async function run() {\n  maybe;\n}`).length, 0, 'not a call');
  assert.equal(reported(`export async function run() {\n  sendEmail('a').then(() => 1);\n}`).length, 1);
  assert.equal(
    reported(`export async function run() {\n  sendEmail('a').catch(() => 1).finally(() => 1);\n}`).length,
    0,
  );
  assert.equal(reported(`export async function run() {\n  sendEmail('a').finally(() => 1);\n}`).length, 1);
});

test('missing and nullish promise rejection handlers leave the rejection unhandled', () => {
  const body = `export async function run() {
    const disabledHandler = null;
    sendEmail('a').catch();
    sendEmail('a').catch(undefined);
    sendEmail('a').catch((null));
    sendEmail('a').catch(disabledHandler);
    sendEmail('a').then(() => 1, undefined);
    sendEmail('a').then(() => 1, void 0);
    sendEmail('a').catch().then(undefined, console.error);
    sendEmail('a').catch(console.error).catch();
  }`;
  assert.deepEqual(
    reported(body).map((finding) => finding.line),
    [10, 11, 12, 13, 14, 15],
  );
});

test('await, return, void, assignment, arguments, catch and two-argument then are quiet', () => {
  const quiet = [
    "await sendEmail('a');",
    "return sendEmail('a');",
    "void sendEmail('a');",
    "const pending = sendEmail('a'); await pending;",
    "await Promise.all([sendEmail('a')]);",
    "sendEmail('a').catch(() => undefined);",
    "sendEmail('a').then(() => 1, () => 2);",
    "sendEmail('a').then(() => 1).catch(() => 2);",
    'syncValue();',
  ];
  for (const statement of quiet) {
    assert.deepEqual(reported(`export async function run() {\n  ${statement}\n}`), [], statement);
  }
});

test('a synchronous function, top-level code and a callback of a synchronous function are quiet', () => {
  assert.deepEqual(reported("export function run() {\n  sendEmail('a');\n}"), []);
  assert.deepEqual(reported("sendEmail('a');"), []);
  assert.deepEqual(reported("export function run() {\n  items.map(() => sendEmail('a'));\n}"), []);
});

test('a helper listed under fireAndForget in the policy is quiet', () => {
  const body = "export async function run() {\n  trackEvent('x');\n  sendEmail('a');\n}";
  const policy = { fireAndForget: ['trackEvent'] };
  assert.deepEqual(
    reported(body, policy).map((finding) => finding.line),
    [10],
  );
  assert.equal(reported(body).length, 2);
});

test('test files are quiet', (context) => {
  const source = `${header}export async function run() {
  sendEmail('a');
}`;
  const { findings } = scanWithFixes(context, { 'service.ts': source, 'service.spec.ts': source });
  const files = findings.filter((finding) => finding.ruleId === rule).map((finding) => path.basename(finding.file));
  assert.deepEqual(files, ['service.ts']);
});

test('forEach with an async callback that awaits is reported', () => {
  const [finding] = reported(`export async function run() {
  items.forEach(async (item) => {
    await sendEmail(item);
  });
}`);
  assert.equal(finding.line, 9);
  assert.match(finding.message, /^`forEach` ignores the promises its async callback returns/);
});

test('forEach with a synchronous callback, an async callback without await, or a for-of loop is quiet', () => {
  assert.deepEqual(reported('export async function run() {\n  items.forEach((item) => syncValue());\n}'), []);
  assert.deepEqual(reported('export async function run() {\n  items.forEach(async (item) => syncValue());\n}'), []);
  assert.deepEqual(
    reported('export async function run() {\n  for (const item of items) await sendEmail(item);\n}'),
    [],
  );
  assert.deepEqual(
    reported(
      'declare const lookup: { forEach(callback: (value: number) => void): void };\nexport async function run() {\n  lookup.forEach(async (value) => { await sendEmail(String(value)); });\n}',
    ),
    [],
  );
});

test('the policy loader accepts a list of helper names and rejects anything else', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-policy-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const load = (policy) => {
    const filename = path.join(directory, 'policy.json');
    fs.writeFileSync(filename, JSON.stringify(policy));
    return loadQueryPolicy(filename);
  };
  assert.deepEqual(load({ fireAndForget: ['trackEvent'] }).fireAndForget, ['trackEvent']);
  assert.throws(() => load({ fireAndForget: [] }), /fireAndForget requires a nonempty array/);
  assert.throws(() => load({ fireAndForget: ['not a name'] }), /fireAndForget requires a nonempty array/);
  assert.throws(() => load({ fireAndForget: 'trackEvent' }), /fireAndForget requires a nonempty array/);
});

test('a builder method that returns its own receiver type is quiet', () => {
  const builder = `interface Builder extends PromiseLike<void> { set(name: string): Builder; send(): Promise<void> }
declare const builder: Builder;\n`;
  assert.deepEqual(reported(`${builder}export async function run() {\n  builder.set('a');\n}`), []);
  assert.equal(reported(`${builder}export async function run() {\n  builder.send();\n}`).length, 1);
});

test('an unawaited Prisma model call says the lazy query never runs', () => {
  const files = {
    'node_modules/@prisma/client/index.d.ts': `export interface UserDelegate { create(args: object): Promise<object> }
export declare class PrismaClient { user: UserDelegate }`,
  };
  const source = `import { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
export async function signup() {
  prisma.user.create({ data: {} });
}`;
  const [finding] = lint(source, files).filter((candidate) => candidate.ruleId === rule);
  assert.match(finding.message, /^`create\(\)` returns a lazy PrismaPromise, so this query never runs/);
  assert.doesNotMatch(finding.message, /mark it with `void`/);
});

function contextualReasons(body) {
  return reported(body).map((finding) => finding.contextualReason);
}

test('a helper that returns a plain value inside its catching try is contextual', () => {
  const [reason] = contextualReasons(`async function touch(id: string) {
  try {
    await sendEmail(id);
    return true;
  } catch (error) {
    return false;
  }
}
export async function login(id: string) {
  touch(id);
}`);
  assert.match(reason, /catches its own failures/);
});

test('a helper that returns a promise from its try still escapes the catch and stays plain', () => {
  const [reason] = contextualReasons(`async function touch(id: string) {
  try {
    return sendEmail(id);
  } catch (error) {
    return undefined;
  }
}
export async function login(id: string) {
  touch(id);
}`);
  assert.equal(reason, undefined);
});

test('an unawaited call to a thin async forwarding wrapper is still reported at default level', () => {
  const [reason] = contextualReasons(`class Bus {
  async publish(topic: string) {
    await sendEmail(topic);
  }
}
export async function notify(bus: Bus) {
  bus.publish('created');
}`);
  assert.equal(reason, undefined);
});

test('an unawaited guard that can reject has no contextual reason', () => {
  const [reason] = contextualReasons(`async function assertOpen(id: string) {
  if (!id) throw new Error('closed');
  await sendEmail(id);
}
export async function update(id: string) {
  assertOpen(id);
}`);
  assert.equal(reason, undefined);
});

test('an unawaited publish on a pubsub receiver is contextual fire-and-forget fan-out', () => {
  const [reason] = contextualReasons(`class PubSub { async publish(topic: string) { await sendEmail(topic); } }
class TeamService {
  constructor(private readonly pubsub: PubSub) {}
  async addMember() {
    this.pubsub.publish('team/member_added');
  }
}`);
  assert.match(reason, /pub\/sub or event bus/);
});

test('an unawaited call on a receiver that is not an event bus stays plain', () => {
  const [reason] = contextualReasons(`class Mailer { async publish(topic: string) { await sendEmail(topic); } }
class TeamService {
  constructor(private readonly mailer: Mailer) {}
  async addMember() {
    this.mailer.publish('team/member_added');
  }
}`);
  assert.equal(reason, undefined);
});
