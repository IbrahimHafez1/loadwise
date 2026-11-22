'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { applyFix } = require('../../editor/apply-fix.cjs');
const { scanWithFixes } = require('./site-fix-helpers.cjs');

const stubs = {
  'node_modules/drizzle-orm/index.d.ts': `export type SQL = object;
export function sql(parts: TemplateStringsArray): SQL;`,
  'node_modules/drizzle-orm/mysql2/index.d.ts': `export class MySql2Database {
    insert(table: object): { values(row: object): Promise<[{ insertId: number }]> };
    execute(query: object): Promise<unknown[]>;
  }`,
  'node_modules/drizzle-orm/mysql-core/index.d.ts': `export function mysqlTable(name: string, columns: object): object;
    export function int(name: string): {autoincrement(): object};`,
  'package.json': '{}',
  'src/database/schema.ts': 'export {};',
};

function service(table) {
  return `import { sql } from 'drizzle-orm';
import { mysqlTable, int } from 'drizzle-orm/mysql-core';
import { MySql2Database } from 'drizzle-orm/mysql2';
const ${table} = mysqlTable('${table}', {id: int('id').autoincrement()});
declare const transaction: MySql2Database;
export async function create() {
  await transaction.insert(${table}).values({ name: 'a' });
  const lastIdResult = await transaction.execute(sql\`SELECT LAST_INSERT_ID() as id\`);
  const insertedId = (lastIdResult[0] as unknown as Array<{ id: number }>)[0]!.id;
  return insertedId;
}
`;
}

function lastInsertFindings(context, files) {
  const { root, findings } = scanWithFixes(context, { ...stubs, ...files });
  return { root, findings: findings.filter(({ ruleId }) => ruleId === 'drizzle-last-insert-id') };
}

function diskAccess() {
  return {
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    writeFile: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
  };
}

test('several generated-ID sites share one helper next to the database code', (context) => {
  const { root, findings } = lastInsertFindings(context, {
    'src/orders/orders.service.ts': service('orders'),
    'src/carts/carts.service.ts': service('carts'),
  });
  assert.equal(findings.length, 2);
  const helperPath = path.join(root, 'src', 'database', 'read-inserted-id.ts');
  for (const finding of findings) {
    assert.equal(finding.fix.requiresReview, true);
    const created = finding.fix.changes.filter((change) => change.create);
    assert.deepEqual(
      created.map((change) => path.resolve(change.file)),
      [helperPath],
    );
  }
  const access = diskAccess();
  const outcomes = findings.map((finding) => applyFix(finding.fix, access));
  assert.deepEqual(
    outcomes.map(({ error }) => error),
    [undefined, undefined],
    'the shared helper is written once and the second fix accepts it',
  );
  const helper = fs.readFileSync(helperPath, 'utf8');
  assert.match(helper, /export async function readInsertedId\(/);
  assert.match(helper, /LAST_INSERT_ID\(\)/);
  const orders = fs.readFileSync(findings.find(({ file }) => file.includes('orders')).file, 'utf8');
  assert.match(orders, /import \{ readInsertedId \} from '\.\.\/database\/read-inserted-id';/);
  assert.match(orders, /const insertedId = await readInsertedId\(lastIdResult, transaction\);/);
  assert.ok(!orders.includes('SELECT LAST_INSERT_ID()'), 'the lookup is no longer pasted into the service');
});

test('an existing helper is reused instead of written again', (context) => {
  const helperText = 'export async function readInsertedId(result: unknown, database: unknown) { return 1; }\n';
  const { root, findings } = lastInsertFindings(context, {
    'src/database/read-inserted-id.ts': helperText,
    'src/orders/orders.service.ts': service('orders'),
  });
  assert.equal(findings.length, 1);
  assert.ok(findings[0].fix.changes.every((change) => !change.create));
  assert.ok(findings[0].fix.changes.some((change) => change.after.includes("from '../database/read-inserted-id'")));
  assert.equal(fs.readFileSync(path.join(root, 'src/database/read-inserted-id.ts'), 'utf8'), helperText);
});

test('without database code to put a helper beside, the lookup stays inline', (context) => {
  const { 'src/database/schema.ts': _schema, ...withoutDatabase } = stubs;
  const { findings } = scanWithFixes(context, {
    ...withoutDatabase,
    'src/orders/orders.service.ts': service('orders'),
  });
  const [finding] = findings.filter(({ ruleId }) => ruleId === 'drizzle-last-insert-id');
  assert.ok(finding.fix.changes.every((change) => !change.create));
  assert.ok(finding.fix.changes.some((change) => change.after.includes('LAST_INSERT_ID')));
});

test('the upload size fix names its limit and is review-only', (context) => {
  const { findings } = scanWithFixes(context, {
    'node_modules/@nestjs/platform-express/index.d.ts':
      'export declare function FileInterceptor(field: string, options?: any): any;',
    'src/app.ts': `import { FileInterceptor } from '@nestjs/platform-express';\nexport const a = FileInterceptor('file');\n`,
  });
  const [finding] = findings.filter(({ ruleId }) => ruleId === 'upload-without-size-limit');
  assert.equal(finding.fix.requiresReview, true);
  assert.match(finding.fix.note, /real upload/);
  const text = finding.fix.changes.map((change) => change.after).join('\n');
  assert.match(text, /const MAX_UPLOAD_FILE_SIZE_BYTES = 10 \* 1024 \* 1024;/);
  assert.match(text, /fileSize: MAX_UPLOAD_FILE_SIZE_BYTES/);
});
