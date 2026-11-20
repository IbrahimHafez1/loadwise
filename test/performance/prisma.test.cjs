const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lint } = require('./helpers.cjs');

const delegateDeclaration = `
  export interface UserDelegate {
    findMany(options?: object): Promise<{ id: number, active: boolean }[]>;
    findUnique(options: object): Promise<{ id: number } | null>;
    count(options?: object): Promise<number>;
    create(options: object): Promise<{ id: number }>;
    createMany(options: object): Promise<{ count: number }>;
  }`;
const legacyFiles = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts':
    delegateDeclaration + 'export declare class PrismaClient { user: UserDelegate }',
};

test('loop queries distinguish a terminating lookup from repeats through retries and outer items', () => {
  const source = `import type {PrismaClient} from '@prisma/client';
    async function check(db: PrismaClient, ids: number[]) {
      for (const id of ids) {
        if (id < 0) {
          const row = await db.user.findMany({ where: { id } });
          throw Error(String(row));
        }
        await db.user.findMany({ where: { id } }); // repeat
      }
      for (const id of ids) {
        try { return await db.user.findMany({ where: { id } }); } catch { continue; } // repeat
      }
      for (const outer of ids) for (const id of ids) {
        await db.user.findMany({ where: { id } }); // repeat
        break;
      }
      for (const id of ids) {
        if (id > 0) {
          await db.user.findMany({ where: { id } }); // repeat
          if (id < 100) continue;
        }
        throw Error();
      }
      for (const id of ids) {
        const rows = await db.user.findMany({ where: { id } });
        return rows;
      }
    }`;
  const repeated = source.split('\n').flatMap((line, index) => (line.includes('// repeat') ? [index + 1] : []));
  assert.deepEqual(
    lint(source, legacyFiles)
      .filter((finding) => finding.ruleId === 'prisma-query-in-loop')
      .map((finding) => finding.line),
    repeated,
  );
});

test('bulk predicates and advancing keysets are distinguished from per-item and stationary reads', () => {
  const source = `import type {PrismaClient} from '@prisma/client';
    async function check(db: PrismaClient, pages: {id:number}[][], fixedIds: number[]) {
      for (const page of pages) {
        const ids = [...new Set(page.map(record => record.id))];
        await db.user.findMany({ where: { owner: { in: ids } } });
        await db.user.findMany({ where: { OR: page.map(record => ({ id: record.id })) } });
        for (const item of page) {
          await db.user.findMany({ where: { id: item.id, owner: { in: ids } } }); // repeat
        }
        await db.user.findMany({ where: { id: { in: fixedIds } } }); // repeat
      }
      let after: number | undefined;
      for (;;) {
        const rows = await db.user.findMany({ where: { id: { gt: after } }, orderBy: { id: 'asc' }, take: 100 });
        const last = rows.at(-1);
        if (!last) break;
        after = last.id;
      }
      for (;;) {
        const rows = await db.user.findMany({ where: { id: 10 }, take: 100 }); // repeat
        if (!rows.length) break;
        after = rows[rows.length - 1].id;
      }
    }`;
  const repeated = source.split('\n').flatMap((line, index) => (line.includes('// repeat') ? [index + 1] : []));
  assert.deepEqual(
    lint(source, legacyFiles)
      .filter((finding) => finding.ruleId === 'prisma-query-in-loop')
      .map((finding) => finding.line),
    repeated,
  );
});

