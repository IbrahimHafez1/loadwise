'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { lint } = require('./helpers.cjs');

const files = {
  'globals.d.ts': 'declare function fetch(url: string): Promise<{ ok: boolean }>;',
  'node_modules/typeorm/index.d.ts': `
    export class EntityManager { query(sql: string): Promise<unknown>; transaction<T>(run: (manager: EntityManager) => Promise<T>): Promise<T> }
    export class DataSource extends EntityManager {}
  `,
  'node_modules/@prisma/client/index.d.ts': `
    export class PrismaClient { user: { create(input: object): Promise<unknown> };
      $transaction<T>(run: (tx: PrismaClient) => Promise<T>): Promise<T> }
  `,
  'node_modules/axios/index.d.ts': `
    declare const axios: { post(url: string, body?: unknown): Promise<unknown> };
    export default axios;
  `,
  'node_modules/@types/node/index.d.ts': `
    declare module 'fs/promises' {
      export function writeFile(path: string, data: string): Promise<void>;
      export function readFile(path: string): Promise<string>;
    }
  `,
};

function check(source) {
  return lint(["import '@types/node';", source].join('\n'), files).filter(
    (finding) => finding.ruleId === 'external-call-in-transaction',
  );
}

test('reports fetch, axios and file writes awaited inside transaction callbacks', () => {
  const findings = check(
    [
      "import { DataSource } from 'typeorm';",
      "import { PrismaClient } from '@prisma/client';",
      "import axios from 'axios';",
      "import { writeFile } from 'fs/promises';",
      'declare const dataSource: DataSource; declare const prisma: PrismaClient;',
      'export async function run() {',
      '  await dataSource.transaction(async (manager) => {',
      "    await manager.query('select 1');",
      "    await fetch('https://example.test');",
      '  });',
      '  await prisma.$transaction(async (tx) => {',
      "    await axios.post('https://example.test');",
      "    await writeFile('a.txt', 'x');",
      '  });',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 3);
});

test('reports a project method that reaches the call through two project hops', () => {
  const findings = check(
    [
      "import { DataSource } from 'typeorm';",
      'class Storage {',
      '  async store() { return this.upload(); }',
      "  private async upload() { return await fetch('https://example.test'); }",
      '}',
      'class Service {',
      '  constructor(private readonly dataSource: DataSource, private readonly storage: Storage) {}',
      '  async save() {',
      '    return this.dataSource.transaction(async (manager) => {',
      '      return await this.storage.store();',
      '    });',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /store\(\)/);
});

test('skips calls outside transactions, unawaited reads, and calls that receive the transaction client', () => {
  const findings = check(
    [
      "import { DataSource } from 'typeorm';",
      "import { readFile } from 'fs/promises';",
      'declare const dataSource: DataSource;',
      'async function helper(manager: unknown) { return await fetch("https://example.test"); }',
      'export async function run() {',
      "  await fetch('https://example.test');",
      '  await dataSource.transaction(async (manager) => {',
      "    await readFile('a.txt');",
      '    await helper(manager);',
      '  });',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 0);
});

const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const fixHeader = ["import { DataSource } from 'typeorm';", 'declare const dataSource: DataSource;'];

function fixFor(context, bodyLines, extraLines = []) {
  const source = [...fixHeader, ...extraLines, 'export async function run(id: number) {', ...bodyLines, '}'].join('\n');
  const { findings } = scanWithFixes(context, {
    'globals.d.ts': files['globals.d.ts'],
    'node_modules/typeorm/index.d.ts': files['node_modules/typeorm/index.d.ts'],
    'a.ts': source,
  });
  return findings.filter((finding) => finding.ruleId === 'external-call-in-transaction');
}

test('moves a plain awaited call to after the transaction', (context) => {
  const [finding] = fixFor(context, [
    '  await dataSource.transaction(async (manager) => {',
    "    await manager.query('select 1');",
    '    await fetch(String(id));',
    '  });',
  ]);
  assert.match(finding.fix.note, /after the transaction commits/);
  assert.equal(finding.fix.requiresReview, true);
  assert.equal(onlyChange(finding).after, ['});', 'await fetch(String(id));'].join('\n'));
});

test('offers no fix when the call is not safe to move', (context) => {
  const cases = {
    'uses a callback local': [
      '  await dataSource.transaction(async (manager) => {',
      '    const key = String(id);',
      '    await fetch(key);',
      '  });',
    ],
    'result is used': [
      '  await dataSource.transaction(async (manager) => {',
      "    await manager.query('select 1 for update');",
      "    const ok = await fetch('https://example.test');",
      '    await manager.query(String(ok));',
      '  });',
    ],
    'inside an if': [
      '  await dataSource.transaction(async (manager) => {',
      '    if (id) {',
      '      await fetch(String(id));',
      '    }',
      '  });',
    ],
    'inside a loop': [
      '  await dataSource.transaction(async (manager) => {',
      '    for (const step of [1]) {',
      '      await fetch(String(id));',
      '    }',
      '  });',
    ],
    'inside a try': [
      '  await dataSource.transaction(async (manager) => {',
      '    try {',
      '      await fetch(String(id));',
      '    } catch {}',
      '  });',
    ],
    'later statement mentions its argument': [
      '  await dataSource.transaction(async (manager) => {',
      "    await manager.query('select 1 for update');",
      '    await fetch(String(id));',
      '    await manager.query(String(id));',
      '  });',
    ],
    'later statement calls something else': [
      '  await dataSource.transaction(async (manager) => {',
      "    await manager.query('select 1 for update');",
      '    await fetch(String(id));',
      "    await fetch('https://example.test');",
      '  });',
    ],
  };
  for (const [name, body] of Object.entries(cases)) {
    const findings = fixFor(context, body);
    assert.ok(findings.length >= 1, name);
    assert.equal(findings[0].fix, undefined, name);
  }
});

test('moves a first-step call before the transaction, keeping its result for the callback', (context) => {
  const [finding] = fixFor(context, [
    '  await dataSource.transaction(async (manager) => {',
    '    const limit = 5;',
    '    const response = await fetch(',
    '      String(id),',
    '    );',
    '    await manager.query(String(response), [limit]);',
    '  });',
  ]);
  assert.match(finding.fix.note, /just before the transaction opens/);
  assert.equal(finding.fix.requiresReview, true);
  assert.deepEqual(onlyChange(finding), {
    before: [
      'await dataSource.transaction(async (manager) => {',
      '  const limit = 5;',
      '  const response = await fetch(',
      '    String(id),',
      '  );',
    ].join('\n'),
    after: [
      'const response = await fetch(',
      '  String(id),',
      ');',
      'await dataSource.transaction(async (manager) => {',
      '  const limit = 5;',
    ].join('\n'),
  });
});

test('fix --yes leaves both sides of a transaction boundary intact', (context) => {
  const source = [
    ...fixHeader,
    'export async function notify(endpoint: string) {',
    '  await dataSource.transaction(async (manager) => {',
    '    await fetch(endpoint);',
    "    await manager.query('select 1');",
    '  });',
    '  await dataSource.transaction(async (manager) => {',
    "    await manager.query('insert into notices default values');",
    '    await fetch(endpoint);',
    '  });',
    '}',
  ].join('\n');
  const { root } = scanWithFixes(context, {
    'a.ts': source,
    'globals.d.ts': files['globals.d.ts'],
    'node_modules/typeorm/index.d.ts': files['node_modules/typeorm/index.d.ts'],
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', types: [] }, include: ['*.ts'] }),
  });
  const cli = path.join(__dirname, '../../bin/loadwise.cjs');
  const result = spawnSync(process.execPath, [cli, 'fix', '--yes'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 automatic fix\(es\) in 0 file\(s\), 0 manual, 2 requiring individual review/);
  assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), source);
});

test('keeps a first-step call in place when the outer function already uses its name or reads a callback value', (context) => {
  const clash = fixFor(context, [
    '  const response = 1;',
    '  await dataSource.transaction(async (manager) => {',
    '    const response = await fetch(String(id));',
    '    await manager.query(String(response));',
    '  });',
    '  return response;',
  ]);
  assert.equal(clash[0].fix, undefined);
  const local = fixFor(context, [
    '  await dataSource.transaction(async (manager) => {',
    '    const url = String(id);',
    '    const response = await fetch(url);',
    '    await manager.query(String(response));',
    '  });',
  ]);
  assert.equal(local[0].fix, undefined);
});

test('offers no fix when the call is reached through a helper', (context) => {
  const findings = fixFor(
    context,
    [
      '  await dataSource.transaction(async (manager) => {',
      "    await manager.query('select 1 for update');",
      '    await send();',
      '  });',
    ],
    ["async function send() { await fetch('https://example.test'); }"],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fix, undefined);
});

const hashingAndRepositoryFiles = {
  ...files,
  'node_modules/@types/bcrypt/index.d.ts': `
    export function hash(data: string, rounds: number): Promise<string>;
    export function compare(data: string, encrypted: string): Promise<boolean>;
  `,
  'node_modules/typeorm/repository.d.ts': `
    export class Repository<T> {
      save(entity: T): Promise<T>;
      findOne(options: object): Promise<T | null>;
      increment(where: object, column: string, by: number): Promise<unknown>;
      query(sql: string, parameters?: unknown[]): Promise<unknown>;
    }
    export class QueryRunner {
      manager: { save<T>(entity: T): Promise<T> };
      startTransaction(): Promise<void>;
      commitTransaction(): Promise<void>;
      rollbackTransaction(): Promise<void>;
      release(): Promise<void>;
    }
  `,
};

function findingsFor(source, ruleId) {
  return lint(["import '@types/node';", source].join('\n'), hashingAndRepositoryFiles).filter(
    (finding) => finding.ruleId === ruleId,
  );
}

test('reports password hashing awaited inside a transaction callback', () => {
  const findings = findingsFor(
    [
      "import { DataSource } from 'typeorm';",
      "import * as bcrypt from 'bcrypt';",
      'declare const dataSource: DataSource;',
      'export async function register(password: string) {',
      '  const early = await bcrypt.hash(password, 12);',
      '  await dataSource.transaction(async (manager) => {',
      '    const late = await bcrypt.hash(password, 12);',
      "    await manager.query('insert ' + early + late);",
      '  });',
      '}',
    ].join('\n'),
    'external-call-in-transaction',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 8);
  assert.match(findings[0].message, /^Awaiting `bcrypt hash` .*password hash/);
});

test('classifies password hashing behind a project helper as CPU work, not an external call', () => {
  const findings = findingsFor(
    [
      "import { DataSource } from 'typeorm';",
      "import * as bcrypt from 'bcrypt';",
      'declare const dataSource: DataSource;',
      'const verifyCode = (code: string, stored: string) => bcrypt.compare(code, stored);',
      'export async function unlock(code: string, stored: string) {',
      '  await dataSource.transaction(async () => {',
      '    await verifyCode(code, stored);',
      '  });',
      '}',
    ].join('\n'),
    'external-call-in-transaction',
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /password hash/);
  assert.doesNotMatch(findings[0].message, /external call/);
});

const escapeHeader = [
  "import { DataSource } from 'typeorm';",
  "import { Repository, QueryRunner } from 'typeorm/repository';",
  'class Usage { count = 0 }',
  'class UsageService {',
  '  constructor(private readonly usage: Repository<Usage>) {}',
  '  async bump(id: string) { await this.usage.increment({ id }, "count", 1); }',
  '  async bumpWith(id: string, repository: Repository<Usage>) { await repository.increment({ id }, "count", 1); }',
  '  async read(id: string) { return this.usage.findOne({ where: { id } }); }',
  '}',
];

test('reports TypeORM writes through injected repositories inside a transaction', () => {
  const findings = findingsFor(
    [
      ...escapeHeader,
      'class Service {',
      '  constructor(private readonly dataSource: DataSource, private readonly usage: Repository<Usage>,',
      '    private readonly usageService: UsageService) {}',
      '  async run(item: Usage) {',
      '    await this.dataSource.transaction(async (manager) => {',
      '      await this.usage.save(item);',
      '      await this.usageService.bump("a");',
      "      await this.usage.query('UPDATE usage SET count = count + 1');",
      '    });',
      '  }',
      '}',
    ].join('\n'),
    'typeorm-transaction-client-escape',
  );
  assert.deepEqual(
    findings.map((finding) => finding.line),
    [16, 17, 18],
  );
  assert.match(findings[0].message, /`manager\.getRepository\(Entity\)`/);
  assert.match(findings[1].message, /which reaches `this\.usage\.increment\(\)` through `bump\(\)`/);
});

test('reports injected repository writes between QueryRunner startTransaction and commitTransaction', () => {
  const findings = findingsFor(
    [
      ...escapeHeader,
      'class Service {',
      '  constructor(private readonly usage: Repository<Usage>) {}',
      '  async run(runner: QueryRunner, item: Usage) {',
      '    await this.usage.save(item);',
      '    await runner.startTransaction();',
      '    try {',
      '      await runner.manager.save(item);',
      '      await this.usage.save(item);',
      '      await runner.commitTransaction();',
      '    } catch (error) {',
      '      await runner.rollbackTransaction();',
      '      await this.usage.save(item);',
      '    } finally {',
      '      await runner.release();',
      '    }',
      '    await this.usage.save(item);',
      '  }',
      '}',
    ].join('\n'),
    'typeorm-transaction-client-escape',
  );
  assert.deepEqual(
    findings.map((finding) => finding.line),
    [18],
  );
  assert.match(findings[0].message, /`runner\.manager`/);
});

test('skips transaction-bound repositories, reads, and helpers handed the manager', () => {
  const findings = findingsFor(
    [
      ...escapeHeader,
      'class Service {',
      '  constructor(private readonly dataSource: DataSource, private readonly usageService: UsageService) {}',
      '  async run(item: Usage) {',
      '    await this.dataSource.transaction(async (manager) => {',
      '      const repository = (manager as any).getRepository(Usage) as Repository<Usage>;',
      '      await repository.save(item);',
      '      await this.usageService.read("a");',
      '      await this.usageService.bumpWith("a", (manager as any).getRepository(Usage));',
      '    });',
      '  }',
      '}',
    ].join('\n'),
    'typeorm-transaction-client-escape',
  );
  assert.equal(findings.length, 0);
});
