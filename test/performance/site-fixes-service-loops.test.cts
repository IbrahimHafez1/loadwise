import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { scanWithFixes, dedent } from './site-fix-helpers.cjs';
import type { Finding, FixChange } from '../../lib/shared/types.cjs';
import { noteOf, fixOf, requireText } from '../types/finding-fix.cjs';
import type { FileMap } from '../types/project-files.cjs';
import type { FixSides } from '../types/site-fixes.cjs';

const RULE_ID = 'service-query-in-loop';
const packages = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
      find(options: object): Promise<T[]>;
      findOne(options: object): Promise<T | null>;
      save(entity: T | T[]): Promise<T>;
      create(entity: object): T;
      update(where: object, values: object): Promise<{ affected?: number }>;
    }
    export declare function In<T>(values: T[]): T;`,
  'node_modules/ioredis/index.d.ts': 'export default class Redis { del(key: string): Promise<number> }',
  'node_modules/@prisma/client/index.d.ts': `
    export interface LogDelegate {
      create(input: object): Promise<{ id: number }>;
      createMany(input: object): Promise<{ count: number }>;
    }
    export class PrismaClient { log: LogDelegate }`,
};

function scan(context: TestContext, files: FileMap) {
  const { findings } = scanWithFixes(context, { ...packages, ...files });
  return findings.filter((finding) => finding.ruleId === RULE_ID);
}

// Each change of a fix keyed by the file's base name, with indentation removed.
function changesByFile(finding: Finding) {
  const changes: Record<string, FixSides[]> = {};
  for (const change of fixOf(finding).changes) {
    const name = change.file.split(/[\\/]/).at(-1) ?? change.file;
    changes[name] = [...(changes[name] ?? []), { before: dedent(change.before), after: dedent(change.after) }];
  }
  return changes;
}

const lookupService = `import { Repository } from 'typeorm';
export class LookupService {
  constructor(private grades: Repository<{ id: string; stageId: string; schoolId: string }>, private tenant: { schoolId(): string }) {}

  async gradeIdsByStage(stageId: string): Promise<string[]> {
    const schoolId = this.tenant.schoolId();
    const rows = await this.grades.find({ where: { schoolId, stageId }, select: ['id'] });
    return rows.map((row) => row.id);
  }

  async findGrade(id: string) {
    return this.grades.findOne({ where: { id } });
  }
}
`;

test('Promise.all over a keyed list read becomes one batch read added next to the helper', (context) => {
  const [finding, ...rest] = scan(context, {
    'lookup.ts': lookupService,
    'main.ts': `import { LookupService } from './lookup.js';
export class Curriculum {
  constructor(private lookup: LookupService) {}
  async allowed(stageIds: string[]) {
    const lists = await Promise.all(stageIds.map((stageId) => this.lookup.gradeIdsByStage(stageId)));
    return lists.flat();
  }
}
`,
  });
  assert.equal(rest.length, 0);
  const changes = changesByFile(finding);
  assert.deepEqual(changes['main.ts'], [
    {
      before: 'const lists = await Promise.all(stageIds.map((stageId) => this.lookup.gradeIdsByStage(stageId)));',
      after: 'const lists = await this.lookup.gradeIdsByStageMany(stageIds);',
    },
  ]);
  assert.deepEqual(changes['lookup.ts'], [
    { before: "import { Repository } from 'typeorm';", after: "import { Repository, In } from 'typeorm';" },
    {
      before: '}',
      after: [
        '}',
        '',
        'async gradeIdsByStageMany(stageIds: string[]): Promise<string[][]> {',
        '  if (!stageIds.length) return [];',
        '  const schoolId = this.tenant.schoolId();',
        "  const batchRows = await this.grades.find({ where: { schoolId, stageId: In(stageIds) }, select: ['id', 'stageId'] });",
        '  return stageIds.map((stageId) => {',
        '    const rows = batchRows.filter((batchRow) => batchRow.stageId === stageId);',
        '    return rows.map((row) => row.id);',
        '  });',
        '}',
      ].join('\n'),
    },
  ]);
  assert.match(noteOf(finding), /matched back with === on `stageId`.*also select `stageId`.*once per batch/s);
});

test('a single-row read inside a for-of loop is prefetched before the loop and looked up per item', (context) => {
  const [finding] = scan(context, {
    'lookup.ts': lookupService,
    'main.ts': `import { LookupService } from './lookup.js';
export class Report {
  constructor(private lookup: LookupService) {}
  async names(items: { gradeId: string }[]) {
    const names: string[] = [];
    for (const item of items) {
      const grade = await this.lookup.findGrade(item.gradeId);
      if (grade) names.push(grade.id);
    }
    return names;
  }
}
`,
  });
  const changes = changesByFile(finding);
  assert.deepEqual(changes['main.ts'], [
    {
      before: ['for (const item of items) {', '  const grade = await this.lookup.findGrade(item.gradeId);'].join('\n'),
      after: [
        'const ids = items.map((item) => item.gradeId);',
        'const findGradeByKey = new Map((await this.lookup.findGradeMany(ids)).map((result, index) => [ids[index], result]));',
        'for (const item of items) {',
        '  const grade = findGradeByKey.get(item.gradeId) ?? null;',
      ].join('\n'),
    },
  ]);
  assert.match(
    changes['lookup.ts'][1].after,
    /const rowsById = new Map\(rows\.map\(\(row\) => \[row\.id, row\] as const\)\.reverse\(\)\);\n\s*return ids\.map\(\(id\) => rowsById\.get\(id\) \?\? null\);/,
  );
  assert.match(noteOf(finding), /read before the loop/);
});

test('a loop that only awaits a single-insert helper calls a createMany sibling once', (context) => {
  const [finding] = scan(context, {
    'audit.ts': `import { PrismaClient } from '@prisma/client';