test('a keyset advances the same ordered field by a strict boundary or an explicitly skipped cursor', () => {
  const ordered = "orderBy: { id: 'asc' }, take: 100";
  const cases = [
    [`where: after ? { id: { gt: after } } : undefined, ${ordered}`],
    [`where: { enabled: true, ...(after ? { id: { gt: after } } : {}) }, ${ordered}`],
    ["where: { id: { lt: after } }, orderBy: { id: 'desc' }, take: 100"],
    [`cursor: { id: after }, skip: 1, ${ordered}`],
    [`where: { id: after }, ${ordered}`, 'repeat'],
    [`where: { id: { gte: after } }, ${ordered}`, 'repeat'],
    [`where: { id: { lt: after } }, ${ordered}`, 'repeat'],
    [`where: { other: { gt: after } }, ${ordered}`, 'repeat'],
    ["where: { id: { gt: after } }, orderBy: { id: 'asc' }, take: 1", 'repeat'],
    ["where: { id: { gt: after } }, orderBy: { id: 'asc' }, take: dynamicSize", 'repeat'],
    [`where: { id: { gt: after } }, ${ordered}, ...overrides`, 'repeat'],
    [`where: { id: { gt: after }, ...overrides }, ${ordered}`, 'repeat'],
    [`cursor: { id: after }, ${ordered}`, 'repeat'],
    [`where: { OR: [{ id: { gt: after } }, {}] }, ${ordered}`, 'repeat'],
    [`where: { id: { gt: after } }, ${ordered}`, 'repeat', 'rows[rows.length - 1].active'],
    [`where: { id: { gt: after } }, ${ordered}`, 'repeat', undefined, 'after = 0;'],
  ];
  const source = `import type {PrismaClient} from '@prisma/client';
    async function check(db: PrismaClient, dynamicSize: number, overrides: object) {
      let after: number | boolean = 0;
      ${cases
        .map(
          ([options, label, assigned, reset]) =>
            `while (true) { const rows = await db.user.findMany({${options}}); if (!rows.length) break; after = ${assigned || 'rows[rows.length - 1].id'}; ${reset || ''} } // ${label || 'page'}`,
        )
        .join('\n')}
    }`;
  const expected = source.split('\n').flatMap((line, index) => (line.endsWith('// repeat') ? [index + 1] : []));
  assert.deepEqual(
    lint(source, legacyFiles)
      .filter((finding) => finding.ruleId === 'prisma-query-in-loop')
      .map((finding) => finding.line),
    expected,
  );
});

test('effective positive batch filters retain singleton grouping, mixed OR, negation and later overrides', () => {
  const source = `import type {PrismaClient} from '@prisma/client';
    async function check(db: PrismaClient, groups: number[][], ids: number[], overrides: object) {
      const singletonGroups = ids.map(id => [id]);
      for (const group of singletonGroups) await db.user.findMany({where: {id: {in: group}}}); // repeat
      for (const group of groups) {
        await db.user.findMany({where: {OR: [{id: {in: group}}, {enabled: true}]}}); // repeat
        await db.user.findMany({where: {NOT: {id: {in: group}}}}); // repeat
        await db.user.findMany({where: {id: {in: group}, ...overrides}}); // repeat
        await db.user.findMany({where: {id: {in: group}, [String('id')]: 1}}); // repeat
        await db.user.findMany({where: {id: {in: group}}, ...overrides}); // repeat
        await db.user.findMany({where: {id: {in: group.map(item => 42)}}}); // repeat
        await db.user.findMany({where: {id: {in: group}, id: 1}}); // repeat
        await db.user.findMany({where: {OR: [{id: {in: group}}, {owner: {in: group}}]}});
        await db.user.findMany({where: {...overrides, id: {in: group}}});
      }
    }`;
  const expected = source.split('\n').flatMap((line, index) => (line.endsWith('// repeat') ? [index + 1] : []));
  assert.deepEqual(
    lint(source, legacyFiles)
      .filter((finding) => finding.ruleId === 'prisma-query-in-loop')
      .map((finding) => finding.line),
    expected,
  );
});

test('flags per-item reads and single-row writes through the resolved Prisma delegate', () => {
  const source = `import { PrismaClient as Database } from '@prisma/client';
    import type * as Prisma from '@prisma/client';
    async function load(db: Prisma.PrismaClient, ids: number[]) {
      const users = db.user;
      for (const id of ids) {
        await users.findMany({ where: { id } });
        await users.create({ data: { id } });
      }
    }
    const db = new Database();
    const jobs = [1, 2].map(id => db.user.findUnique({ where: { id } }));`;
  const findings = lint(source, legacyFiles);
  assert.deepEqual(
    findings.map((finding) => [finding.line, finding.ruleId]),
    [
      [6, 'prisma-query-in-loop'],
      [7, 'prisma-query-in-loop'],
    ],
  );
});

test('lazy Prisma builders and concurrent unique lookups stay quiet while sequential and consumed queries report', () => {
  const source = `import { PrismaClient } from '@prisma/client';
    async function run(db: PrismaClient, ids: number[]) {
      ids.map(id => db.user.findMany({ where: { id } }));
      await Promise.all(ids.map(id => db.user.findUnique({ where: { id } })));
      for (const id of ids) {
        db.user.findMany({ where: { id } });
        await db.user.findUnique({ where: { id } });
        db.user.findMany({ where: { id } }).then(rows => rows.length);
      }
      await Promise.all(ids.map(id => db.user.findMany({ where: { id } })));
      (await db.user.findMany()).length;
    }`;
  assert.deepEqual(
    lint(source, legacyFiles)
      .filter(({ ruleId }) => ruleId !== 'floating-promise')
      .map(({ line, ruleId }) => [line, ruleId]),
    [
      [7, 'prisma-query-in-loop'],
      [8, 'prisma-query-in-loop'],
      [10, 'prisma-query-in-loop'],
    ],
  );
});

test('count materialization requires a direct awaited length and count-compatible options', () => {
  const source = `import { PrismaClient } from '@prisma/client';
    async function counts(db: PrismaClient) {
      const where = { enabled: true };
      const direct = (await db.user.findMany()).length;
      const filtered = (await (db.user.findMany({ where }))).length;
      const options = { distinct: ['id'] };
      const distinct = (await db.user.findMany(options)).length;
      const distinctLiteral = (await db.user.findMany({ distinct: ['id'] })).length;
      const spread = (await db.user.findMany({ ...options })).length;
      const page = (await db.user.findMany({ take: 10 })).length;
      const selected = (await db.user.findMany({ select: { id: true } })).length;
      const rows = await db.user.findMany();
      const first = rows[0];
      const total = await db.user.count({ where });
      (await db.user.findMany()).length = 0;
    }`;
  const findings = lint(source, legacyFiles);
  assert.deepEqual(
    findings.map((finding) => [finding.line, finding.ruleId]),
    [
      [4, 'prisma-count-materialization'],
      [5, 'prisma-count-materialization'],
    ],
  );
});

test('resolves a delegate from modern project-local generated model declarations', () => {
  const files = {
    'orm/models/User.ts':
      "/* This is code generated by Prisma. */ import type * as runtime from '@prisma/client/runtime/client';" +
      delegateDeclaration,
    'orm/client.ts':
      "import type { UserDelegate } from './models/User';" + ' export interface PrismaClient { user: UserDelegate }',
    'node_modules/@prisma/client/runtime/client.d.ts': 'export {};',
  };
  const findings = lint(
    `import type { PrismaClient } from './orm/client';
    async function counts(db: PrismaClient) { return (await db.user.findMany({})).length; }`,
    files,
  );
  assert.deepEqual(
    findings.map((finding) => finding.ruleId),
    ['prisma-count-materialization'],
  );
});

test('first-row materialization keeps filters, ordering and nullable result semantics explicit', () => {
  const findings = lint(
    `import { PrismaClient } from '@prisma/client';
