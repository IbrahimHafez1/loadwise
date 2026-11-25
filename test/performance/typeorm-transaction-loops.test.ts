import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.js';
import { lineOf } from '../types/finding-fix.js';

// The trailing `// marker` comment of a source line.
function markerOf(sourceLine: string | undefined): string {
  const marker = /\/\/ (\S+)$/.exec(sourceLine ?? '')?.[1];
  assert.ok(marker, 'expected a trailing marker comment');
  return marker;
}

test('reports one-hop per-item TypeORM transactions while preserving chunk, retry and deferred scopes', () => {
  const source = `import { DataSource, EntityManager } from 'typeorm';
    declare const db: DataSource, manager: EntityManager;
    declare const other: { transaction(action: () => Promise<void>): Promise<void> };
    declare const replaceMethod: MethodDecorator;
    class Importer {
      async run(rows: number[], pages: number[][]) {
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          try { await this.saveRow(row); } catch { continue; } // report
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
    // Per-item isolation is still one transaction per item, but merging the loop into one would
    // change behavior.
  );
  assert.match(findings[0].message, /opens a TypeORM transaction for every item/);
  assert.match(findings[0].message, /do not just wrap the loop in one transaction/);
  assert.match(findings[1].message, /Open one transaction around the loop/);
});

test('a per-item manager.transaction() inside an outer transaction is worded as a savepoint', () => {
  const source = `import { DataSource, EntityManager } from 'typeorm';
    declare const db: DataSource;
    class Importer {
      async run(rows: number[], errors: unknown[]) {
        await db.transaction(async (manager) => {
          for (const row of rows) {
            try { await this.saveRow(manager, row); } catch (error) { errors.push(error); } // isolated
          }
          for (const row of rows) await this.saveRow(manager, row); // plain
        });
        for (const row of rows) await this.openRow(row); // fresh
      }
      private saveRow(manager: EntityManager, row: number) { return manager.transaction(async () => row); }
      private openRow(row: number) { return db.transaction(async () => row); }
    }`;
  const declarations = {
    'node_modules/typeorm/index.d.ts':
      'export class EntityManager { transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> }\n' +
      'export class DataSource { transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> }',
  };
  const lines = source.split('\n');
  const byMarker = Object.fromEntries(
    lint(source, declarations)
      .filter((item) => item.ruleId === 'typeorm-transaction-in-loop')
      .map((item) => [markerOf(lines[lineOf(item) - 1]), item]),
  );
  assert.match(byMarker.isolated.message, /SAVEPOINT and RELEASE SAVEPOINT round trip pair per item/);
  assert.match(byMarker.isolated.message, /keep them where rows can fail/);
  assert.ok(byMarker.isolated.contextualReason);
  assert.match(byMarker.plain.message, /the savepoint isolates nothing/);
  assert.equal(byMarker.plain.contextualReason, undefined);
  assert.match(byMarker.fresh.message, /costing a BEGIN and COMMIT round trip per item/);
});
