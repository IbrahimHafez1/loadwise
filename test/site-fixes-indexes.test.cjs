'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildFix, createFileCache } = require('../lib/site-fix.cjs');

const prismaSchema = `datasource db {
  provider = "postgresql"
}

model Order {
  id       String @id
  storeId  String
  note     String @default("{}") // a } in a comment
  @@map("orders")
}

model Empty {
}
`;

const entitiesSource = `import { Column, Entity } from 'typeorm';

@Entity('students')
export class Student {
  @Column()
  gradeLevel!: number;

  @Column()
  enrolledAt!: Date;
}
`;

function project(context, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-fix-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries({ 'query.ts': 'export const run = 1;\n', ...files })) {
    fs.writeFileSync(path.join(root, name), contents);
  }
  return root;
}

function finding(root, overrides) {
  const { declarationFile, declarationLine, declarationColumn, declarationMessage, ...rest } = overrides;
  return {
    ruleId: 'index-missing-filter',
    file: path.join(root, 'query.ts'),
    line: 1,
    column: 8,
    message: '',
    ...(declarationFile && {
      related: [
        {
          file: path.join(root, declarationFile),
          line: declarationLine,
          column: declarationColumn,
          message: declarationMessage,
        },
      ],
    }),
    ...rest,
  };
}

function fixOf(findingToFix) {
  return buildFix(findingToFix, createFileCache());
}

const prismaOrder = { declarationFile: 'schema.prisma', declarationLine: 5, declarationColumn: 7 };
const orderDeclared = 'Model `Order` is declared here.';
const studentDeclared = { declarationFile: 'entities.ts', declarationLine: 4, declarationColumn: 14 };

test('Prisma: the index is inserted before the closing brace with the field indentation', (context) => {
  const root = project(context, { 'schema.prisma': prismaSchema });
  const result = fixOf(
    finding(root, { ...prismaOrder, declarationMessage: orderDeclared, suggestion: '@@index([storeId, note])' }),
  );
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].line, 10);
  assert.equal(result.changes[0].before, '}');
  assert.equal(result.changes[0].after, '  @@index([storeId, note])\n}');
});

test('Prisma: a trigram index suggestion is inserted as is', (context) => {
  const root = project(context, { 'schema.prisma': prismaSchema });
  const suggestion = '@@index([note(ops: raw("gin_trgm_ops"))], type: Gin)';
  const result = fixOf(
    finding(root, {
      ...prismaOrder,
      declarationMessage: orderDeclared,
      ruleId: 'index-unusable-pattern',
      suggestion,
    }),
  );
  assert.equal(result.changes[0].after, `  ${suggestion}\n}`);
});

test('Prisma: the redundant-index cleanup is a note and the old index is untouched', (context) => {
  const root = project(context, { 'schema.prisma': prismaSchema });
  const result = fixOf(
    finding(root, {
      ...prismaOrder,
      declarationMessage: orderDeclared,
      ruleId: 'index-missing-order',
      suggestion: '@@index([storeId, note])',
      message: 'Sorts. Add it. Then drop `Order_idx`, which the new index makes redundant.',
    }),
  );
  assert.equal(result.note, 'Then drop `Order_idx`, which the new index makes redundant. (left untouched here)');
  assert.equal(result.changes.length, 1);
});

test('Prisma: CRLF files keep their line endings', (context) => {
  const root = project(context, { 'schema.prisma': prismaSchema.replace(/\n/g, '\r\n') });
  const result = fixOf(
    finding(root, { ...prismaOrder, declarationMessage: orderDeclared, suggestion: '@@index([storeId])' }),
  );
  assert.equal(result.changes[0].after, '  @@index([storeId])\n}');
});

test('Prisma: no fix for an already present index, an empty model, a moved line or an odd suggestion', (context) => {
  const root = project(context, { 'schema.prisma': prismaSchema + '' });
  const base = { ...prismaOrder, declarationMessage: orderDeclared, suggestion: '@@index([storeId])' };
  assert.equal(
    fixOf(finding(root, { ...base, declarationLine: 11, declarationMessage: 'Model `Empty` is declared here.' })),
    undefined,
  );
  assert.equal(fixOf(finding(root, { ...base, declarationLine: 6 })), undefined);
  assert.equal(fixOf(finding(root, { ...base, suggestion: 'CREATE INDEX x ON y (z);' })), undefined);
  assert.equal(fixOf(finding(root, { ...base, declarationMessage: 'Table `Order` is declared here.' })), undefined);
  const present = project(context, {
    'schema.prisma': prismaSchema.replace('  @@map', '  @@index([storeId])\n  @@map'),
  });
  assert.equal(fixOf(finding(present, base)), undefined);
});

test('TypeORM: an entity-level index goes above @Entity and Index joins the typeorm import', (context) => {
  const root = project(context, { 'entities.ts': entitiesSource });
  const result = fixOf(
    finding(root, {
      ...studentDeclared,
      declarationMessage: 'Entity `Student` is declared here.',
      suggestion: "@Index(['gradeLevel', 'enrolledAt'])",
    }),
  );
  assert.deepEqual(
    result.changes.map(({ line, before, after }) => ({ line, before, after })),
    [
      {
        line: 1,
        before: "import { Column, Entity } from 'typeorm';\n\n@Entity('students')",
        after:
          "import { Column, Entity, Index } from 'typeorm';\n\n@Index(['gradeLevel', 'enrolledAt'])\n@Entity('students')",
      },
    ],
  );
});

