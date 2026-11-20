'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

test('reports one-hop per-item TypeORM transactions while preserving chunk, retry and deferred scopes', () => {
  const source = `import { DataSource, EntityManager } from 'typeorm';
    declare const db: DataSource, manager: EntityManager;
    declare const other: { transaction(action: () => Promise<void>): Promise<void> };
    declare const replaceMethod: MethodDecorator;
    class Importer {
      async run(rows: number[], pages: number[][]) {
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          try { await this.saveRow(row); } catch { continue; } // per-item isolation, nothing cheaper keeps it
          try { await this.saveRow(row); } catch (error) { throw error; } // report
        }
        for (const row of rows) await this.#insert(row); // report
        await Promise.all(rows.map(async row => { await this.saveRow(row); })); // report
        for (const row of rows) await this.custom(row);
        for (const row of rows) await this.publicHook(row);
        for (const row of rows) await this.delayed(row);
        for (const row of rows) await this.decorated(row);
        for (const page of pages) await this.savePage(page);
        await Promise.all(pages.map(async page => { await this.savePage(page); }));
        for (const row of rows) { await this.saveRow(row); break; }
        while (rows.length) await this.saveRow(rows.pop()!);
        for (const row of rows) setTimeout(async () => { await this.saveRow(row); });
        await this.saveRow(0);
      }
      private async saveRow(row: number) { await db.transaction(async () => row); }
      async #insert(row: number) { return manager.transaction(async () => row); }
      private async savePage(page: number[]) { await db.transaction(async () => page); }
      private async custom(row: number) { await other.transaction(async () => {}); }
      async publicHook(row: number) { await db.transaction(async () => row); }
      @replaceMethod private async decorated(row: number) { await db.transaction(async () => row); }
      private async delayed(row: number) { return () => db.transaction(async () => row); }
    }`;
  const declarations = {
    'node_modules/typeorm/index.d.ts':
      'export class DataSource { transaction<T>(work: () => Promise<T>): Promise<T> }\n' +
      'export class EntityManager { transaction<T>(work: () => Promise<T>): Promise<T> }',
  };
  const findings = lint(source, declarations).filter((item) => item.ruleId === 'typeorm-transaction-in-loop');
  const reported = source.split('\n').flatMap((line, index) => (line.endsWith('// report') ? [index + 1] : []));
  assert.deepEqual(
    findings.map((item) => item.line),
    reported,
  );
});
