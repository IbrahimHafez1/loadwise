import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { scanWithFixes } from './site-fix-helpers.cjs';

const files = {
  'package.json': '{}',
  'node_modules/@prisma/client/index.d.ts': `export interface StoreDelegate {
  count(args?: object): Promise<number>;
}
export declare class PrismaClient { store: StoreDelegate }`,
};
const source = `import { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
export async function exists() { return (await prisma.store.count({ where: { slug: 'a' } })) > 0; }
`;

function existenceFinding(context: TestContext, schema: string) {
  const { findings } = scanWithFixes(context, { ...files, 'prisma/schema.prisma': schema, 'src/service.ts': source });
  const found = findings.find((finding) => finding.ruleId === 'prisma-count-for-existence');
  assert.ok(found, 'the existence count should be reported');
  return found;
}

test('the finding carries the model single id field read from the parsed schema', (context) => {
  assert.equal(
    existenceFinding(context, 'model Store {\n  slug String @id @map("store_slug")\n  name String\n}\n').idField,
    'slug',
  );
  assert.equal(existenceFinding(context, 'model Store {\n  code Int\n  @@id([code])\n}\n').idField, 'code');
});

test('the finding has no id field for compound ids or models without one', (context) => {
  assert.equal(existenceFinding(context, 'model Store {\n  a Int\n  b Int\n  @@id([a, b])\n}\n').idField, undefined);
  assert.equal(existenceFinding(context, 'model Store {\n  name String\n}\n').idField, undefined);
});
