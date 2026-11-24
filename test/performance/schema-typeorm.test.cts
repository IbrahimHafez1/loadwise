import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { withProgram } from './helpers.cjs';
import { typeorm } from './fixtures/schema/orm-stubs.cjs';
import { typeormTable } from '../../lib/performance/schema/typeorm-schema.cjs';
import { coverage } from '../../lib/performance/schema/model.cjs';
import { requireColumn, requireIndex, sourceFileAt } from '../types/schema-lookups.cjs';
import type { ClassDeclaration } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.cjs';
import type { SchemaTable } from '../../lib/performance/types/schema-model.cjs';
import type { FileMap } from '../types/project-files.cjs';

const projectDirectory = '../fixtures/schema/typeorm-app/';

// Condensed from a multi-tenant TypeORM school platform: tenant base class, partial unique index,
// explicit join columns.
const entities = `import { Column, CreateDateColumn, DeleteDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn, Unique, ViewEntity } from 'typeorm';

export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at', nullable: true })
  deletedAt!: Date | null;
}

export abstract class TenantBaseEntity extends BaseEntity {
  @Index()
  @Column('uuid', { name: 'school_id' })
  schoolId!: string;
}

@Entity('schools')
export class School extends BaseEntity {
  @Column({ type: 'varchar', unique: true })
  slug!: string;
}

@Entity('academic_departments')
@Index(['schoolId', 'code'], { unique: true, where: '"deleted_at" IS NULL' })
@Unique('department_name', ['name', 'schoolId'])
export class AcademicDepartment extends TenantBaseEntity {
  @Column({ type: 'varchar', length: 32 })
  code!: string;
  @Column({ type: 'varchar', length: 128 })
  name!: string;
  @Column({ type: 'boolean', default: true })
  active!: boolean;
  @Column({ type: 'enum', enum: ['a', 'b'] })
  kind!: string;
  @Column({ type: 'uuid', name: 'head_teacher_user_id', nullable: true })
  headTeacherUserId!: string | null;
  @ManyToOne(() => School)
  @JoinColumn({ name: 'head_teacher_user_id' })
  headTeacher!: School;
  @OneToOne(() => School)
  @JoinColumn({ name: 'mirror_school_id' })
  mirror!: School;
}

@Entity()
export class StudentGrade {
  @PrimaryGeneratedColumn()
  id!: number;
  @Index('grade_student', { unique: false })
  @Column()
  studentId!: string;
}

@ViewEntity('department_counts')
export class DepartmentCount {
  @Column()
  schoolId!: string;
}
`;

type TableLookup = (name: string) => SchemaTable;
type OptionalTableLookup = (name: string) => SchemaTable | undefined;

function withEntities(callback: (table: TableLookup, find: OptionalTableLookup) => void): void {
  const files: FileMap = { [projectDirectory + 'entities.ts']: entities };
  for (const [name, contents] of Object.entries(typeorm)) files[projectDirectory + name] = contents;
  return withProgram('export {};', files, (program: ProgramAdapter) => {
    const checker = program.getTypeChecker();
    const file = sourceFileAt(program, path.resolve(__dirname, 'virtual-project', projectDirectory, 'entities.ts'));
    const classes = new Map<string, ClassDeclaration>();
    for (const declaration of file.statements.filter(ts.isClassDeclaration)) {
      assert.ok(declaration.name);
      classes.set(declaration.name.text, declaration);
    }
    const find: OptionalTableLookup = (name) => typeormTable(classes.get(name), checker);
    return callback((name) => {
      const found = find(name);
      assert.ok(found, `expected ${name} to read as a TypeORM entity`);
      return found;
    }, find);
  });
}

test('reads entity names, inherited columns and property indexes', () => {
  withEntities((table) => {
    const department = table('AcademicDepartment');
    assert.equal(department.dbName, 'academic_departments');
    assert.equal(department.orm, 'typeorm');
    assert.equal(coverage(department, 'id'), 'leading', 'inherited primary key');
    assert.equal(coverage(department, 'schoolId'), 'leading', 'inherited @Index()');
    assert.equal(requireColumn(department, 'schoolId').dbName, 'school_id');
    assert.equal(requireColumn(department, 'active').type, 'boolean');
    assert.equal(requireColumn(department, 'kind').type, 'enum');
    assert.equal(coverage(department, 'name'), 'leading', '@Unique on the class');
    assert.equal(coverage(department, 'code'), 'none', 'the partial unique index does not count');
    assert.equal(requireIndex(department, (index) => Boolean(index.predicate)).predicate, '"deleted_at" IS NULL');
    assert.equal(requireColumn(table('School'), 'slug').dbName, 'slug');
    assert.equal(coverage(table('School'), 'slug'), 'leading', '@Column({ unique: true })');
    assert.equal(table('StudentGrade').dbName, 'student_grade');
    assert.equal(coverage(table('StudentGrade'), 'studentId'), 'leading');
  });
});

test('marks join columns as foreign keys and skips views and abstract bases', () => {
  withEntities((table, find) => {
    const department = table('AcademicDepartment');
    assert.deepEqual(requireColumn(department, 'headTeacherUserId').foreignKey, {
      table: 'School',
      column: 'id',
      explicitName: true,
      property: 'headTeacher',
    });
    const mirror = requireColumn(department, 'mirror');
    assert.equal(mirror.dbName, 'mirror_school_id');
    assert.equal(coverage(department, 'mirror'), 'leading', 'one-to-one owners are unique');
    assert.equal(find('DepartmentCount'), undefined);
    assert.equal(find('TenantBaseEntity'), undefined);
  });
});