async function first(db: PrismaClient, options: object, fake: {findMany(): Promise<number[]>}) {
  const where = {enabled: true};
  const orderBy = [{score: 'desc'}, {id: 'asc'}];
  const first = (await db.user.findMany({where, orderBy}))[0];
  const projected = (await db.user.findMany({select: {id: true}}))[0]?.id;
  const specified = (await db.user.findMany({take: 1}))[0];
  const cursor = (await db.user.findMany({cursor: {id: 10}}))[0];
  const skipped = (await db.user.findMany({skip: 5}))[0];
  const distinct = (await db.user.findMany({distinct: ['id']}))[0];
  const dynamic = (await db.user.findMany(options))[0];
  const spread = (await db.user.findMany({...options}))[0];
  const second = (await db.user.findMany())[1];
  const other = (await fake.findMany())[0];
  (await db.user.findMany())[0].id = 0;
  delete (await db.user.findMany())[0];
  return (await db.user.findMany())[0];
}`,
    legacyFiles,
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['prisma-first-materialization', 5],
      ['prisma-first-materialization', 6],
      ['prisma-first-materialization', 17],
    ],
  );
  assert.match(findings[0].message, /findFirst/);
  assert.match(findings[0].message, /null/);
  assert.match(findings[0].message, /undefined/);
});

test('Prisma recognizes simple inline filters and top-K sorts on unbounded model queries', () => {
  const findings = lint(
    `import { PrismaClient } from '@prisma/client';
