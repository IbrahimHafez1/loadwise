import assert from 'node:assert/strict';
import test from 'node:test';
import { projects, projectFiles, indexFindings } from './index-rules-fixtures.cjs';
import type { ContractRole } from '../../lib/performance/types/contract-findings.cjs';
import type * as Dto from '../../lib/performance/contracts/dto.cjs';
import type * as Openapi from '../../lib/performance/contracts/openapi.cjs';

const membershipEntity = `import { Entity, PrimaryColumn, Column, Repository } from 'typeorm';
export { Repository };
@Entity('memberships')
export class Membership {
  @PrimaryColumn('uuid', { name: 'user_id' })
  userId!: string;
  @PrimaryColumn('uuid', { name: 'group_id' })
  groupId!: string;
  @Column({ name: 'joined_at' })
  joinedAt!: Date;
}
`;

function typeormMemberships(body: string) {
  const source = `import { Membership, Repository } from '${projects.typeorm}entities';
${body}`;
  return indexFindings(source, projectFiles('typeorm', { 'entities.ts': membershipEntity }));
}

test('TypeORM: two @PrimaryColumn properties form one composite key, so the second is not a leading index', () => {
  const findings = typeormMemberships(`export class MembershipService {
  constructor(private readonly memberships: Repository<Membership>) {}
  async run(userId: string, groupId: string) {
    await this.memberships.find({ where: { userId } });
    await this.memberships.find({ where: { groupId } });
  }
}`);
  assert.deepEqual(
    findings.map(({ line, ruleId }) => [line, ruleId]),
    [[6, 'index-missing-filter']],
  );
});

const membershipModel = `import { Table, Column, Model, DataType, PrimaryKey } from 'sequelize-typescript';
@Table({ tableName: 'memberships' })
export class Membership extends Model<Membership> {
  @PrimaryKey
  @Column(DataType.UUID)
  userId!: string;
  @PrimaryKey
  @Column(DataType.UUID)
  groupId!: string;
}
`;

test('Sequelize: two primary-key attributes form one composite key, so the second is not a leading index', () => {
  const source = `import { Membership } from '${projects.sequelize}models';
export async function run(userId: string, groupId: string) {
  await Membership.findAll({ where: { userId } });
  await Membership.findAll({ where: { groupId } });
}`;
  const findings = indexFindings(source, projectFiles('sequelize', { 'models.ts': membershipModel }));
  assert.deepEqual(
    findings.map(({ line, ruleId }) => [line, ruleId]),
    [[4, 'index-missing-filter']],
  );
});

// The contract comparators load the JavaScript compiler, which cannot share a process with the
// native engine.
const onNativeEngine = process.env.PERF_CHECK_TEST_NATIVE === '1';
const contractTest = (name: string, body: () => void) => test(name, { skip: onNativeEngine }, body);

function dtoTypeChanges(oldType: string, newType: string, roles: readonly ContractRole[]) {
  const source = (type: string) => `export class UserDto {\n  name: ${type};\n}\n`;
  const { compareDto }: typeof Dto = require('../../lib/performance/contracts/dto.cjs');
  return compareDto(source(oldType), source(newType), 'UserDto', new Set(roles), {
    file: 'user.dto.ts',
    forbidsUnknownInput: false,
    readModule: () => null,
  }).map((finding) => finding.ruleId);
}

contractTest('DTO: widening a request type or narrowing a response type is not a breaking type change', () => {
  assert.deepEqual(dtoTypeChanges('string', 'string | null', ['input']), []);
  assert.deepEqual(dtoTypeChanges('string | null', 'string', ['output']), []);
  assert.deepEqual(dtoTypeChanges('string | null', 'string', ['input']), ['api-type-changed']);
  assert.deepEqual(dtoTypeChanges('string', 'string | null', ['output']), ['api-type-changed']);
  assert.deepEqual(dtoTypeChanges('string', 'string | null', ['input', 'output']), ['api-type-changed']);
  assert.deepEqual(dtoTypeChanges('number', 'string', ['input']), ['api-type-changed']);
});

contractTest('OpenAPI: locating thousands of findings in a large document stays linear', () => {
  const { compareOpenApi }: typeof Openapi = require('../../lib/performance/contracts/openapi.cjs');
  const paths: Record<string, object> = {};
  for (let index = 0; index < 8000; index++) {
    paths['/items' + index] = { get: { responses: { 200: { description: 'ok' } } } };
  }
  const oldText = JSON.stringify({ openapi: '3.0.0', paths }, null, 2).replaceAll('\n', '\r\n');
  // Counts character reads instead of timing: rescanning the document per finding reads it
  // thousands of times over, and the budget stops such a run early instead of letting it take
  // minutes.
  const readBudget = 4 * oldText.length;
  const readCharacter = String.prototype.charCodeAt;
  let characterReads = 0;
  String.prototype.charCodeAt = function (index) {
    if (++characterReads > readBudget) throw new Error(`over ${readBudget} character reads`);
    return readCharacter.call(this, index);
  };
  let findings;
  try {
    findings = compareOpenApi(oldText, JSON.stringify({ openapi: '3.0.0', paths: {} }));
  } finally {
    String.prototype.charCodeAt = readCharacter;
  }
  assert.equal(findings.length, 8000);
  assert.deepEqual([findings[0].line, findings[0].column], [5, 14]);
  const lastFinding = findings.at(-1);
  assert.deepEqual([lastFinding?.line, lastFinding?.column], [71996, 14]);
});
