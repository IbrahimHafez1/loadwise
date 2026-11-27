import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';
import type { FileMap } from '../types/project-files.js';

function rule(findings: Finding[], ruleId: string) {
  return findings.filter((finding: Finding) => finding.ruleId === ruleId);
}

const mongooseStub: FileMap = {
  'node_modules/mongoose/index.d.ts': `export class Model<T> {
      updateMany(filter: object, update: object): Promise<object>;
      findOne(filter: object): Promise<T | null>;
    }`,
};

test('service-query-in-loop: a slice capped by an imported small constant is a few items', () => {
  const files = {
    ...mongooseStub,
    'limits.ts': 'export const CLEANUP_BATCH_SIZE = 4;\nexport const PAGE_SIZE = 50;',
    'storage.ts': `import { Model } from 'mongoose';
      export class Storage {
        constructor(private files: Model<{ name: string }>) {}
        async removeNow(name: string) { await this.files.findOne({ name }); }
      }`,
  };
  const source = (limit: string) => `import { Storage } from './storage';
    import { ${limit} } from './limits';
    export async function clean(storage: Storage, names: string[]) {
      await Promise.all(names.slice(0, ${limit}).map((name) => storage.removeNow(name)));
    }`;
  assert.equal(rule(lint(source('CLEANUP_BATCH_SIZE'), files), 'service-query-in-loop').length, 0);
  assert.equal(rule(lint(source('PAGE_SIZE'), files), 'service-query-in-loop').length, 1);
});

test('service-query-in-loop: a helper handed one `$in` chunk per iteration is already batched', () => {
  const files = {
    ...mongooseStub,
    'messages.ts': `import { Model } from 'mongoose';
      export class Messages {
        constructor(private model: Model<{ _id: string }>) {}
        async update(filter: object, values: object) { await this.model.updateMany(filter, values); }
      }`,
  };
  const source = (filter: string) => `import { Messages } from './messages';
    function chunkArray(ids: string[]): string[][] { return ids.map((id) => [id]); }
    export async function markRead(messages: Messages, ids: string[]) {
      for (const chunk of chunkArray(ids)) await messages.update(${filter}, { read: true });
    }`;
  assert.equal(rule(lint(source('{ _id: { $in: chunk }, seen: false }'), files), 'service-query-in-loop').length, 0);
  assert.equal(rule(lint(source('{ _id: chunk[0] }'), files), 'service-query-in-loop').length, 1);
});

test('service-query-in-loop: TypeORM In(chunk) in a nested relation filter is already batched', () => {
  const files = {
    'node_modules/typeorm/index.d.ts': `export class Repository<T> { find(options: object): Promise<T[]> }
      export declare function In<T>(values: T[]): object;`,
    'workflows.ts': `import { Repository } from 'typeorm';
      export class Workflows {
        constructor(private repo: Repository<{ id: string }>) {}
        async list(options: object) { return this.repo.find(options); }
      }`,
  };
  const source = (filter: string) => `import { In } from 'typeorm';
    import { Workflows } from './workflows';
    export async function load(workflows: Workflows, chunks: string[][], extra: object) {
      for (const chunk of chunks) await workflows.list({ where: { ...extra, parentFolder: { id: ${filter} } } });
    }`;
  assert.equal(rule(lint(source('In(chunk)'), files), 'service-query-in-loop').length, 0);
  assert.equal(rule(lint(source('chunk[0]'), files), 'service-query-in-loop').length, 1);
});

// TypeORM imported but not installed: only the declarations in the project say what the receiver
// is.
const untypedService = (call: string) => `import { Repository, DataSource } from 'typeorm';
  import { InjectRepository } from '@nestjs/typeorm';
  class Account {}
  export class SyncStatus {
    constructor(
      @InjectRepository(Account) private readonly accounts: Repository<Account>,
      private readonly cache: Map<string, Account>,
    ) {}
    async run(ids: string[]) {
      for (const id of ids) await ${call};
    }
  }`;

test('orm-query-in-loop: a Repository<> receiver is recognised when typeorm types are missing', () => {
  const findings = rule(lint(untypedService('this.accounts.findOne({ where: { id } })')), 'orm-query-in-loop');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /^TypeORM\.findOne\(\)/);
  assert.equal(rule(lint(untypedService('this.cache.get(id)')), 'orm-query-in-loop').length, 0);
});