test('TypeORM: a property-level index goes above the property decorators', (context) => {
  const root = project(context, { 'entities.ts': entitiesSource });
  const result = fixOf(
    finding(root, {
      ...studentDeclared,
      declarationMessage: 'Entity `Student` is declared here.',
      suggestion: '@Index()',
      message: 'Add `@Index()` to the `enrolledAt` property of entity `Student` (entities.ts:4).',
    }),
  );
  assert.deepEqual(
    result.changes.map(({ line, after }) => ({ line, after })),
    [
      { line: 1, after: "import { Column, Entity, Index } from 'typeorm';" },
      { line: 8, after: '  @Index()\n  @Column()' },
    ],
  );
});

test('TypeORM: an existing Index import is reused and a multi-line import is extended on its own line', (context) => {
  const withIndex = entitiesSource.replace('Column, Entity', 'Column, Entity, Index');
  const root = project(context, { 'entities.ts': withIndex });
  const base = {
    ...studentDeclared,
    declarationMessage: 'Entity `Student` is declared here.',
    suggestion: "@Index(['gradeLevel', 'enrolledAt'])",
  };
  const reused = fixOf(finding(root, base));
  assert.equal(reused.changes.length, 1);
  assert.equal(reused.changes[0].after, "@Index(['gradeLevel', 'enrolledAt'])\n@Entity('students')");
  const multiline = project(context, {
    'entities.ts': entitiesSource.replace('{ Column, Entity }', '{\n  Column,\n  Entity,\n}'),
  });
  const result = fixOf(finding(multiline, { ...base, declarationLine: 7 }));
  assert.match(result.changes[0].after, /^ {2}Entity,\n {2}Index,\n\} from 'typeorm';/);
});

test('TypeORM: no fix without a typeorm named import, with a clashing Index name or a non-entity class', (context) => {
  const base = {
    ...studentDeclared,
    declarationMessage: 'Entity `Student` is declared here.',
    suggestion: "@Index(['gradeLevel', 'enrolledAt'])",
  };
  const noImport = project(context, {
    'entities.ts': entitiesSource.replace("import { Column, Entity } from 'typeorm';", ''),
  });
  assert.equal(fixOf(finding(noImport, { ...base, declarationLine: 3, declarationColumn: 14 })), undefined);
  const clash = project(context, {
    'entities.ts': entitiesSource.replace('\n@Entity', "\nimport { Index } from './mine';\n@Entity"),
  });
  assert.equal(fixOf(finding(clash, { ...base, declarationLine: 4 })), undefined);
  const plain = project(context, { 'entities.ts': entitiesSource.replace("@Entity('students')\n", '') });
  assert.equal(fixOf(finding(plain, { ...base, declarationLine: 3 })), undefined);
  const root = project(context, { 'entities.ts': entitiesSource });
  const missingProperty = { ...base, suggestion: '@Index()', message: 'to the `nope` property of entity `Student`' };
  assert.equal(fixOf(finding(root, missingProperty)), undefined);
  assert.equal(fixOf(finding(root, { ...base, suggestion: "CREATE INDEX CONCURRENTLY x ON y ('z');" })), undefined);
});

test('Other ORMs and raw SQL: no fix', (context) => {
  const root = project(context, { 'entities.ts': entitiesSource });
  assert.equal(
    fixOf(
      finding(root, {
        ...studentDeclared,
        declarationMessage: 'Table `students` is declared here.',
        suggestion: "index('students_idx').on(table.gradeLevel)",
      }),
    ),
    undefined,
  );
  assert.equal(
    fixOf(finding(root, { suggestion: 'CREATE INDEX CONCURRENTLY "x" ON "students" ("grade_level");' })),
    undefined,
  );
});

test('TypeORM foreign key: the index goes above the relation property, and a mismatched property gets no fix', (context) => {
  const source = `import { Entity, JoinColumn, ManyToOne } from 'typeorm';

@Entity('lessons')
export class Lesson {
  @ManyToOne(() => Student)
  @JoinColumn({ name: 'student_id' })
  student!: Student;
}
`;
  const root = project(context, { 'lesson.ts': source });
  const base = {
    ruleId: 'index-missing-foreign-key',
    file: path.join(root, 'lesson.ts'),
    line: 7,
    column: 3,
    suggestion: '@Index()',
    message: 'Add `@Index()` to the `student` property of entity `Lesson` (lesson.ts:4).',
  };
  const result = fixOf(base);
  assert.deepEqual(
    result.changes.map(({ line, after }) => ({ line, after })),
    [
      { line: 1, after: "import { Entity, JoinColumn, ManyToOne, Index } from 'typeorm';" },
      { line: 5, after: '  @Index()\n  @ManyToOne(() => Student)' },
    ],
  );
  assert.equal(fixOf({ ...base, message: base.message.replace('`student`', '`other`') }), undefined);
});
