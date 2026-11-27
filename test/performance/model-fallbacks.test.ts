import assert from 'node:assert/strict';
import { requireNativeSourceFile } from '../types/native-program.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Node, SourceFile } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.js';
import { findPrismaSchemaFiles } from '../../lib/performance/schema/prisma-schema.js';
import { formatMissingPackagesNote } from '../../lib/performance/missing-packages.js';
import type { FileMap } from '../types/project-files.js';
import { loadSyntax, selectNativeSyntax } from '../../lib/performance/compiler.js';
import nativeSyntax from '../../lib/performance/native-syntax.js';
import { requireNative } from '../../lib/performance/native-runtime.js';
import { adaptProgram } from '../../lib/performance/native-checker.js';

const useNative = process.env.PERF_CHECK_TEST_NATIVE === '1';
// The compiler is chosen once per process, before any rule module loads.
if (useNative) selectNativeSyntax(nativeSyntax);

import { withProgram } from './helpers.js';
const { modelFallback } = await import('../../lib/performance/models/index.js');

function nativeProgram<Result>(
  source: string,
  files: FileMap,
  callback: (program: ProgramAdapter, sourceFile: SourceFile) => Result,
): Result {
  const { API, ModuleKind, ModuleResolutionKind } = requireNative('typescript/sync');
  const { ScriptTarget } = requireNative('typescript/ast');
  const { createFileSystemWithLib } = requireNative('typescript/fs');
  const root = path.join(import.meta.dirname, 'virtual-project');
  const entries = Object.entries({ 'main.ts': source, ...files }).map(([name, contents]) => [
    path.join(root, name),
    contents,
  ]);
  const rootFiles = entries
    .filter(([name]) => !name.includes(path.sep + 'node_modules' + path.sep) && /\.[cm]?[jt]sx?$/.test(name))
    .map(([name]) => name);
  const api = new API();
  try {
    const snapshot = api.createSnapshot({
      fileSystem: createFileSystemWithLib(entries),
      createPrograms: [
        {
          rootFiles,
          compilerOptions: {
            target: ScriptTarget.ES2022,
            module: ModuleKind.NodeNext,
            moduleResolution: ModuleResolutionKind.NodeNext,
            strict: true,
            experimentalDecorators: true,
            skipLibCheck: true,
            types: [],
            lib: ['es2022'],
          },
        },
      ],
    });
    const program = snapshot.operation.createdPrograms[0];
    const adapted = adaptProgram(program, { strict: true });
    return callback(adapted, requireNativeSourceFile(program, path.join(root, 'main.ts')));
  } finally {
    api.close();
  }
}