export interface Entry { action: string }
export class AuditService {
  constructor(private prisma: PrismaClient) {}

  async log(entry: Entry): Promise<void> {
    await this.prisma.log.create({ data: { action: entry.action } });
  }
}
`,
    'main.ts': `import { AuditService, Entry } from './audit.js';
export class Worker {
  constructor(private audit: AuditService) {}
  async record(entries: Entry[]) {
    for (const entry of entries) {
      await this.audit.log(entry);
    }
  }
}
`,
  });
  const changes = changesByFile(finding);
  assert.deepEqual(changes['main.ts'], [
    {
      before: ['for (const entry of entries) {', '  await this.audit.log(entry);', '}'].join('\n'),
      after: 'await this.audit.logMany(entries);',
    },
  ]);
  assert.deepEqual(changes['audit.ts'], [
    {
      before: '}',
      after: [
        '}',
        '',
        'async logMany(entries: Entry[]): Promise<void> {',
        '  if (!entries.length) return;',
        '  await this.prisma.log.createMany({ data: entries.map((entry) => ({ action: entry.action })) });',
        '}',
      ].join('\n'),
    },
  ]);
  assert.match(noteOf(finding), /all-or-nothing/);
});

test('a loop over a cache-only helper runs a few calls at a time and says it does not cut queries', (context) => {
  const [finding] = scan(context, {
    'cache.ts': `import Redis from 'ioredis';
export class CacheService {
  constructor(private redis: Redis) {}
  async invalidate(key: string) { await this.redis.del(key); }
}
`,
    'main.ts': `import { CacheService } from './cache.js';
export class Invalidator {
  constructor(private cache: CacheService) {}
  async run(keys: string[]) {
    for (const key of keys) {
      await this.cache.invalidate(key);
    }
  }
}
`,
  });
  assert.equal(fixOf(finding).changes.length, 1);
  assert.equal(
    dedent(fixOf(finding).changes[0].after),
    [
      'const concurrentCalls = 5;',
      'const pendingItems = Array.from(keys);',
      'for (let start = 0; start < pendingItems.length; start += concurrentCalls) {',
      '  await Promise.all(pendingItems.slice(start, start + concurrentCalls).map((key) => this.cache.invalidate(key)));',
      '}',
    ].join('\n'),
  );
  assert.match(noteOf(finding), /does not cut the number of queries/);
});

test('helpers whose result steers the loop, and database helpers that cannot batch, get no fix', (context) => {
  const findings = scan(context, {
    'offers.ts': `import { Repository } from 'typeorm';
export class OfferService {
  constructor(private offers: Repository<{ id: string; status: string }>) {}
  async close(id: string): Promise<boolean> {
    const result = await this.offers.update({ id, status: 'open' }, { status: 'closed' });
    return !!result.affected;
  }
}
`,
    'main.ts': `import { OfferService } from './offers.js';
export class Expirer {
  constructor(private offers: OfferService) {}
  async run(ids: string[]) {
    let closed = 0;
    for (const id of ids) {
      if (await this.offers.close(id)) closed++;
    }
    for (const id of ids) {
      await this.offers.close(id);
    }
    return closed;
  }
}
`,
  });
  assert.equal(findings.length, 2);
  for (const finding of findings) assert.equal(finding.fix, undefined);
});

const auditWithVariants = (variants: string) => `import { PrismaClient } from '@prisma/client';
export interface Entry { action: string }
function toRow(entry: Entry) {
  return { action: entry.action };
}
function toRowAt(entry: Entry, index = 0) {
  return { action: entry.action + index };
}
export class AuditService {
  constructor(private prisma: PrismaClient) {}

  async log(client: PrismaClient, entry: Entry): Promise<void> {
    await client.log.create({ data: toRow(entry) });
  }
${variants}}
`;
const auditCaller = `import { PrismaClient } from '@prisma/client';
import { AuditService, Entry } from './audit.js';
export class Worker {
  constructor(private audit: AuditService, private prisma: PrismaClient) {}
  async record(entries: Entry[]) {
    for (const entry of entries) {
      await this.audit.log(this.prisma, entry);
    }
  }
}
`;

test("the helper's own array variant doing the same write is called instead of adding a sibling", (context) => {
  const [finding] = scan(context, {
    'audit.ts': auditWithVariants(`
  async writeAll(db: PrismaClient, rows: readonly Entry[]): Promise<void> {
    if (rows.length === 0) return;
    await db.log.createMany({ data: rows.map(toRow) });
  }
