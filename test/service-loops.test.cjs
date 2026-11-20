'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

const RULE_ID = 'service-query-in-loop';
const packages = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
      findOne(options: object): Promise<T | null>;
      save(entity: T): Promise<T>;
      create(entity: object): T;
      createQueryBuilder(): UpdateQueryBuilder;
    }
    export class UpdateQueryBuilder {
      update(): UpdateQueryBuilder;
      set(values: object): UpdateQueryBuilder;
      execute(): Promise<object>;
    }
    export class DataSource { transaction<T>(work: () => Promise<T>): Promise<T> }`,
  'node_modules/ioredis/index.d.ts': 'export default class Redis { del(key: string): Promise<number> }',
  'node_modules/bullmq/index.d.ts': 'export class Queue { add(name: string, data: object): Promise<object> }',
};
const services = `import { Repository, DataSource } from 'typeorm';
  import Redis from 'ioredis';
  import { Queue } from 'bullmq';
  export class ContentService {
    constructor(private items: Repository<{ id: string }>) {}
    async approve(id: string) {
      const item = await this.items.findOne({ where: { id } });
      await this.items.save(item!);
    }
  }
  export class PublishingService {
    constructor(private posts: Repository<{ id: string }>, private queue: Queue) {}
    async dispatch(id: string) {
      await this.posts.findOne({ where: { id } });
      await this.queue.add('publish', { id });
    }
    async stamp(id: string) {
      await this.posts.createQueryBuilder().update().set({ id }).execute();
    }
    async build(id: string) { return this.posts.create({ id }); }
    async tryPublish(id: string) {
      try { return id; } catch { await this.posts.save({ id }); }
    }
    async approveAll(ids: string[]) { await this.posts.findOne({ where: { ids } }); }
  }
  export class CacheService {
    constructor(private redis: Redis) {}
    async invalidate(key: string) { await this.redis.del(key); }
  }
  export class Importer {
    constructor(private db: DataSource, private posts: Repository<{ id: string }>) {}
    async importRow(id: string) { await this.db.transaction(async () => this.posts.save({ id })); }
  }`;

function findingsFor(source) {
  return lint(source, { ...packages, 'services.ts': services }).filter((finding) => finding.ruleId === RULE_ID);
}

function reportedLines(source) {
  return source.split('\n').flatMap((line, index) => (line.includes('// report') ? [index + 1] : []));
}

test('reports project calls in loops whose callee queries, one or two levels deep', () => {
  const source = `import { ContentService, PublishingService, CacheService } from './services.js';
    declare const ids: string[];
    class Scheduler {
      constructor(private content: ContentService, private publishing: PublishingService, private cache: CacheService) {}
      async approve(id: string) {
        await this.content.approve(id);
        return id;
      }

      async run() {
        for (const id of ids) await this.approve(id); // report
        await Promise.all(ids.map((id) => this.publishing.dispatch(id))); // report
        for (let index = 0; index < ids.length; index++) await this.cache.invalidate(ids[index]); // report
        ids.forEach(async (id) => { await this.publishing.stamp(id); }); // report
      }
    }`;
  const findings = findingsFor(source);
  assert.deepEqual(
    findings.map((finding) => finding.line),
    reportedLines(source),
  );
  const [approve, dispatch, invalidate, stamp] = findings;
  assert.match(
    approve.message,
    /^`this\.approve\(\)` makes up to 2 database calls per item \(items\.findOne, items\.save in services\.ts:7\)/,
  );
  assert.match(approve.message, /`In\(ids\)` read/);
  assert.deepEqual(
    approve.related.map((link) => [link.file.split('/').pop(), link.line]),
    [
      ['services.ts', 7],
      ['services.ts', 8],
    ],
  );
  assert.match(dispatch.message, /posts\.findOne, queue\.add/);
  assert.match(dispatch.message, /database and Redis calls/);
  assert.match(dispatch.message, /`addBulk\(\)`/);
  assert.match(invalidate.message, /makes a Redis command per item \(redis\.del/);
  // A query builder chain is one statement, not one per step.
  assert.match(stamp.message, /makes a database call per item \(posts\.execute/);
});

test('skips bounded loops, batches, transactions, failure paths and calls without database work', () => {
  const source = `import { ContentService, PublishingService, Importer } from './services.js';
    declare const ids: string[];
    enum Channel { Sms = 'sms', Email = 'email' }
    const CHAINS = { fast: ['a', 'b'], slow: ['c'] } as const;
    function selectIds() { const chosen = ['x', 'y'].filter(Boolean); return chosen; }
    class Runner {
      constructor(private content: ContentService, private publishing: PublishingService, private importer: Importer) {}
      async local(id: string) { return id.length; }
      async walk(id: string): Promise<void> { for (const child of ids) await this.walk(child); }
      async run(tier: 'fast' | 'slow') {
        for (const id of ['a', 'b', 'c']) await this.content.approve(id);
        for (const id of CHAINS[tier]) await this.content.approve(id);
        for (const id of selectIds()) await this.content.approve(id);
        for (const channel of Object.values(Channel)) await this.content.approve(channel);
        for (const id of ids) await this.publishing.approveAll([id]);
        for (const id of ids) await this.publishing.build(id);
        for (const id of ids) await this.publishing.tryPublish(id);
        for (const id of ids) await this.local(id);
        for (const id of ids) { try { await this.local(id); } catch { await this.content.approve(id); } }
        for (let attempt = 0; attempt < 30; attempt++) await this.content.approve('poll');
        while (ids.length) await this.content.approve(ids.pop()!);
        await this.content.approve('once');
      }
    }`;
  assert.deepEqual(findingsFor(source), []);
});

const extraPackages = {
  ...packages,
  'node_modules/@prisma/client/index.d.ts': `export declare class PrismaClient {
      $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
    }`,
};
const extraServices = `import { Repository, DataSource } from 'typeorm';
  import { PrismaClient } from '@prisma/client';
  export class CacheLayer {
    async getOrFetch<T>(key: string, load: () => Promise<T>): Promise<T> { return load(); }
  }
  export class Reader {
    constructor(private items: Repository<{ id: string }>, private cache: CacheLayer, private db: DataSource,
      private prisma: PrismaClient) {}
    async lookup(id: string) { return this.items.findOne({ where: { id } }); }
    read(id: string) { return this.cache.getOrFetch(id, () => this.lookup(id)); }
    async approveWhere(filter: { in: string[] }) { await this.items.findOne({ where: { id: filter } }); }
    async importOne(id: string, warnings: string[]) {
      const row = await this.items.findOne({ where: { id } });
      if (!row) this.warn(id, warnings);
    }
    private warn(id: string, warnings: string[]) { warnings.push(id); }
    async importRow(id: string) {
      await this.items.findOne({ where: { id } });
      await this.db.transaction(async () => this.items.save({ id }));
    }
    async bump(id: string) { await this.prisma.$executeRaw\`UPDATE item SET hits = hits + 1 WHERE id = \${id}\`; }
    async longFlow(id: string) {
      const first = id.trim();
      const second = first.toLowerCase();
      const third = second.toUpperCase();
      const fourth = third.length;
      await this.items.findOne({ where: { id: String(fourth) } });
      await this.importRow(id);
    }
  }`;

function extraFindings(source) {
  return lint(source, { ...extraPackages, 'extra.ts': extraServices }).filter((finding) => finding.ruleId === RULE_ID);
}

test('skips memoised, cached, failure-only, small constructed and key-set calls', () => {
  const source = `import { Reader } from './extra.js';
    declare const ids: string[], first: string, second: string | undefined;
    declare const groups: { ids: string[] }[];
    const BASE = ['a', 'b'] as const;
    function picked() { return ['x', ...BASE.filter(Boolean)]; }
    class Runner {
      constructor(private reader: Reader) {}
      private async rollback(created: string[]) {
        for (const id of created) await this.reader.lookup(id);
      }
      async compose() {
        try { return await this.reader.lookup('new'); } catch (error) { await this.rollback(ids); throw error; }
      }
      async run() {
        for (const id of picked()) await this.reader.lookup(id);
        for (const id of ids.slice(0, 2)) await this.reader.lookup(id);
        const pair = [first, second].filter((id): id is string => !!id);
        const loaded = await Promise.all(pair.map(async (id) => id));
        for (const id of loaded) await this.reader.lookup(id);
        let fallback: object | null | undefined;
        for (const id of ids) fallback ??= await this.reader.lookup(id);
        const seen = new Map<string, object | null>();
        for (const id of ids) {
          let row = seen.get(id);
          if (!row) {
            row = await this.reader.lookup(id);
            seen.set(id, row);
          }
        }
        for (const id of ids) await this.reader.read(id);
        for (const group of groups) await this.reader.approveWhere({ in: group.ids });
        return fallback;
      }
    }`;
  assert.deepEqual(extraFindings(source), []);
});

test('reports output-list arguments, transaction callees and raw templates, and words partial counts as a floor', () => {
  const source = `import { Reader } from './extra.js';
    declare const ids: string[];
    class Runner {
      constructor(private reader: Reader) {}
      async run() {
        const warnings: string[] = [];
        for (const id of ids) await this.reader.importOne(id, warnings); // report
        for (const id of ids) await this.reader.importRow(id); // report
        for (const id of ids) await this.reader.bump(id); // report
        for (const id of ids) await this.reader.longFlow(id); // report
      }
    }`;
  const findings = extraFindings(source);
  assert.deepEqual(
    findings.map((finding) => finding.line),
    reportedLines(source),
  );
  const [, importRow, bump, longFlow] = findings;
  assert.match(
    importRow.message,
    /makes up to 3 database calls per item \(items\.findOne, db\.transaction, items\.save/,
  );
  assert.match(bump.message, /makes a database call per item \(prisma\.\$executeRaw/);
  assert.match(longFlow.message, /makes at least one database call per item/);
  assert.match(longFlow.message, /pays at least one round trip/);
});

test('words Promise.all fan-out as concurrent and gives per-item transaction steps an ordering or lease context', () => {
  const ledger = `import { DataSource, EntityManager } from 'typeorm';
    export class Ledger {
      constructor(private db: DataSource) {}
      async settle(id: string, manager: EntityManager) {
        await this.db.transaction(async () => manager.findOne({ where: { id } }));
      }
    }`;
  const files = {
    'node_modules/typeorm/index.d.ts': `export class EntityManager { findOne(options: object): Promise<object | null> }
      export class DataSource { transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> }`,
    'ledger.ts': ledger,
  };
  const source = `import { DataSource, EntityManager } from 'typeorm';
    import { Ledger } from './ledger.js';
    declare const db: DataSource, shared: EntityManager;
    declare class AbortSignal { readonly aborted: boolean }
    declare const ids: string[];
    class Payments {
      constructor(private ledger: Ledger) {}
      async run(lease: AbortSignal) {
        await db.transaction(async (manager) => {
          for (const id of [...ids].sort()) await this.ledger.settle(id, manager); // sorted
          for (const id of ids) await this.ledger.settle(id, manager); // default
        });
        for (const id of ids) {
          if (lease.aborted) break;
          await this.ledger.settle(id, shared); // lease
        }
        await db.transaction(async (manager) => {
          await Promise.all(ids.map((id) => this.ledger.settle(id, manager))); // concurrent
        });
      }
    }`;
  const findings = lint(source, files).filter((finding) => finding.ruleId === RULE_ID);
  const lines = source.split('\n');
  const byMarker = Object.fromEntries(
    findings.map((finding) => [/\/\/ (\S+)$/.exec(lines[finding.line - 1])[1], finding]),
  );
  assert.match(byMarker.sorted.contextualReason, /sorted just before it/);
  assert.equal(byMarker.default.contextualReason, undefined);
  assert.match(byMarker.lease.contextualReason, /lease is lost/);
  assert.equal(byMarker.concurrent.contextualReason, undefined);
  assert.match(byMarker.concurrent.message, /`Promise\.all` starts every item at once, so the waits overlap/);
  assert.match(byMarker.default.message, /so the loop pays/);
});

test('skips calls on the injected stores a service walks and keeps wording accurate for ordered loops', () => {
  const source = `import { ContentService } from './services.js';
    declare const ids: string[];
    class Registry {
      constructor(private content: ContentService, private readonly stores: ContentService[]) {}
      private readonly pending: ContentService[] = [];
      async flush(id: string) {
        for (const store of this.stores ?? []) await store.approve(id);
        for (const store of this.pending) await store.approve(id); // report
        for (const item of ids) await this.content.approve(item); // report
      }
    }`;
  const findings = findingsFor(source);
  assert.deepEqual(
    findings.map((finding) => finding.line),
    reportedLines(source),
  );
  assert.doesNotMatch(findings[1].message, /grows with the list/);
  assert.match(findings[1].message, /for every item it handles/);
  assert.match(findings[1].message, /ordering and transaction needs/);
});
