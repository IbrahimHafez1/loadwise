import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanWithFixes } from './site-fix-helpers.cjs';
import { reasonOf } from '../types/finding-reason.cjs';

const ruleId = 'array-repeated-find';
const bsonDeclarations = {
  'node_modules/bson/index.d.ts': 'export declare class ObjectId { toString(encoding?: "hex" | "base64"): string; }',
};

function findSource(typeDeclaration: string, itemType: string, conversion = 'item.user.toString()') {
  return `${typeDeclaration}
export function link(items: { user: ${itemType} }[], userIds: Map<string, number>) {
  for (const [userId] of userIds) {
    const found = items.find((item) => ${conversion} === userId);
    if (found) consume(found);
  }
}
declare function consume(item: unknown): void;
`;
}

test('a repeated find by BSON ObjectId string projection is contextual and has no automatic rewrite', (context) => {
  const source = findSource("import type { ObjectId } from 'bson';", 'ObjectId');
  const { findings } = scanWithFixes(context, { 'app.ts': source, ...bsonDeclarations });
  const lookups = findings.filter((finding) => finding.ruleId === ruleId);
  assert.equal(lookups.length, 1);
  assert.match(reasonOf(lookups[0]), /ObjectId/);
  assert.equal(lookups[0].fix, undefined);
});

test('ordinary, custom and argument-taking conversions stay outside the ObjectId lookup rule', (context) => {
  const { findings } = scanWithFixes(context, {
    'custom.ts': findSource('interface ObjectId { toString(): string; }', 'ObjectId'),
    'strings.ts': findSource('', 'string'),
    'encoding.ts': findSource("import type { ObjectId } from 'bson';", 'ObjectId', 'item.user.toString("base64")'),
    ...bsonDeclarations,
  });
  assert.equal(findings.filter((finding) => finding.ruleId === ruleId).length, 0);
});
