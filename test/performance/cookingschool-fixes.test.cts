import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.cjs';
import { requireFix, scanWithFixes } from './site-fix-helpers.cjs';
import type { Finding, FixChange } from '../../lib/shared/types.cjs';

const typeorm = `export class Repository<T> {
  findOne(options: object): Promise<T | null>;
}`;

function loopLines(source: string) {
  return lint(source, { 'node_modules/typeorm/index.d.ts': typeorm })
    .filter((finding: Finding) => finding.ruleId === 'orm-query-in-loop')
    .map((finding: Finding) => finding.line);
}

function markedLines(source: string) {
  return source.split('\n').flatMap((line: string, index: number) => (line.endsWith('// loop') ? [index + 1] : []));
}

test('a load in the else branch of a cache hit test that stores into the same cache is memoised', () => {
  const source = `import { Repository } from 'typeorm';
    declare const repo: Repository<{ id: number }>, names: string[];
    async function run() {
      const byName = new Map<string, object | null>();
      for (const name of names) {
        let row: object | null;
        if (byName.has(name)) {
          row = byName.get(name)!;
        } else {
          row = await repo.findOne({ where: { name } });
          byName.set(name, row);
        }
      }
      const seen = new Map<string, object | null>();
      for (const name of names) {
        const hit = seen.get(name);
        if (hit !== undefined) continue;
        else {
          const row = await repo.findOne({ where: { name } });
          seen.set(name, row);
        }
      }
      const unused = new Map<string, object | null>();
      for (const name of names) {
        if (unused.has(name)) {
          continue;
        } else {
          await repo.findOne({ where: { name } }); // loop
        }
      }
      const other = new Map<string, object | null>();
      for (const name of names) {
        if (!byName.has(name)) {
          continue;
        } else {
          other.set(name, await repo.findOne({ where: { name } })); // loop
        }
      }
    }`;
  assert.deepEqual(loopLines(source), markedLines(source));
});

const lastInsertStubs = {
  'node_modules/drizzle-orm/index.d.ts': 'export function sql(parts: TemplateStringsArray): object;',
  'node_modules/drizzle-orm/mysql2/index.d.ts': `export class MySql2Database {
    insert(table: object): { values(row: object): Promise<[{ insertId: number }]> };
    execute(query: object): Promise<unknown[]>;
  }`,
  'node_modules/drizzle-orm/mysql-core/index.d.ts': `export function mysqlTable(name: string, columns: object): object;
    export function int(name: string): {autoincrement(): object};`,
};

test('a long generated-ID fallback is split across lines at the ?? operator', (context) => {
  const source = `import { sql } from 'drizzle-orm';
import { mysqlTable, int } from 'drizzle-orm/mysql-core';
import { MySql2Database } from 'drizzle-orm/mysql2';
const shoppingCarts = mysqlTable('shopping_carts', {id: int('id').autoincrement()});
declare const transaction: MySql2Database;
async function createGuestCart() {
  {
    await transaction.insert(shoppingCarts).values({ sessionId: 'a' });

    // Get the last inserted ID using raw SQL
    const lastIdResult = await transaction.execute(sql\`SELECT LAST_INSERT_ID() as id\`);
    const insertedId = (lastIdResult[0] as unknown as Array<{ id: number }>)[0]!.id;
    return insertedId;
  }
}`;
  const [finding] = scanWithFixes(context, { ...lastInsertStubs, 'src.ts': source }).findings.filter(
    ({ ruleId }) => ruleId === 'drizzle-last-insert-id',
  );
  const fixed = requireFix(finding).changes.reduce(
    (text: string, change: FixChange) => text.replace(change.before, () => change.after),
    source,
  );
  assert.ok(
    fixed.includes(`    const lastIdResult = await transaction.insert(shoppingCarts).values({ sessionId: 'a' });
    const insertedId =
      lastIdResult?.[0]?.insertId ??
      ((await transaction.execute(sql\`SELECT LAST_INSERT_ID() as id\`))[0] as unknown as Array<{ id: number }>)[0]!.id;
    return insertedId;`),
    fixed,
  );
});
