import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';
import { reasonOf } from '../types/finding-reason.cjs';
import { lineOfFinding } from '../types/finding-line.cjs';

const typeorm = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
      find(options?: object): Promise<T[]>;
      findOne(options: object): Promise<T | null>;
      save(entity: T): Promise<T>;
      update(criteria: object | string, values: object): Promise<object>;
    }
    export class EntityManager {
      update(target: Function, criteria: object, values: object): Promise<object>;
      transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T>;
    }
    export class DataSource { transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> }`,
  'node_modules/bullmq/index.d.ts': 'export class Queue { add(name: string, data: object): Promise<object> }',
};

// Each line marked `// <label>` must be reported, contextual exactly when the label is not
// `default`.
function contextsByMarker(source: string, ruleId: string) {
  const findings = lint(source, typeorm).filter((finding: Finding) => finding.ruleId === ruleId);
  const lines = source.split('\n');
  return findings.map((finding: Finding) => [
    /\/\/ (\S+)$/.exec(lines[lineOfFinding(finding) - 1])?.[1],
    finding.contextualReason ? 'contextual' : 'default',
  ]);
}

test('a per-item try/catch that handles the failure makes a loop finding contextual; one that rethrows does not', () => {
  const source = `import { Repository } from 'typeorm';
    declare const users: Repository<{ id: string }>;
    export async function importRows(rows: { id: string }[], errors: string[]) {
      for (const row of rows) {
        try {
          await users.save(row); // contextual
        } catch (error) {
          errors.push(String(error));
        }
      }
      for (const row of rows) {
        try {
          await users.save(row); // default
        } catch (error) {
          if (error instanceof TypeError) continue;
          throw error;
        }
      }
    }`;
  assert.deepEqual(contextsByMarker(source, 'orm-query-in-loop'), [
    ['contextual', 'contextual'],
    ['default', 'default'],
  ]);
  const [isolated] = lint(source, typeorm).filter((finding: Finding) => finding.ruleId === 'orm-query-in-loop');
  assert.match(reasonOf(isolated), /own try\/catch/);
});

test('Promise.allSettled over a map keeps failures apart and is contextual; Promise.all is not', () => {
  const source = `import { Repository } from 'typeorm';
    declare const users: Repository<{ id: string }>;
    export async function mark(rows: { id: string }[]) {
      await Promise.allSettled(rows.map((row) => users.update(row.id, { seen: true }))); // contextual
      await Promise.all(rows.map((row) => users.update(row.id, { seen: true }))); // default
    }`;
  const findings = lint(source, typeorm).filter((finding: Finding) => finding.ruleId === 'orm-query-in-loop');
  assert.deepEqual(
    findings.map((finding: Finding) => Boolean(finding.contextualReason)),
    [true, false],
  );
  assert.match(reasonOf(findings[0]), /Promise\.allSettled/);
  for (const finding of findings) {
    assert.match(finding.message, /starts them at once, so the waits overlap/);
    assert.doesNotMatch(finding.message, /adding a round trip each time/);
  }
});

test('a scheduled job over one capped page is contextual; an uncapped or unscheduled loop stays default', () => {
  const source = `import { Repository } from 'typeorm';
    import { Queue } from 'bullmq';
    declare const Cron: (expression: string) => MethodDecorator;
    declare const runs: Repository<{ id: string }>;
    declare const queue: Queue;
    export class Sweeper {
      @Cron('* * * * *')
      async tick() {
        await this.sweep();
        const all = await runs.find();
        for (const run of all) await queue.add('resume', run); // default
      }
      async sweep() {
        const due = await runs.find({ take: 100 });
        for (const run of due) await queue.add('resume', run); // contextual
      }
      async onRequest() {
        const due = await runs.find({ take: 100 });
        for (const run of due) await queue.add('resume', run); // default
      }
    }`;
  assert.deepEqual(contextsByMarker(source, 'queue-add-in-loop'), [
    ['default', 'default'],
    ['contextual', 'contextual'],
    ['default', 'default'],
  ]);
});

test('index-derived positions under a unique index are contextual renumbering', () => {
  const source = `import { EntityManager } from 'typeorm';
    declare class Session { id: string; position: number }
    export async function renumber(em: EntityManager, sessions: Session[]) {
      for (const [index, session] of sessions.entries()) {
        await em.update(Session, { id: session.id }, { position: sessions.length + index + 1 }); // contextual
      }
      for (const session of sessions) {
        await em.update(Session, { id: session.id }, { position: session.position + 1 }); // contextual
      }
      for (const session of sessions) {
        await em.update(Session, { id: session.id }, { archived: true }); // default
      }
    }`;
  assert.deepEqual(contextsByMarker(source, 'orm-query-in-loop'), [
    ['contextual', 'contextual'],
    ['contextual', 'contextual'],
    ['default', 'default'],
  ]);
});

test('the children of one record loaded by key are contextual; a loaded list is not', () => {
  const source = `import { Repository } from 'typeorm';
    declare const orders: Repository<{ id: string; items: { id: string }[] }>;
    declare const lines: Repository<{ id: string }>;
    export async function settle(id: string) {
      const loaded = await orders.findOne({ where: { id }, relations: { items: true } });
      if (!loaded) return;
      for (const item of loaded.items) await lines.save(item); // contextual
      const all = await orders.find();
      for (const each of all) await lines.save(each); // default
    }`;
  assert.deepEqual(contextsByMarker(source, 'orm-query-in-loop'), [
    ['contextual', 'contextual'],
    ['default', 'default'],
  ]);
});
