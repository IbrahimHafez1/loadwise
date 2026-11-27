import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.js';
import { scanWithFixes, dedent, requireOnlyChange } from './site-fix-helpers.js';
import type { Finding } from '../../lib/shared/types.js';
import { noteOf, fixOf } from '../types/finding-fix.js';

const rule = 'typeorm-load-then-save';
const typeorm = `export class Repository<T> {
  findOne(options: object): Promise<T | null>;
  findOneBy(filter: object): Promise<T | null>;
  findOneOrFail(options: object): Promise<T>;
  save(entity: T): Promise<T>;
  update(criteria: object, values: object): Promise<{ affected?: number }>;
  increment(criteria: object, column: string, value: number): Promise<{ affected?: number }>;
}
export declare function Column(): PropertyDecorator;
export declare function ManyToOne(): PropertyDecorator;
export declare function BeforeUpdate(): MethodDecorator;
export declare function Entity(): ClassDecorator;`;
const files = { 'node_modules/typeorm/index.d.ts': typeorm };
const header = `import { Repository, Column, ManyToOne, BeforeUpdate, Entity } from 'typeorm';
@Entity()
class User {
  @Column() id!: number;
  @Column() lastLoginAt!: Date;
  @Column() tokenVersion!: number;
  @Column() name!: string;
  @Column() title!: string;
  plain!: string;
  @ManyToOne() org!: object;
}
declare const users: Repository<User>;
declare const stamp: Date;
`;

function reported(body: string) {
  return lint(header + body, files).filter((finding: Finding) => finding.ruleId === rule);
}

test('reports a load that is only assigned to and saved', () => {
  const [finding] = reported(`async function login(id: number) {
    const user = await users.findOne({ where: { id } });
    if (!user) throw new Error('missing');
    user.lastLoginAt = stamp;
    user.tokenVersion += 1;
    await users.save(user);
  }`);
  assert.match(
    finding.message,
    /^`save\(user\)` after loading it only to change lastLoginAt and tokenVersion costs a SELECT/,
  );
  assert.match(finding.message, /`users\.update\(\{ id \}, \{ lastLoginAt \}\)` is one UPDATE/);
  assert.match(finding.message, /increment\(\)/);
});

test('findOneBy and ++ are reported too', () => {
  assert.equal(
    reported(`async function bump(id: number) {
      const user = await users.findOneBy({ id });
      user!.tokenVersion++;
      await users.save(user!);
    }`).length,
    0,
    'non-null assertions are not plain identifiers',
  );
  assert.equal(
    reported(`async function bump(id: number) {
      const user = await users.findOneBy({ id });
      if (!user) return;
      user.tokenVersion++;
      await users.save(user);
    }`).length,
    1,
  );
});

test('keeps quiet when the entity is read, reused, listened to or relational', () => {
  const cases = [
    `async function a(id: number) { const user = await users.findOne({ where: { id } }); if (!user) return; console.log(user.name); user.title = 'x'; await users.save(user); }`,
    `async function b(id: number) { const user = await users.findOne({ where: { id } }); if (!user) return; user.title = 'x'; await users.save(user); return user; }`,
    `async function c(id: number) { const user = await users.findOne({ where: { id } }); if (!user) return; user.title = user.name; await users.save(user); }`,
    `async function d(id: number) { const user = await users.findOne({ where: { id } }); if (!user) return; user.org = {}; await users.save(user); }`,
    `async function e(id: number) { const user = await users.findOne({ where: { id } }); if (!user) return; user.plain = 'x'; await users.save(user); }`,
    `async function f(ids: number[]) { for (const id of ids) { const user = await users.findOne({ where: { id } }); if (!user) continue; user.title = 'x'; await users.save(user); } }`,
    `async function g(id: number) { const user = await users.findOne({ where: { id }, relations: ['org'] }); if (!user) return; user.title = 'x'; await users.save(user); }`,
    `async function h(id: number) { const user = await users.findOne({ where: { id } }); if (!user) return; user.title = 'x'; user.name = 'y'; await users.save(user); await users.save(user); }`,
  ];
  for (const body of cases) assert.deepEqual(reported(body), [], body);
});

test('entities with update hooks are skipped', () => {
  const source = `import { Repository, Column, BeforeUpdate } from 'typeorm';
    class Hooked { @Column() id!: number; @Column() title!: string; @BeforeUpdate() touch() {} }
    declare const hooked: Repository<Hooked>;
    async function run(id: number) {
      const row = await hooked.findOne({ where: { id } });
      if (!row) return;
      row.title = 'x';
      await hooked.save(row);
    }`;
  assert.deepEqual(
    lint(source, files).filter((finding: Finding) => finding.ruleId === rule),
    [],
  );
});

test('fix without a guard becomes increment plus update', (context) => {
  const { findings } = scanWithFixes(context, {
    ...files,
    'a.ts': `${header}export async function run(id: number) {
  const user = await users.findOne({ where: { id } });
  user.lastLoginAt = stamp;
  user.tokenVersion += 1;
  await users.save(user);
}`,
  });
  const [finding] = findings.filter((entry) => entry.ruleId === rule);
  assert.equal(
    requireOnlyChange(finding).after,
    "await users.increment({ id }, 'tokenVersion', 1);\nawait users.update({ id }, { lastLoginAt: stamp });",
  );
});