test('orm-query-in-loop: a project repository extending a TypeORM fork is recognised from its heritage', () => {
  const source = `import { Repository } from '@n8n/typeorm';
    class Workflow {}
    export class WorkflowRepository extends Repository<Workflow> {
      async byIds(ids: string[]) {
        for (const id of ids) await this.findOne({ where: { id } });
      }
    }
    class Plain { findOne(options: object) { return options; } }
    export class Other extends Plain {
      async byIds(ids: string[]) {
        for (const id of ids) await this.findOne({ where: { id } });
      }
    }`;
  const findings = rule(lint(source), 'orm-query-in-loop');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 5);
});

test('orm-query-in-loop: @n8n/typeorm declarations count as TypeORM, @nestjs/typeorm does not', () => {
  const files = {
    'node_modules/@n8n/typeorm/index.d.ts':
      'export declare class Repository<T> { findOne(options: object): Promise<T | null> }',
    'node_modules/@nestjs/typeorm/index.d.ts':
      'export declare class Repository<T> { findOne(options: object): Promise<T | null> }',
  };
  const source = (from: string) => `import { Repository } from '${from}';
    export async function load(repo: Repository<{ id: string }>, ids: string[]) {
      for (const id of ids) await repo.findOne({ where: { id } });
    }`;
  assert.equal(rule(lint(source('@n8n/typeorm'), files), 'orm-query-in-loop').length, 1);
  assert.equal(rule(lint(source('@nestjs/typeorm'), files), 'orm-query-in-loop').length, 0);
});

test('service-query-in-loop: a helper over an untyped Repository<> counts as a TypeORM query', () => {
  const source = `import { Repository } from 'typeorm';
    class User {}
    export class Users {
      constructor(private readonly users: Repository<User>, private readonly names: Map<string, string>) {}
      async byId(id: string) { return this.users.findOne({ where: { id } }); }
      async nameOf(id: string) { return this.names.get(id); }
      async all(ids: string[]) {
        for (const id of ids) await this.byId(id);
        for (const id of ids) await this.nameOf(id);
      }
    }`;
  const findings = rule(lint(source), 'service-query-in-loop');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /users\.findOne/);
});

const mikroOrm = {
  'node_modules/@mikro-orm/core/index.d.ts': `export declare class EntityManager {
      findOne<T>(entityName: string, where: object): Promise<T | null>;
      find<T>(entityName: string, where: object): Promise<T[]>;
      getReference<T>(entityName: string, id: string): T;
    }`,
};

test('orm-query-in-loop: MikroORM EntityManager reads per item are reported', () => {
  const source = `import { EntityManager } from '@mikro-orm/core';
    export async function remove(manager: EntityManager, ids: string[], chunks: string[][]) {
      await Promise.all(ids.map(async (id) => manager.findOne('ProductCategory', { id })));
      for (const chunk of chunks) await manager.find('ProductCategory', { id: chunk });
      for (const id of ids) manager.getReference('ProductCategory', id);
    }`;
  const findings = rule(lint(source, mikroOrm), 'orm-query-in-loop');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.match(findings[0].message, /^MikroORM\.findOne\(\).*\{ id: ids \}/);
});

test('service-query-in-loop: a helper running a MikroORM read is a database call', () => {
  const files = {
    ...mikroOrm,
    'categories.ts': `import { EntityManager } from '@mikro-orm/core';
      export class Categories {
        constructor(private manager: EntityManager) {}
        async load(id: string) { return this.manager.findOne('ProductCategory', { id }); }
        reference(id: string) { return this.manager.getReference('ProductCategory', id); }
      }`,
  };
  const source = (method: string) => `import { Categories } from './categories';
    export async function all(categories: Categories, ids: string[]) {
      for (const id of ids) await categories.${method}(id);
    }`;
  assert.equal(rule(lint(source('load'), files), 'service-query-in-loop').length, 1);
  assert.equal(rule(lint(source('reference'), files), 'service-query-in-loop').length, 0);
});

const payload = {
  'node_modules/payload/index.d.ts': `export declare class BasePayload {
      findByID: (options: { collection: string; id: string }) => Promise<object>;
      find: (options: { collection: string; where?: object }) => Promise<object>;
    }
    export declare class Logger { find(name: string): object }
    export interface Payload extends BasePayload {}`,
};

test('orm-query-in-loop: Payload Local API reads per id are reported, a chunked `in` read is not', () => {
  const source = `import type { Payload } from 'payload';
    export async function parents(payload: Payload, ids: string[], chunks: string[][]) {
      for (const id of ids) await payload.findByID({ collection: 'folders', id });
      for (const chunk of chunks) await payload.find({ collection: 'folders', where: { id: { in: chunk } } });
    }`;
  const findings = rule(lint(source, payload), 'orm-query-in-loop');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.match(findings[0].message, /^Payload\.findByID\(\).*where: \{ id: \{ in: ids \} \}/);
});

