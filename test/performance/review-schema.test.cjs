'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { projects, projectFiles, indexFindings } = require('./index-rules-fixtures.cjs');

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

function typeormMemberships(body) {
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

const { compareDto } = require('../../lib/performance/contracts/dto.cjs');
const { compareOpenApi } = require('../../lib/performance/contracts/openapi.cjs');

function dtoTypeChanges(oldType, newType, roles) {
  const source = (type) => `export class UserDto {\n  name: ${type};\n}\n`;
  return compareDto(source(oldType), source(newType), 'UserDto', new Set(roles), {
    file: 'user.dto.ts',
    forbidsUnknownInput: false,
    readModule: () => null,
  }).map((finding) => finding.ruleId);
}

test('DTO: widening a request type or narrowing a response type is not a breaking type change', () => {
  assert.deepEqual(dtoTypeChanges('string', 'string | null', ['input']), []);
  assert.deepEqual(dtoTypeChanges('string | null', 'string', ['output']), []);
  assert.deepEqual(dtoTypeChanges('string | null', 'string', ['input']), ['api-type-changed']);
  assert.deepEqual(dtoTypeChanges('string', 'string | null', ['output']), ['api-type-changed']);
  assert.deepEqual(dtoTypeChanges('string', 'string | null', ['input', 'output']), ['api-type-changed']);
  assert.deepEqual(dtoTypeChanges('number', 'string', ['input']), ['api-type-changed']);
});