`),
    'main.ts': auditCaller,
  });
  assert.deepEqual(changesByFile(finding), {
    'main.ts': [
      {
        before: ['for (const entry of entries) {', '  await this.audit.log(this.prisma, entry);', '}'].join('\n'),
        after: 'await this.audit.writeAll(this.prisma, entries);',
      },
    ],
  });
  assert.match(noteOf(finding), /^Calls the existing writeAll\(\)/);
});

test('an array variant that maps with extra arguments, catches errors or is private is not taken as the same write', (context) => {
  for (const variant of [
    'async writeAll(db: PrismaClient, rows: Entry[]) { await db.log.createMany({ data: rows.map(toRowAt) }); }',
    'async writeAll(db: PrismaClient, rows: Entry[]) { await db.log.createMany({ data: rows.map(toRow) }).catch(() => undefined); }',
    'async writeAll(db: PrismaClient, rows: Entry[]) { await db.log.createMany({ data: rows.map(toRow) }); await db.log.createMany({ data: [] }); }',
  ]) {
    const [finding] = scan(context, { 'audit.ts': auditWithVariants(`\n  ${variant}\n`), 'main.ts': auditCaller });
    assert.match(changesByFile(finding)['main.ts'][0].after, /this\.audit\.logMany\(this\.prisma, entries\)/);
  }
  const [hidden] = scan(context, {
    'audit.ts': auditWithVariants(
      '\n  private async writeAll(db: PrismaClient, rows: Entry[]) { await db.log.createMany({ data: rows.map(toRow) }); }\n',
    ),
    'main.ts': auditCaller,
  });
  assert.equal(hidden.fix, undefined);
});

test('a batch sibling an earlier fix added is reused, and a different method with its name blocks the fix', (context) => {
  const [first] = scan(context, { 'audit.ts': auditWithVariants(''), 'main.ts': auditCaller });
  const inserted = requireText(
    fixOf(first).changes.find((change: FixChange) => change.file.endsWith('audit.ts'))?.after,
  );
  // Two loops calling the helper get the same insertion, so applying both fixes adds the sibling
  // once.
  const twoLoops = scan(context, {
    'audit.ts': auditWithVariants(''),
    'main.ts': auditCaller.replace(
      '  async record(',
      '  async other(entries: Entry[]) {\n    for (const entry of entries) {\n      await this.audit.log(this.prisma, entry);\n    }\n  }\n  async record(',
    ),
  });
  assert.equal(twoLoops.length, 2);
  for (const finding of twoLoops)
    assert.equal(fixOf(finding).changes.find((change: FixChange) => change.file.endsWith('audit.ts'))?.after, inserted);
  // After applying, a new scan of a CRLF copy finds the sibling and only rewrites the call site.
  const applied = auditWithVariants(inserted.split('\n').slice(2).join('\n') + '\n');
  const [reused] = scan(context, { 'audit.ts': applied.replaceAll('\n', '\r\n'), 'main.ts': auditCaller });
  assert.deepEqual(Object.keys(changesByFile(reused)), ['main.ts']);
  assert.match(noteOf(reused), /^Calls the existing logMany\(\)/);
  const [blocked] = scan(context, {
    'audit.ts': auditWithVariants('\n  async logMany(entries: Entry[]): Promise<number> { return entries.length; }\n'),
    'main.ts': auditCaller,
  });
  assert.equal(blocked.fix, undefined);
});

test('an exported lookup function in another file gets a batch sibling the call site imports', (context) => {
  const prismaLookup = `import { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
export async function findEntry(id: number) {
  return prisma.entry.findUnique({ where: { id } });
}
`;
  const files = {
    'node_modules/@prisma/client/index.d.ts': `export interface EntryDelegate {
      findUnique(input: object): Promise<{ id: number } | null>;
      findMany(input: object): Promise<{ id: number }[]>;
    }
    export class PrismaClient { entry: EntryDelegate }`,
    'lookup.ts': prismaLookup,
  };
  const [finding] = scan(context, {
    ...files,
    'main.ts': `import { findEntry } from './lookup';
export async function load(ids: number[]) {
  return Promise.all(ids.map((id) => findEntry(id)));
}
`,
  });
  const changes = changesByFile(finding);
  assert.equal(
    changes['main.ts'][0].after,
    "import { findEntry, findEntryMany } from './lookup';\nexport async function load(ids: number[]) {\n  return findEntryMany(ids);",
  );
  assert.match(changes['lookup.ts'][0].after, /^export async function findEntryMany\(ids: number\[\]\) \{$/m);
  // An aliased import or one through another module cannot simply name the new function.
  for (const importLine of ["import { findEntry as find } from './lookup';", "import { findEntry } from './index';"]) {
    const [aliased] = scan(context, {
      ...files,
      'index.ts': "export { findEntry } from './lookup';\n",
      'main.ts': `${importLine}
export async function load(ids: number[]) {
  return Promise.all(ids.map((id) => ${importLine.includes(' as ') ? 'find' : 'findEntry'}(id)));
}
`,
    });
    assert.equal(aliased.fix, undefined);
  }
});