test('fix keeps an exact not-found throw through the update result', (context) => {
  const { findings } = scanWithFixes(context, {
    ...files,
    'a.ts': `${header}export async function run(id: number) {
  const user = await users.findOneBy({ id });
  if (!user) throw new Error('missing');
  user.title = 'x';
  await users.save(user);
}`,
  });
  const [finding] = findings.filter((entry) => entry.ruleId === rule);
  assert.equal(
    requireOnlyChange(finding).after,
    "const result = await users.update({ id }, { title: 'x' });\nif (!result.affected) throw new Error('missing');",
  );
  assert.match(noteOf(finding), /affected/);
});

test('fix keeps the load and a return guard, and skips non-key lookups', (context) => {
  const { findings } = scanWithFixes(context, {
    ...files,
    'a.ts': `${header}export async function guarded(id: number) {
  const user = await users.findOneBy({ id });
  if (!user) return;
  user.title = 'x';
  await users.save(user);
}
export async function byName(name: string) {
  const user = await users.findOneBy({ name });
  user.title = 'x';
  await users.save(user);
}
`,
  });
  const found = findings.filter((entry) => entry.ruleId === rule);
  assert.equal(found.length, 2);
  assert.equal(requireOnlyChange(found[0]).after, "await users.update({ id }, { title: 'x' });");
  assert.equal(found[1].fix, undefined);
});

test('findOneOrFail becomes an update that throws EntityNotFoundError when no row matched', (context) => {
  const { findings } = scanWithFixes(context, {
    ...files,
    'a.ts': `${header}export async function orFail(id: number) {
  const user = await users.findOneOrFail({ where: { id } });
  user.tokenVersion += 1;
  await users.save(user);
}`,
  });
  const [finding] = findings.filter((entry) => entry.ruleId === rule);
  const { changes } = fixOf(finding);
  assert.equal(changes.length, 2);
  assert.match(
    changes[0].after,
    /import \{[^}]*Repository, Column, ManyToOne, BeforeUpdate, Entity, EntityNotFoundError \} from 'typeorm';/,
  );
  assert.equal(
    dedent(changes[1].after),
    "const result = await users.increment({ id }, 'tokenVersion', 1);\nif (!result.affected) throw new EntityNotFoundError(User, { id });",
  );
});

const softDeleteFiles = {
  'node_modules/typeorm/index.d.ts': `${typeorm}
export declare function DeleteDateColumn(): PropertyDecorator;
export declare function IsNull(): object;`,
  'src/base.entity.ts': `import { Column, DeleteDateColumn } from 'typeorm';
export abstract class Base {
  @Column() id!: number;
  @DeleteDateColumn() removedAt!: Date | null;
}`,
  'src/user.entity.ts': `import { Column, Entity } from 'typeorm';
import { Base } from './base.entity';
@Entity()
export class Member extends Base {
  @Column() tokenVersion!: number;
}`,
};

function serviceUsing(importLine: string) {
  return `import { Repository } from 'typeorm';
${importLine}
declare const members: Repository<Member>;
export async function revoke(id: number) {
  const member = await members.findOneOrFail({ where: { id } });
  member.tokenVersion += 1;
  await members.save(member);
}`;
}

test('a soft-deletable entity, through its base class, keeps deleted rows out of the update', (context) => {
  const { findings } = scanWithFixes(context, {
    ...softDeleteFiles,
    'src/service.ts': serviceUsing("import { Member } from './user.entity';"),
  });
  const finding = findings.find((entry) => entry.ruleId === rule);
  const [importChange, bodyChange] = fixOf(finding).changes;
  assert.equal(importChange.after, "import { Repository, EntityNotFoundError, IsNull } from 'typeorm';");
  assert.equal(
    dedent(bodyChange.after),
    "const result = await members.increment({ id, removedAt: IsNull() }, 'tokenVersion', 1);\n" +
      'if (!result.affected) throw new EntityNotFoundError(Member, { id });',
  );
  assert.match(noteOf(finding), /removedAt: IsNull\(\)/);
});

test('an entity whose base class cannot be read gets no fix', (context) => {
  const { findings } = scanWithFixes(context, {
    ...softDeleteFiles,
    'src/user.entity.ts': softDeleteFiles['src/user.entity.ts']
      .replace(
        "import { Base } from './base.entity';",
        "import { Base } from './base.entity';\nconst withAudit = <T>(base: T) => base;",
      )
      .replace('extends Base', 'extends withAudit(Base)'),
    'src/service.ts': serviceUsing("import { Member } from './user.entity';"),
  });
  const withheld = findings.find((entry) => entry.ruleId === rule);
  assert.ok(withheld, 'rule should report');
  assert.equal(withheld.fix, undefined);
});
