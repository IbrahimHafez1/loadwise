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
        for (const id of ids) await this.importer.importRow(id);
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