// The ORM the fallback assigns to each `receiver.method` access in main.ts, keyed by the access
// text.
function fallbacks(source: string, files = {}) {
  const ts = loadSyntax();
  const run = (program: ProgramAdapter, sourceFile: SourceFile) => {
    const found: Record<string, string> = {};
    const visit = (node: Node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const fallback = modelFallback(node, program.getTypeChecker());
        if (fallback) found[node.getText(sourceFile)] = fallback.orm;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  };
  return useNative
    ? nativeProgram(source, files, run)
    : withProgram(source, files, run, { experimentalDecorators: true });
}

test('TypeORM: a Repository of a project entity and getRepository(Entity) are recognised', () => {
  const found = fallbacks(
    `import { Repository, DataSource } from 'typeorm';
     import { InjectRepository } from '@nestjs/typeorm';
     import { User } from './user.entity';
     import { Other } from './other';
     export class Service {
       constructor(
         private readonly userRepository: Repository<User>,
         private readonly otherRepository: Repository<Other>,
         @InjectRepository(User) private injected: Repository<User>,
       ) {}
       async run(source: DataSource) {
         const repo = source.getRepository(User);
         await this.userRepository.find();
         await this.otherRepository.find();
         await repo.findOne({});
       }
     }`,
    {
      'user.entity.ts': "import { Entity } from 'typeorm'; @Entity() export class User { id!: number }",
      'other.ts': 'export class Other { id!: number }',
    },
  );
  assert.equal(found['this.userRepository.find'], 'typeorm');
  assert.equal(found['repo.findOne'], 'typeorm');
  assert.equal(found['this.otherRepository.find'], undefined);
});

test('TypeORM: an active-record entity is recognised, a plain class is not', () => {
  const found = fallbacks(
    `import { User } from './user.entity';
     import { Plain } from './plain';
     async function run() { await User.find(); await Plain.find(); }`,
    {
      'user.entity.ts':
        "import { Entity, BaseEntity } from 'typeorm'; @Entity() export class User extends BaseEntity { id!: number }",
      'plain.ts': 'export class Plain { static find() {} }',
    },
  );
  assert.equal(found['User.find'], 'typeorm');
  assert.equal(found['Plain.find'], undefined);
});

test('Mongoose: a model(...) value, a Nest Model<T> property and an unrelated object', () => {
  const found = fallbacks(
    `import { Model } from 'mongoose';
     import { UserModel } from './user.model';
     import { cache } from './cache';
     export class Service {
       constructor(private readonly users: Model<UserDoc>) {}
       async run() {
         await UserModel.find({});
         await this.users.find({});
         await cache.find({});
       }
     }
     interface UserDoc { name: string }`,
    {
      'user.model.ts':
        "import mongoose, { Schema, model } from 'mongoose'; export const UserModel = mongoose.models.User || model('User', new Schema({}));",
      'cache.ts': 'export const cache = { find(key: object) { return key; } };',
    },
  );
  assert.equal(found['UserModel.find'], 'mongoose');
  assert.equal(found['this.users.find'], 'mongoose');
  assert.equal(found['cache.find'], undefined);
});

test('Sequelize: classes extending Model, @Table classes and define() models', () => {
  const found = fallbacks(
    `import { User } from './user';
     import { Account } from './account';
     import { Tag } from './tag';
     import { Plain } from './plain';
     async function run() {
       await User.findAll();
       await Account.findAll();
       await Tag.findAll();
       await Plain.findAll();
     }`,
    {
      'user.ts': "import { Model } from 'sequelize'; export class User extends Model {}",
      'account.ts': "import { Table, Model } from 'sequelize-typescript'; @Table export class Account extends Model {}",
      'tag.ts':
        "import { Sequelize } from 'sequelize'; const sequelize = new Sequelize('sqlite::memory:'); export const Tag = sequelize.define('tag', {});",
      'plain.ts': 'export class Plain { static findAll() {} }',
    },
  );
  assert.equal(found['User.findAll'], 'sequelize');
  assert.equal(found['Account.findAll'], 'sequelize');
  assert.equal(found['Tag.findAll'], 'sequelize');
  assert.equal(found['Plain.findAll'], undefined);
});

test('Drizzle: tables passed to from()/insert(), db.query and transaction callbacks', () => {
  const found = fallbacks(
    `import { drizzle } from 'drizzle-orm/node-postgres';
     import { users } from './schema';
     import { notes } from './notes';
     const db = drizzle({} as never);
     async function run(other: { insert(table: object): void }) {
       await db.select().from(users);
       await db.query.users.findMany();
       await db.transaction(async (tx) => { await tx.insert(users).values({}); });
       other.insert(notes);
     }`,
    {
      'schema.ts':
        "import { pgTable, serial } from 'drizzle-orm/pg-core'; export const users = pgTable('users', { id: serial('id') });",
      'notes.ts': 'export const notes = {};',
    },
  );
  assert.equal(found['db.select().from'], 'drizzle');
  assert.equal(found['db.query.users.findMany'], 'drizzle');
  assert.equal(found['tx.insert'], 'drizzle');
  assert.equal(found['other.insert'], undefined);
});

test('a name the checker resolves is never second-guessed', () => {
  const found = fallbacks(
    `import { UserModel } from './user.model';
     async function run() { await UserModel.find({}); }`,
    {
      'user.model.ts': "import { model } from 'mongoose'; export const UserModel = model('User', {} as never);",
      'node_modules/mongoose/index.d.ts':
        'export declare function model(name: string, schema: object): { find(filter: object): Promise<unknown[]> };',
      'node_modules/mongoose/package.json': '{"name":"mongoose","types":"index.d.ts"}',
    },
  );
  assert.deepEqual(found, {});
});

function withTemporaryRoot(callback: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-prisma-config-'));
  try {
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('prisma.config.ts names a schema file or a schema folder without being executed', () => {
  withTemporaryRoot((root: string) => {
    fs.mkdirSync(path.join(root, 'db', 'schema'), { recursive: true });
    fs.writeFileSync(path.join(root, 'db', 'schema', 'a.prisma'), 'model A { id Int @id }');
    fs.writeFileSync(path.join(root, 'db', 'schema', 'b.prisma'), 'model B { id Int @id }');
    fs.writeFileSync(
      path.join(root, 'prisma.config.ts'),
      "throw new Error('must not run');\nexport default defineConfig({ schema: 'db/schema' });",
    );
    assert.deepEqual(findPrismaSchemaFiles(root), [
      path.join(root, 'db', 'schema', 'a.prisma'),
      path.join(root, 'db', 'schema', 'b.prisma'),
    ]);
    fs.writeFileSync(path.join(root, 'custom.prisma'), 'model C { id Int @id }');
    fs.writeFileSync(path.join(root, 'prisma.config.ts'), 'export default defineConfig({ schema: "custom.prisma" });');
    assert.deepEqual(findPrismaSchemaFiles(root), [path.join(root, 'custom.prisma')]);
  });
});

test('package.json#prisma.schema is read before prisma.config', () => {
  withTemporaryRoot((root: string) => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ prisma: { schema: 'one.prisma' } }));
    fs.writeFileSync(path.join(root, 'one.prisma'), 'model One { id Int @id }');
    fs.writeFileSync(path.join(root, 'two.prisma'), 'model Two { id Int @id }');
    fs.writeFileSync(path.join(root, 'prisma.config.js'), "module.exports = { schema: 'two.prisma' };");
    assert.deepEqual(findPrismaSchemaFiles(root), [path.join(root, 'one.prisma')]);
  });
});

test('the missing-package note says source models are recognised at reduced precision', () => {
  for (const packageName of ['mongoose', 'sequelize', 'drizzle-orm']) {
    assert.match(formatMissingPackagesNote(packageName), /reduced precision from model definitions in the source/);
  }
  assert.match(formatMissingPackagesNote('pg'), /were skipped/);
});

test('A decorator outside the Nest injection list on a parameter does not break the fallback', () => {
  const found = fallbacks(
    `import { DataSource } from 'typeorm';
     import { InjectDataSource } from '@nestjs/typeorm';
     export class Service {
       constructor(@InjectDataSource() private readonly dataSource: DataSource) {}
       async run() { await this.dataSource.query('select 1'); }
     }`,
  );
  assert.equal(found['this.dataSource.query'], undefined);
});
