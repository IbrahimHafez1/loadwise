import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';

const packages = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
      findOne(options: object): Promise<T | null>;
      save(entity: T): Promise<T>;
    }`,
  'node_modules/bcrypt/index.d.ts': `export function hashSync(data: string, rounds: number): string;`,
};
const layers = `import { Repository } from 'typeorm';
  export class UserRepository {
    constructor(private users: Repository<{ id: string }>) {}
    async load(id: string) { return this.users.findOne({ where: { id } }); }
  }
  export class UserService {
    constructor(private repository: UserRepository) {}
    async fetch(id: string) { return this.repository.load(id); }
    async fetchAll(id: string) {
      const user = await this.fetch(id);
      return user;
    }
  }`;
const hashing = `import { hashSync } from 'bcrypt';
  export function digest(value: string) { return hashSync(value, 10); }
  export function prepare(value: string) { return digest(value); }
  export function prepareDeep(value: string) { return prepare(value); }`;

function findingsFor(ruleId: string, source: string) {
  return lint(source, { ...packages, 'layers.ts': layers, 'hashing.ts': hashing }).filter(
    (finding: Finding) => finding.ruleId === ruleId,
  );
}

test('service-query-in-loop follows a query through service and repository methods and names the path', () => {
  const findings = findingsFor(
    'service-query-in-loop',
    `import { UserService } from './layers';
export async function run(service: UserService, ids: string[]) {
  for (const id of ids) await service.fetchAll(id);
}`,
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /reached through `UserService\.fetch` -> `UserRepository\.load`/);
  assert.ok(findings[0].contextualReason);
});

test('service-query-in-loop keeps the plain message for a query one hop away', () => {
  const findings = findingsFor(
    'service-query-in-loop',
    `import { UserRepository } from './layers';
export async function run(repository: UserRepository, ids: string[]) {
  for (const id of ids) await repository.load(id);
}`,
  );
  assert.equal(findings.length, 1);
  assert.doesNotMatch(findings[0].message, /reached through/);
  assert.equal(findings[0].contextualReason, undefined);
});

test('password-hash-sync-in-async reports a request-path call that reaches a sync hash through helpers', () => {
  const findings = findingsFor(
    'password-hash-sync-in-async',
    `import { prepare } from './hashing';
export async function register(req: { body: { password: string } }) {
  return prepare(req.body.password);
}`,
  );
  assert.equal(findings.length, 1);
  assert.match(
    findings[0].message,
    /`prepare\(\)` runs on a request path and reaches `hashSync` through `prepare` -> `digest`/,
  );
  assert.equal(findings[0].contextualReason, undefined);
});

test('password-hash-sync-in-async makes a hash three helpers down contextual', () => {
  const findings = findingsFor(
    'password-hash-sync-in-async',
    `import { prepareDeep } from './hashing';
export async function register(req: { body: { password: string } }) {
  return prepareDeep(req.body.password);
}`,
  );
  assert.equal(findings.length, 1);
  assert.ok(findings[0].contextualReason);
});
