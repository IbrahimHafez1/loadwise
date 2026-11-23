'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');
const { typeorm } = require('./fixtures/schema/orm-stubs.cjs');

const RULE_ID = 'list-query-overfetch';

function overfetchFindings(entityBody) {
  const source = `import { Repository, Entity, PrimaryGeneratedColumn, Column } from 'typeorm';
@Entity() class Post {
  @PrimaryGeneratedColumn() id!: number;
  ${entityBody}
}
declare const posts: Repository<Post>;
export const list = () => posts.find({ where: { id: 1 } });
`;
  return lint(source, typeorm).filter((finding) => finding.ruleId === RULE_ID);
}

test('TypeORM: text array columns are lists of short strings, not wide columns', () => {
  assert.deepEqual(overfetchFindings("@Column('text', { array: true }) tags!: string[];"), []);
  assert.deepEqual(overfetchFindings("@Column({ type: 'text', array: true }) tags!: string[];"), []);
});

test('TypeORM: a text array column does not hide a wide column beside it', () => {
  const found = overfetchFindings("@Column('text', { array: true }) tags!: string[]; @Column('text') body!: string;");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /body \(text\)/);
  assert.doesNotMatch(found[0].message, /tags/);
});
