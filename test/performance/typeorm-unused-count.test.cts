import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';

const ruleId = 'typeorm-unused-count';
const declarations = {
  'node_modules/typeorm/index.d.ts': `
export class Repository<Row> {
  findAndCount(options?: object): Promise<[Row[], number]>;
  findAndCountBy(where: object): Promise<[Row[], number]>;
}
export class SelectQueryBuilder<Row> {
  take(size: number): this;
  getManyAndCount(): Promise<[Row[], number]>;
}
`,
};
const header = `import { Repository, SelectQueryBuilder } from 'typeorm';
declare const auditLogs: Repository<{ id: number }>;
declare const builder: SelectQueryBuilder<{ id: number }>;
declare const where: { schoolId: number };
`;

function findingsFor(source: string) {
  return lint(header + source, declarations).filter((finding: Finding) => finding.ruleId === ruleId);
}

test('TypeORM count-and-list methods report a directly discarded count', () => {
  const findings = findingsFor(`
async function recentActivity() {
  const [logs] = await auditLogs.findAndCount({ where, order: { id: 'DESC' }, take: 8 });
  return logs;
}
async function allActivity() {
  const [logs] = await auditLogs.findAndCountBy(where);
  return logs;
}
async function recentActivityWithBuilder() {
  const [logs] = await (builder.take(8).getManyAndCount());
  return logs;
}
async function recentActivityWithElidedCount() {
  const [logs, ,] = await auditLogs.findAndCount({ where });
  return logs;
}
`);
  assert.equal(findings.length, 4);
  assert.match(findings[0].message, /may run a count query.*`find`/);
  assert.match(findings[1].message, /`findBy`/);
  assert.match(findings[2].message, /`getMany`/);
});

test('used counts, escaping tuples, optional calls and unrelated methods stay quiet', () => {
  assert.deepEqual(
    findingsFor(`
declare const maybe: Repository<{ id: number }> | undefined;
declare const unrelated: { findAndCount(): Promise<[unknown[], number]> };
class CustomRepository extends Repository<{ id: number }> {
  override findAndCount(): Promise<[{ id: number }[], number]> { return Promise.resolve([[], 0]); }
}
declare const custom: CustomRepository;
async function activityFeed() {
  const [logs, total] = await auditLogs.findAndCount({ where, take: 8 });
  return { logs, total };
}
async function inspect() {
  const [first, ...details] = await auditLogs.findAndCount();
  const [...wholeTuple] = await auditLogs.findAndCount();
  const [,] = await auditLogs.findAndCount();
  const [, onlyCount] = await auditLogs.findAndCount();
  const [optional] = (await maybe?.findAndCount()) ?? [];
  const [otherRows] = await unrelated.findAndCount();
  const [customRows] = await custom.findAndCount();
  return { first, details, wholeTuple, onlyCount, optional, otherRows, customRows };
}
`),
    [],
  );
});
