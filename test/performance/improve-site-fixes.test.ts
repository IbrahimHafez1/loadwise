import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import ts from 'typescript';
import { scanWithFixes, requireFix, requireOnlyChange } from './site-fix-helpers.js';
import { extractCodeFile } from '../../lib/performance/migrations/extract-code.js';
import { prepareDialect } from '../../lib/performance/migrations/extract-sql.js';
import { annotateUnit } from '../../lib/performance/migrations/operations.js';
import { checkPostgresUnit } from '../../lib/performance/migrations/rules-postgres.js';
import migrationBuilders from '../../lib/performance/site-fixes/migrations.js';
import type { Node, SourceFile } from 'typescript';

describe('queue-add-in-loop fix', () => {
  const queueFiles = {
    'node_modules/bullmq/index.d.ts': `export declare class Queue { add(name: string, data: any, opts?: any): Promise<{ id: string }>; addBulk(jobs: any[]): Promise<any[]>; }`,
  };

  function scan(context: TestContext, body: string, parameters = 'ids: string[]') {
    const source = `import { Queue } from 'bullmq';\nexport async function run(queue: Queue, ${parameters}) {\n${body}\n}\n`;
    return scanWithFixes(context, { ...queueFiles, 'src/app.ts': source }).findings.filter(
      (finding) => finding.ruleId === 'queue-add-in-loop',
    );
  }

  test('copies a Set, Map or generator through Array.from instead of calling .map on it', (context) => {
    const findings = scan(
      context,
      `  for (const id of ids) {
    await queue.add('set', { id });
  }
  for (const [key, value] of entries) {
    await queue.add('map', { key, value });
  }
  for (const id of generate()) {
    await queue.add('generated', { id });
  }`,
      'ids: Set<string>, entries: Map<string, number>, generate: () => Generator<string>',
    );
    assert.equal(findings.length, 3);
    assert.match(requireOnlyChange(findings[0]).after, /queue\.addBulk\(Array\.from\(ids, \(id\) => \(\{ name: 'set'/);
    assert.match(
      requireOnlyChange(findings[1]).after,
      /queue\.addBulk\(Array\.from\(entries, \(\[key, value\]\) => \(\{ name: 'map'/,
    );
    assert.match(requireOnlyChange(findings[2]).after, /queue\.addBulk\(Array\.from\(generate\(\), \(id\) =>/);
  });

  test('keeps .map for arrays and readonly arrays, and parenthesizes an awaited array', (context) => {
    const findings = scan(
      context,
      `  for (const id of ids) {
    await queue.add('array', { id });
  }
  for (const id of frozen) {
    await queue.add('readonly', { id });
  }
  for (const id of await load()) {
    await queue.add('loaded', { id });
  }`,
      'ids: string[], frozen: readonly string[], load: () => Promise<string[]>',
    );
    assert.equal(findings.length, 3);
    assert.match(requireOnlyChange(findings[0]).after, /queue\.addBulk\(ids\.map\(\(id\) =>/);
    assert.match(requireOnlyChange(findings[1]).after, /queue\.addBulk\(frozen\.map\(\(id\) =>/);
    assert.match(requireOnlyChange(findings[2]).after, /queue\.addBulk\(\(await load\(\)\)\.map\(\(id\) =>/);
  });

  test('offers no rewrite when the collection is typed any or unknown', (context) => {
    const findings = scan(
      context,
      `  for (const id of loose) {
    await queue.add('any', { id });
  }`,
      'loose: any',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fix, undefined);
  });

  test('carries comments in the loop body into the mapper', (context) => {
    const findings = scan(
      context,
      `  for (const id of ids) {
    // One job per id, retried by the worker.
    await queue.add('job', { id }); // ids are unique
  }
  let queued = 0;
  for (const id of ids) {
    // Normalized so the worker sees one spelling.
    const key = id.toLowerCase();
    await queue.add('job', { key });
    queued++;
  }`,
    );
    assert.equal(findings.length, 2);
    assert.equal(
      requireOnlyChange(findings[0]).after,
      [
        'await queue.addBulk(ids.map((id) => {',
        '  // One job per id, retried by the worker.',
        "  return { name: 'job', data: { id } }; // ids are unique",
        '}));',
      ].join('\n'),
    );
    assert.equal(
      requireOnlyChange(findings[1]).after,
      [
        'const jobs = ids.map((id) => {',
        '  // Normalized so the worker sees one spelling.',
        '  const key = id.toLowerCase();',
        "  return { name: 'job', data: { key } };",
        '});',
        'await queue.addBulk(jobs);',
        'queued += jobs.length;',
      ].join('\n'),
    );
  });

  test('still refuses comments it cannot carry: in the loop header, inside the add, or among the counters', (context) => {
    const findings = scan(
      context,
      `  let queued = 0;
  for (const id of /* all of them */ ids) {
    await queue.add('header', { id });
  }
  for (const id of ids) {
    await queue.add('call', /* payload */ { id });
  }
  for (const id of ids) {
    await queue.add('counter', { id });
    // counted for the log
    queued++;
  }`,
    );
    assert.equal(findings.length, 3);
    for (const finding of findings) assert.equal(finding.fix, undefined);
  });
});

describe('prisma-distinct-in-memory fix', () => {
  const prismaFiles = {
    'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
    'node_modules/.prisma/client/index.d.ts': `
  export interface UserDelegate {
    findMany(options?: object): Promise<{ id: number, tenantId: number }[]>;
    groupBy(options: object): Promise<object[]>;
  }
  export declare class PrismaClient { user: UserDelegate }`,
    'package.json': '{}',
  };

  function distinctFindings(context: TestContext, body: string) {
    const source = `import type { PrismaClient } from '@prisma/client';\nasync function run(db: PrismaClient, ids: number[]) {\n${body}\n}\n`;
    return scanWithFixes(context, { ...prismaFiles, 'main.ts': source }).findings.filter(
      (finding) => finding.ruleId === 'prisma-distinct-in-memory',
    );
  }

  test('keeps comments inside a kept option and withholds the fix when a dropped part holds one', (context) => {
    const [kept, dropped, between] = distinctFindings(
      context,
      `  await db.user.findMany({ where: { id: { in: ids } /* active only */ }, select: { tenantId: true }, distinct: ['tenantId'] });
  await db.user.findMany({ select: { tenantId: true /* the tenant */ }, distinct: ['tenantId'] });
  await db.user.findMany({
    // Tenants with at least one user.
    select: { tenantId: true },
    distinct: ['tenantId'],
  });`,
    );
    assert.match(
      requireOnlyChange(kept).after,
      /db\.user\.groupBy\(\{ by: \['tenantId'\], where: \{ id: \{ in: ids \} \/\* active only \*\/ \} \}\)/,
    );
    assert.equal(dropped.fix, undefined);
    assert.equal(between.fix, undefined);
  });
});

describe('typeorm-load-then-save fix', () => {
  const typeormFiles = {
    'node_modules/typeorm/index.d.ts': `export class Repository<T> {
  findOne(options: object): Promise<T | null>;
  save(entity: T): Promise<T>;
  update(criteria: object, values: object): Promise<{ affected?: number }>;
  increment(criteria: object, column: string, value: number): Promise<{ affected?: number }>;
}
export declare function Column(): PropertyDecorator;
export declare function Entity(): ClassDecorator;`,
  };
  const header = `import { Repository, Column, Entity } from 'typeorm';
@Entity()
class User {
  @Column() id!: number;
  @Column() lastLoginAt!: Date;
  @Column() tokenVersion!: number;
}
declare const users: Repository<User>;
declare const stamp: Date;
`;

  function loadThenSave(context: TestContext, body: string) {
    const { findings } = scanWithFixes(context, { ...typeormFiles, 'a.ts': header + body });
    return findings.filter((finding) => finding.ruleId === 'typeorm-load-then-save');
  }

  test('marks a split into several calls for review, since the single save was atomic', (context) => {
    const [finding] = loadThenSave(
      context,
      `export async function run(id: number) {
  const user = await users.findOne({ where: { id } });
  user.lastLoginAt = stamp;
  user.tokenVersion += 1;
  await users.save(user);
}`,
    );
    assert.equal(
      requireOnlyChange(finding).after,
      "await users.increment({ id }, 'tokenVersion', 1);\nawait users.update({ id }, { lastLoginAt: stamp });",
    );
    assert.equal(requireFix(finding).requiresReview, true);
    const { note } = requireFix(finding);
    assert.ok(note);
    assert.match(note, /no longer atomic/);
  });

  test('a single generated call is a reviewed fix because update() skips entity hooks', (context) => {
    const [finding] = loadThenSave(
      context,
      `export async function run(id: number) {
  const user = await users.findOne({ where: { id } });
  user.lastLoginAt = stamp;
  await users.save(user);
}`,
    );
    assert.equal(requireOnlyChange(finding).after, 'await users.update({ id }, { lastLoginAt: stamp });');
    assert.equal(requireFix(finding).requiresReview, true);
  });
});

describe('migration fixes in code', () => {
  before(() => prepareDialect('postgres'));

  function checkCode(text: string, file = 'migration.ts') {
    const { framework, units } = extractCodeFile(text, { file, dialect: 'postgres' });
    return units.flatMap((unit) => {
      annotateUnit(unit.operations, { inTransaction: unit.inTransaction, dialect: 'postgres' });
      return checkPostgresUnit({ file, framework, dialect: 'postgres', operations: unit.operations });
    });
  }

  function nodeAt(sourceFile: SourceFile, line: number, column: number) {
    const offset = sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1);
    let found: Node | undefined;
    (function visit(node: Node): void {
      if (node.getStart(sourceFile) <= offset && offset < node.end) {
        found = node;
        ts.forEachChild(node, visit);
      }
    })(sourceFile);
    return found;
  }

  function buildFor(code: string, ruleId: keyof typeof migrationBuilders) {
    const finding = checkCode(code).find((candidate) => candidate.ruleId === ruleId);
    assert.ok(finding, `expected ${ruleId}`);
    const sourceFile = ts.createSourceFile(finding.file, code, ts.ScriptTarget.Latest, true);
    const node = nodeAt(sourceFile, finding.line, finding.column);
    return migrationBuilders[ruleId]({ finding, node, sourceFile, text: code, load: () => null });
  }

  function noteFor(code: string, ruleId: keyof typeof migrationBuilders): string {
    const note = buildFor(code, ruleId)?.note;
    assert.ok(note);
    return note;
  }

  function typeormMigration(query: string): string {
    return `import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderIndex1700000000000 implements MigrationInterface {
  name = 'AddOrderIndex1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(${query});
  }

  public async down(queryRunner: QueryRunner): Promise<void> {}
}
`;
  }

  test('withholds a rewrite that would turn an escaped \\${ in the template into a live hole', () => {
    const escaped = typeormMigration(
      '`CREATE INDEX "orders_note_idx" ON "orders" ("note") WHERE "note" <> \'\\${draft}\'`',
    );
    assert.equal(buildFor(escaped, 'migration-index-not-concurrent'), undefined);
    const hole = typeormMigration('`CREATE INDEX "orders_note_idx" ON "${table}" ("note")`');
    assert.ok(buildFor(hole, 'migration-index-not-concurrent'), 'a real hole still gets the fix');
  });

  test('notes that a statement moved after later statements of its query string may break them', () => {
    const later = typeormMigration(
      '`CREATE INDEX "orders_store_idx" ON "orders" ("store_id"); COMMENT ON INDEX "orders_store_idx" IS \'by store\'`',
    );
    assert.match(noteFor(later, 'migration-index-not-concurrent'), /later statements/);
    const last = typeormMigration(
      '`ALTER TABLE "orders" ADD COLUMN "x" int; CREATE INDEX "orders_store_idx" ON "orders" ("store_id")`',
    );
    assert.doesNotMatch(noteFor(last, 'migration-index-not-concurrent'), /later statements/);
  });
});
