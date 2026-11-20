'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { withProgram } = require('./helpers.cjs');
const { typeorm } = require('./fixtures/schema/orm-stubs.cjs');
const { typeormTable } = require('../lib/schema/typeorm-schema.cjs');
const { coverage } = require('../lib/schema/model.cjs');

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

function withEntities(callback) {
  const files = { [projectDirectory + 'entities.ts']: entities };
  for (const [name, contents] of Object.entries(typeorm)) files[projectDirectory + name] = contents;
  return withProgram('export {};', files, (program) => {
    const checker = program.getTypeChecker();
    const file = program.getSourceFile(path.resolve(__dirname, 'virtual-project', projectDirectory, 'entities.ts'));
    const classes = new Map(
      file.statements.filter(ts.isClassDeclaration).map((declaration) => [declaration.name.text, declaration]),
    );
    return callback((name) => typeormTable(classes.get(name), checker));
  });
}

test('reads entity names, inherited columns and property indexes', () => {
  withEntities((table) => {
    const department = table('AcademicDepartment');
    assert.equal(department.dbName, 'academic_departments');
    assert.equal(department.orm, 'typeorm');
    assert.equal(coverage(department, 'id'), 'leading', 'inherited primary key');
    assert.equal(coverage(department, 'schoolId'), 'leading', 'inherited @Index()');
    assert.equal(department.columns.get('schoolId').dbName, 'school_id');
    assert.equal(department.columns.get('active').type, 'boolean');
    assert.equal(department.columns.get('kind').type, 'enum');
    assert.equal(coverage(department, 'name'), 'leading', '@Unique on the class');
    assert.equal(coverage(department, 'code'), 'none', 'the partial unique index does not count');
    assert.equal(department.indexes.find((index) => index.predicate).predicate, '"deleted_at" IS NULL');
    assert.equal(table('School').columns.get('slug').dbName, 'slug');
    assert.equal(coverage(table('School'), 'slug'), 'leading', '@Column({ unique: true })');
    assert.equal(table('StudentGrade').dbName, 'student_grade');
    assert.equal(coverage(table('StudentGrade'), 'studentId'), 'leading');
  });
});

test('marks join columns as foreign keys and skips views and abstract bases', () => {
  withEntities((table) => {
    const department = table('AcademicDepartment');
    assert.deepEqual(department.columns.get('headTeacherUserId').foreignKey, {
      table: 'School',
      column: 'id',
      explicitName: true,
    });
    const mirror = department.columns.get('mirror');
    assert.equal(mirror.dbName, 'mirror_school_id');
    assert.equal(coverage(department, 'mirror'), 'leading', 'one-to-one owners are unique');
    assert.equal(table('DepartmentCount'), undefined);
    assert.equal(table('TenantBaseEntity'), undefined);
  });
});
