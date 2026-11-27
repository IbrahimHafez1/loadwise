// Compact before/after snippets, one per ruleId. Each side stays within 2-6 lines so the CLI can
// print it inline.
interface RuleExample {
  before: string[];
  after: string[];
}

const examples: Record<string, RuleExample> = {
  'unused-import': {
    before: ["import { readFile, writeFile } from 'node:fs/promises';", 'await writeFile(path, text);'],
    after: ["import { writeFile } from 'node:fs/promises';", 'await writeFile(path, text);'],
  },
  'unused-local-variable': {
    before: [
      'function total(items) {',
      "  const label = 'sum';",
      '  return items.reduce((sum, item) => sum + item, 0);',
      '}',
    ],
    after: ['function total(items) {', '  return items.reduce((sum, item) => sum + item, 0);', '}'],
  },
  'stray-console': {
    before: ['export function placeOrder(order: Order) {', "  console.log('placing', order.id);", '}'],
    after: [
      'export function placeOrder(order: Order) {',
      "  logger.info({ orderId: order.id }, 'placing order');",
      '}',
    ],
  },
  'deprecated-node-api': {
    before: ['const zeroed = new Buffer(16);', "const copy = new Buffer('hi', 'utf8');"],
    after: ['const zeroed = Buffer.alloc(16);', "const copy = Buffer.from('hi', 'utf8');"],
  },
  'dependency-cycle': {
    before: ['// a.ts: import { total } from "./b";', '// b.ts: import { total } from "./a";'],
    after: [
      '// shared.ts: export const total = (xs) => xs.length;',
      '// a.ts and b.ts: import { total } from "./shared";',
    ],
  },
  'folder-boundary': {
    before: [
      '// inner/service.ts',
      'import { loadCount } from "../outer/db";',
      'export const run = () => loadCount();',
    ],
    after: [
      '// inner/service.ts',
      'export const run = (count: number) => ({ count });',
      '// outer/handler.ts (allowed to use both)',
      'run(await loadCount());',
    ],
  },
  'data-access-boundary': {
    before: ['// src/http/handler.ts', 'import { Pool } from "pg";', 'const rows = await new Pool().query(sql);'],
    after: ['// src/http/handler.ts', 'import { loadUsers } from "../data/users";', 'const rows = await loadUsers();'],
  },
  'duplicate-implementation': {
    before: ['const okA = (n) => n >= 1 && n <= 9;', 'const okB = (n) => n >= 1 && n <= 9;'],
    after: ['export const inRange = (n) => n >= 1 && n <= 9;', '// call inRange(n) from both sites'],
  },
  'high-branch-complexity': {
    before: [
      'if (kind === "a") return doA(x);',
      'if (kind === "b") return doB(x);',
      'if (kind === "c") return doC(x);',
      'return reject(x);',
    ],
    after: [
      'const handlers = { a: doA, b: doB, c: doC };',
      'const handle = handlers[kind] ?? reject;',
      'return handle(x);',
    ],
  },
  'deep-control-flow': {
    before: ['for (const item of items) {', '  if (item.ready) {', '    if (item.valid) save(item);', '  }', '}'],
    after: ['for (const item of items) {', '  if (!item.ready || !item.valid) continue;', '  save(item);', '}'],
  },
  'query-mutates-state': {
    before: ['/** @maintainabilityQuery */', 'current() { this.count += 1; return this.count; }'],
    after: ['/** @maintainabilityQuery */', 'current() { return this.count; }', 'increment() { this.count += 1; }'],
  },
  'large-class': {
    before: [
      'class OrderService {',
      '  create() {}  cancel() {}  refund() {}  invoice() {}',
      '  // 30+ more methods',
      '}',
    ],
    after: [
      'class OrderService { create() {}  cancel() {} }',
      'class RefundService { refund() {} }',
      'class InvoiceService { invoice() {} }',
    ],
  },
  'large-module': {
    before: ['// orders.ts: 600+ lines', 'export function createOrder() {}', 'export function sendInvoice() {}'],
    after: [
      '// orders/create.ts: createOrder',
      '// orders/invoice.ts: sendInvoice',
      '// orders/index.ts: re-exports both',
    ],
  },
  'long-parameter-list': {
    before: ['function send(to, from, subject, body, cc, bcc) {', '  // ...', '}', 'send(a, b, c, d, e, f);'],
    after: [
      'function send({ to, from, subject, body, cc, bcc }) {',
      '  // ...',
      '}',
      'send({ to: a, from: b, subject: c, body: d });',
    ],
  },
  'unreferenced-file': {
    before: ['// src/legacy-export.ts', '// imported by nothing, not an entry point', 'export const run = () => {};'],
    after: ['// delete src/legacy-export.ts, or import it', '// from the file that really uses it'],
  },
  'unused-export': {
    before: ['// helpers.ts', 'export const used = () => 1;', 'export const neverImported = () => 2;'],
    after: ['// helpers.ts', 'export const used = () => 1;', 'const neverImported = () => 2; // or delete it'],
  },
  'file-placement': {
    before: ['// outside the declared folder', 'src/user.controller.ts'],
    after: ['// moved, imports updated', 'src/http/user.controller.ts'],
  },
};

function exampleFor(ruleId: string): RuleExample | undefined {
  return examples[ruleId];
}

export { examples, exampleFor };