test('service-query-in-loop: only BasePayload methods of the payload package are database calls', () => {
  const files = {
    ...payload,
    'folders.ts': `import { type Payload, Logger } from 'payload';
      export class Folders {
        constructor(private payload: Payload, private logger: Logger) {}
        async parent(id: string) { return this.payload.findByID({ collection: 'folders', id }); }
        async channel(name: string) { return this.logger.find(name); }
      }`,
  };
  const source = (method: string) => `import { Folders } from './folders';
    export async function all(folders: Folders, ids: string[]) {
      for (const id of ids) await folders.${method}(id);
    }`;
  const findings = rule(lint(source('parent'), files), 'service-query-in-loop');
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /where: \{ id: \{ in: ids \} \}/);
  assert.equal(rule(lint(source('channel'), files), 'service-query-in-loop').length, 0);
});

test('orm-query-in-loop: chunked In() counts, updates and spread or nested filters are already batched', () => {
  const files = {
    'node_modules/typeorm/index.d.ts': `export declare class Repository<T> {
        find(options: object): Promise<T[]>;
        count(options: object): Promise<number>;
        update(criteria: object, values: object): Promise<object>;
      }
      export declare function In<T>(values: T[]): object;`,
  };
  const source = (key: string) => `import { In, Repository } from 'typeorm';
    export async function archive(repo: Repository<{ id: string }>, chunks: string[][], all: string[], extra: object) {
      let total = 0;
      for (const chunk of chunks) {
        total += await repo.count({ where: { id: ${key}, isArchived: false } });
        await repo.update({ ...extra, parentFolder: { id: ${key} } }, { isArchived: true });
        await repo.find({ where: { ...extra, workflow: { parentFolder: ${key} } } });
        const options = { where: { id: ${key} } };
        await repo.find(options);
      }
      return total;
    }`;
  assert.equal(rule(lint(source('In(chunk)'), files), 'orm-query-in-loop').length, 0);
  assert.equal(rule(lint(source('In(all)'), files), 'orm-query-in-loop').length, 4);
});

import { scanWithFixes, requireFix } from './site-fix-helpers.js';
const typeormFixFiles = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
  findOne(options: object): Promise<T | null>;
  findOneBy(filter: object): Promise<T | null>;
  find(options?: object): Promise<T[]>;
}`,
};

function ormFixes(context: TestContext, source: string) {
  const { findings } = scanWithFixes(context, { ...typeormFixFiles, 'src/service.ts': source });
  return findings.filter((finding) => finding.ruleId === 'orm-query-in-loop');
}

test('orm-query-in-loop fix: Promise.all over per-id findOne becomes one find with In(ids) and a Map', (context) => {
  const findings = ormFixes(
    context,
    `import { Repository } from 'typeorm';
declare const categoryRepository: Repository<{ id: string }>;
export async function load(ids: string[]) {
  const categories = await Promise.all(ids.map(async (id) => categoryRepository.findOne({ where: { id }, relations: ['parent'] })));
  return categories;
}`,
  );
  assert.equal(findings.length, 1);
  // The import and the call are three lines apart, so they arrive as one change.
  const [change] = requireFix(findings[0]).changes;
  assert.equal(requireFix(findings[0]).changes.length, 1);
  assert.equal(
    change.after,
    `import { Repository, In } from 'typeorm';
declare const categoryRepository: Repository<{ id: string }>;
export async function load(ids: string[]) {
  const existingCategories = await categoryRepository.find({ where: { id: In(ids) }, relations: ['parent'] });
  const existingCategoriesById = new Map(existingCategories.map((category) => [category.id, category] as const));
  const categories = ids.map((id) => existingCategoriesById.get(id) ?? null);`,
  );
});

test('orm-query-in-loop fix: Promise.all reads with a computed key, a paged option or a non-array list stay', (context) => {
  const findings = ormFixes(
    context,
    `import { Repository } from 'typeorm';
declare const userRepository: Repository<{ id: string }>;
declare function keyOf(value: string): string;
export async function load(ids: string[], names: Set<string>) {
  const first = await Promise.all(ids.map((id) => userRepository.findOne({ where: { id: keyOf(id) } })));
  const second = await Promise.all(ids.map((id) => userRepository.findOne({ where: { id }, skip: 1 })));
  const third = await Promise.all([...names].map((id) => userRepository.findOneBy({ id })));
  return [first, second, third];
}`,
  );
  assert.equal(findings.length, 3);
  assert.deepEqual(
    findings.map((finding) => finding.fix),
    [undefined, undefined, undefined],
  );
});