async function load(db: PrismaClient, key: number, method: (row: {id:number}) => boolean) {
  const booleans = (await db.user.findMany({select: {active: true}})).filter(row => row.active === false);
  const negative = (await db.user.findMany({where: {active: true}})).filter(row => row.id === -1);
  const top = (await db.user.findMany()).sort((a,b) => b.id - a.id).slice(0, 2);
  const first = (await db.user.findMany({orderBy: {id: 'desc'}})).sort((a,b) => a.id - b.id)[0];
  const pushed = await db.user.findMany({where: {active: true}, orderBy: {id: 'asc'}, take: 2});
  const page = (await db.user.findMany({take: 2})).filter(row => row.active === true);
  const omitted = (await db.user.findMany({select: {id: true}})).filter(row => row.active === true);
  const opaque = (await db.user.findMany()).filter(method);
  const externalValue = (await db.user.findMany()).filter(row => row.id === key);
  const computed = (await db.user.findMany()).filter(row => row.id * 2 === 4);
  const compound = (await db.user.findMany()).filter(row => row.active === true && row.id === 2);
  const offset = (await db.user.findMany()).sort((a,b) => a.id - b.id).slice(1, 2);
  const noPrefix = (await db.user.findMany()).sort((a,b) => a.id - b.id);
  const valueComparison = (await db.user.findMany()).sort((a,b) => Number(a.active) - Number(b.active))[0];
}`,
    legacyFiles,
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [
      ['prisma-filter-materialization', 3],
      ['prisma-filter-materialization', 4],
      ['prisma-top-k-materialization', 5],
      ['prisma-top-k-materialization', 6],
    ],
  );
});

test('leaves lookalike repositories, batched queries, and deferred callbacks alone', () => {
  const source = `import { PrismaClient } from '@prisma/client';
    import type * as runtime from '@prisma/client/runtime/client';
    interface UserDelegate { findMany(): Promise<number[]> }
    async function load(db: PrismaClient, fake: UserDelegate, ids: number[]) {
      const rows = await db.user.findMany({ where: { id: { in: ids } } });
      const callbacks = [];
      for (const id of ids) {
        await fake.findMany();
        callbacks.push(() => db.user.findMany({ where: { id } }));
      }
      return rows;
    }`;
  assert.deepEqual(
    lint(source, {
      ...legacyFiles,
      'node_modules/@prisma/client/runtime/client.d.ts': 'export {};',
    }),
    [],
  );
});

test('discarded counts, filters and sorted prefixes do not suggest server-side materialization changes', () => {
  assert.deepEqual(
    lint(
      `import type { PrismaClient } from '@prisma/client';
    async function run(db: PrismaClient) {
      void (await db.user.findMany()).length;
      ((await db.user.findMany())[0], 1);
      void (await db.user.findMany()).filter(row => row.active === true);
      (await db.user.findMany()).sort((a, b) => a.id - b.id).slice(0, 2);
    }`,
      legacyFiles,
    ),
    [],
  );
});

test('a page OR built through a per-row filter helper is one batched read', () => {
  const source = `import type {PrismaClient} from '@prisma/client';
    function windowFor(id: number, since: number) { return { id, owner: { gt: since } }; }
    async function check(db: PrismaClient, pages: {id: number, since: number}[][]) {
      for (const page of pages) {
        await db.user.findMany({ where: { OR: page.map((row) => windowFor(row.id, row.since)) } });
        for (const row of page) await db.user.findMany({ where: { OR: [windowFor(row.id, row.since)] } }); // repeat
      }
    }`;
  const expected = source.split('\n').flatMap((line, index) => (line.endsWith('// repeat') ? [index + 1] : []));
  assert.deepEqual(
    lint(source, legacyFiles)
      .filter((finding) => finding.ruleId === 'prisma-query-in-loop')
      .map((finding) => finding.line),
    expected,
  );
});

// analyze.cjs visits calls only, so this drives the check over a TypeScript 6 program directly.
test(
  'raw Prisma tagged templates awaited per item are loop queries',
  {
    skip: process.env.PERF_CHECK_TEST_NATIVE === '1' && 'builds a TypeScript 6 program',
  },
  () => {
    const { withProgram } = require('./helpers.cjs');
    const { syntax: ts } = require('../../lib/performance/compiler.cjs');
    const { checkPrismaRawTemplate } = require('../../lib/performance/prisma.cjs');
    const source = `import { PrismaClient } from '@prisma/client';
    async function run(db: PrismaClient, ids: number[]) {
      for (const id of ids) await db.$executeRaw\`UPDATE item SET hits = hits + 1 WHERE id = \${id}\`; // repeat
      await db.$transaction(ids.map((id) => db.$executeRaw\`UPDATE item SET hits = 0 WHERE id = \${id}\`));
      for (const id of [1]) await db.$queryRaw\`SELECT \${id}\`;
      await db.$queryRaw\`SELECT 1\`;
    }`;
    const files = {
      'node_modules/@prisma/client/index.d.ts': `export declare class PrismaClient {
      $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
      $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
      $transaction(queries: Promise<unknown>[]): Promise<unknown[]>;
    }`,
    };
    const lines = withProgram(source, files, (program, sourceFile) => {
      const reported = [];
      const context = {
        checker: program.getTypeChecker(),
        report: (node) => reported.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1),
      };
      (function visit(node) {
        if (ts.isTaggedTemplateExpression(node)) checkPrismaRawTemplate(node, context);
        ts.forEachChild(node, visit);
      })(sourceFile);
      return reported;
    });
    assert.deepEqual(
      lines,
      source.split('\n').flatMap((line, index) => (line.endsWith('// repeat') ? [index + 1] : [])),
    );
  },
);
