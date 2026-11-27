import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';

const files = {
  'node_modules/typeorm/index.d.ts': `export class Repository<T> {
      find(options?: object): Promise<T[]>; findBy(where: object): Promise<T[]>;
    }
    export function Column(typeOrOptions?: unknown, options?: object): PropertyDecorator;
    export function PrimaryGeneratedColumn(type?: string): PropertyDecorator;
    export function Entity(name?: string): ClassDecorator;
    export function AfterLoad(): MethodDecorator;
    export function ManyToOne(target: unknown): PropertyDecorator;`,
};
const schema = `import {Column as Field, Entity, PrimaryGeneratedColumn, Repository, AfterLoad, ManyToOne} from 'typeorm';
  abstract class Base { @PrimaryGeneratedColumn('uuid') id!: string }
  @Entity() class Row extends Base {
    @Field({type:'varchar'}) displayName!: string | null;
    @Field('jsonb') payload!: object;
    @Field('text', {select:false}) omitted!: string;
  }`;
const mappings = 'rows.map(row => ({id:row.id,label:row.displayName}))';

function findings(source: string) {
  return lint(source, files).filter((finding: Finding) => finding.ruleId === 'typeorm-wide-projection');
}

test('selects the actual read columns including an inherited primary key and only reports default-selected wide columns', () => {
  const source =
    schema +
    `
    async function project(repo:Repository<Row>) {
      const rows = await repo.find({where:{id:'x'}});
      return ${mappings};
    }
    async function direct(repo:Repository<Row>) { return (await repo.find()).map(row => ({id:row.id})); }`;
  const result = findings(source);
  assert.equal(result.length, 2);
  assert.match(result[0].message, /select: \{ id: true, displayName: true \}.*\(payload\).*subscribers/);
  assert.doesNotMatch(result[0].message, /omitted/);
  const legacy = {
    'node_modules/typeorm/index.d.ts': files['node_modules/typeorm/index.d.ts'].replace(
      'findBy(where: object): Promise<T[]>;',
      '',
    ),
  };
  assert.equal(
    lint(source, legacy).some((finding: Finding) => finding.ruleId === 'typeorm-wide-projection'),
    false,
  );
});

test('suppresses partial entities, escapes, computed access, unknown options and unverified repository/model methods', () => {
  const source =
    schema +
    `
    async function project(repo:Repository<Row>) {
      const rows = await repo.find(); inspect(rows);
      return ${mappings};
    }
    declare function inspect(x:unknown): void;
    async function columns(repo:Repository<Row>) { const rows = await repo.find({select:{id:true}}); return ${mappings}; }
    async function dynamic(repo:Repository<Row>,opts:object) { const rows = await repo.find(opts); return ${mappings}; }
    async function full(repo:Repository<Row>) { return (await repo.find()).map(row=>({...row})); }
    async function nested(repo:Repository<Row>) { return (await repo.find()).map(row=>({id:row.id, other:inspect(row)})); }
    async function missingPrimary(repo:Repository<Row>) { return (await repo.find()).map(row=>({label:row.displayName})); }
    async function allUsed(repo:Repository<Row>) { return (await repo.find()).map(row=>({id:row.id,payload:row.payload})); }
    async function unknown(repo:{find():Promise<Row[]>}) { const rows = await repo.find(); return ${mappings}; }
    async function narrow(repo:Repository<{id:string}>) { return (await repo.find()).map(row=>({id:row.id})); }
    async function shadow(repo:Repository<Row>) { const rows = await repo.find(); return rows.map(row=>({id:row['id']})); }
  `;
  assert.deepEqual(findings(source), []);
});

test('skips load hooks, accessors, relations, transformers, external metadata, and columns omitted by default', () => {
  const members = [
    '@AfterLoad() hydrate() {}',
    'get derived() { return this.payload; }',
    '@ManyToOne(() => Row) other!: Row;',
    "@Field({type:'text', transformer: {}}) converted!: string;",
    '@custom() ambiguous!: string;',
    "@Field('jsonb',{select:false}) override payload!: object;",
  ];
  const sources = members.map(
    (member, index) => `@Entity() class Special${index} extends Row { ${member} }
  async function read${index}(repo:Repository<Special${index}>) { const rows = await repo.find(); return ${mappings}; }`,
  );
  const source =
    schema +
    '\ndeclare function custom(): PropertyDecorator;\n' +
    sources.join('\n') +
    `
    @Entity() class Small extends Base { @Field('text',{select:false}) hidden!: string; @Field('varchar') status!: string; }
    async function small(repo:Repository<Small>) { return (await repo.find()).map(row=>({id:row.id})); }`;
  assert.deepEqual(findings(source), []);
});
