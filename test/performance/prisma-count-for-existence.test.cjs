'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { lint, withProgram } = require('./helpers.cjs');
const { analyzeFile } = require('../../lib/performance/analyze.cjs');

const ruleId = 'prisma-count-for-existence';
const declarations = {
  'node_modules/@prisma/client/index.d.ts': `
export interface StoreDelegate {
  count(args?: object): Promise<number>;
}
export declare class PrismaClient { store: StoreDelegate }
`,
};
const header = `import { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
declare const where: { slug: string };
`;

function findingsFor(source) {
  return lint(header + source, declarations).filter((finding) => finding.ruleId === ruleId);
}

test('Prisma count used in a direct existence comparison can stop at the first row', () => {
  const comparisons = [
    '(await prisma.store.count({ where })) > 0',
    '(await prisma.store.count()) === 0',
    '0 !== (await prisma.store.count({ where }))',
    '0 >= (await prisma.store.count({ where }))',
    '(await prisma.store.count({ where })) >= 1',
    '1 > (await prisma.store.count({ where }))',
  ];
  const findings = findingsFor(`async function exists() { return [${comparisons.join(', ')}]; }`);
  assert.equal(findings.length, comparisons.length);
  assert.match(findings[0].message, /`findFirst`.*same.*where.*projection/);
});

test('an existence-only count in a one-shot seed remains contextual', () => {
  const file = 'seed.ts';
  const source = header + 'export async function seed() { return (await prisma.store.count()) > 0; }';
  const findings = withProgram('export {};', { ...declarations, [file]: source }, (program) =>
    analyzeFile(program, program.getSourceFile(path.join(__dirname, 'virtual-project', file))),
  );
  const finding = findings.find((item) => item.ruleId === ruleId);
  assert.match(finding?.contextualReason ?? '', /seed/i);
});

test('cardinality comparisons, dynamic options, optional calls and unrelated count methods stay quiet', () => {
  assert.deepEqual(
    findingsFor(`
declare const missing: PrismaClient | undefined;
declare const unrelated: { count(): Promise<number> };
declare const options: object;
async function inspect() {
  return [
    (await prisma.store.count({ where })) <= 1,
    (await prisma.store.count({ where })) === 1,
    (await prisma.store.count({ where, take: 1 })) > 0,
    (await prisma.store.count({ where, skip: 1 })) === 0,
    (await prisma.store.count({ where, distinct: ['slug'] })) > 0,
    (await prisma.store.count({ select: { _all: true } })) > 0,
    (await prisma.store.count({ ...options })) > 0,
    (await prisma.store.count(options)) > 0,
    (await missing?.store.count()) === 0,
    (await unrelated.count()) > 0,
  ];
}
`),
    [],
  );
});
