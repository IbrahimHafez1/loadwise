import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { withProgram } from './helpers.cjs';
import { sequelize } from './fixtures/schema/orm-stubs.cjs';
import { sequelizeTableOf } from '../../lib/performance/schema/sequelize-schema.cjs';
import { coverage } from '../../lib/performance/schema/model.cjs';
import type { Expression, SourceFile } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.cjs';
import type { SchemaTable } from '../../lib/performance/types/schema-model.cjs';
import type { FileMap } from '../types/project-files.cjs';
import { initializerOf, requireColumn, requireIndex } from '../types/schema-lookups.cjs';

const projectDirectory = '../fixtures/schema/sequelize-app/';

// Condensed from a sequelize-typescript POS backend: @Table({ indexes }) with a partial unique
// index, property @Index and @ForeignKey.
const models = `import { Table, Column, Model, DataType, PrimaryKey, ForeignKey, Index, Unique, AllowNull } from 'sequelize-typescript';
import { Model as PlainModel, DataTypes, Sequelize } from 'sequelize';

@Table({
  tableName: 'Categories',
  paranoid: true,
  indexes: [
    { name: 'category_market_index', fields: ['marketId'] },
    { name: 'category_name_org_market_unique', fields: ['name', 'organizationId', 'marketId'], unique: true, where: { deletedAt: null } },
    { name: 'category_search', fields: ['name'], using: 'gin', operator: 'gin_trgm_ops' },
  ],
})
export class Category extends Model<Category> {
  @PrimaryKey
  @Column(DataType.UUID)
  id!: string;

  @ForeignKey(() => Organization)
  @AllowNull(false)
  @Index
  @Column(DataType.UUID)
  organizationId!: string;

  @Column(DataType.UUID)
  marketId!: string;

  @Column(DataType.STRING)
  name!: string;

  @Column(DataType.BOOLEAN)
  isDefault!: boolean;

  @Index('category_code_branch')
  @Column({ type: DataType.STRING, field: 'category_code' })
  code!: string;

  @Index('category_code_branch')
  @Column(DataType.UUID)
  branchId!: string;

  @Unique
  @Column(DataType.STRING)
  slug!: string;
}

@Table
export class Organization extends Model<Organization> {
  @Column(DataType.STRING)
  name!: string;
}

export class Invoice extends PlainModel {}
Invoice.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    customerId: { type: DataTypes.UUID, references: { model: 'Customers', key: 'id' } },
    status: { type: DataTypes.ENUM('open', 'paid') },
  },
  { sequelize: undefined as never, tableName: 'invoices', underscored: true, indexes: [{ fields: [{ name: 'status', order: 'DESC' }] }] },
);

declare const db: Sequelize;
export const Payment = db.define('Payment', { reference: { type: DataTypes.STRING, unique: true } }, { freezeTableName: true });
export const Dynamic = db.define('Dynamic', { reference: DataTypes.STRING }, { indexes: buildIndexes() });
declare function buildIndexes(): object[];
`;

function withModels(callback: (table: (name: string) => SchemaTable) => void): void {
  const files: FileMap = { [projectDirectory + 'models.ts']: models };
  for (const [name, contents] of Object.entries(sequelize)) files[projectDirectory + name] = contents;
  const main = `import { Category, Organization, Invoice, Payment, Dynamic } from '${projectDirectory}models';
export const references = [Category, Organization, Invoice, Payment, Dynamic];`;
  return withProgram(main, files, (program: ProgramAdapter, sourceFile: SourceFile) => {
    const checker = program.getTypeChecker();
    const array = initializerOf(sourceFile.statements[1]);
    assert.ok(ts.isArrayLiteralExpression(array));
    const byName = new Map<string, Expression>();
    for (const element of array.elements) {
      assert.ok(ts.isIdentifier(element));
      byName.set(element.text, element);
    }
    return callback((name) => {
      const found = sequelizeTableOf(byName.get(name), checker);
      assert.ok(found, `expected ${name} to read as a Sequelize model`);
      return found;
    });
  });
}

test('reads @Table options, property decorators and named composite @Index groups', () => {
  withModels((table) => {
    const category = table('Category');
    assert.equal(category.dbName, 'Categories');
    assert.equal(category.complete, true);
    assert.equal(coverage(category, 'id'), 'leading');
    assert.equal(coverage(category, 'organizationId'), 'leading', 'bare @Index');
    assert.equal(coverage(category, 'marketId'), 'leading', 'indexes option');
    assert.equal(coverage(category, 'name'), 'none', 'partial unique and gin indexes do not count');
    assert.equal(coverage(category, 'code'), 'leading');
    assert.equal(coverage(category, 'branchId'), 'non-leading', 'same @Index name makes one composite');
    assert.equal(coverage(category, 'slug'), 'leading');
    assert.equal(requireColumn(category, 'code').dbName, 'category_code');
    assert.equal(requireColumn(category, 'isDefault').type, 'boolean');
    assert.equal(category.columns.has('deletedAt'), true, 'paranoid adds deletedAt');
    assert.deepEqual(requireColumn(category, 'organizationId').foreignKey, { table: 'Organization', column: 'id' });
    assert.equal(requireIndex(category, (index) => index.method === 'gin').keys[0].opclass, 'gin_trgm_ops');
  });
});

test('pluralizes default table names and adds the implicit id key', () => {
  withModels((table) => {
    const organization = table('Organization');
    assert.equal(organization.dbName, 'Organizations');
    assert.equal(coverage(organization, 'id'), 'leading');
  });
});

test('reads Model.init and sequelize.define models', () => {
  withModels((table) => {
    const invoice = table('Invoice');
    assert.equal(invoice.dbName, 'invoices');
    assert.equal(requireColumn(invoice, 'customerId').dbName, 'customer_id', 'underscored');
    assert.deepEqual(requireColumn(invoice, 'customerId').foreignKey, { table: 'Customers', column: 'id' });
    assert.equal(requireColumn(invoice, 'status').type, 'enum');
    assert.equal(coverage(invoice, 'status'), 'leading');
    const payment = table('Payment');
    assert.equal(payment.dbName, 'Payment');
    assert.equal(coverage(payment, 'reference'), 'leading');
    assert.equal(table('Dynamic').complete, false, 'computed index lists are unknown');
  });
});

test('ignores classes that are not Sequelize models', () => {
  withProgram(
    'export class Plain {}\nexport const value = Plain;',
    {},
    (program: ProgramAdapter, sourceFile: SourceFile) => {
      const reference = initializerOf(sourceFile.statements[1]);
      assert.equal(ts.isIdentifier(reference), true);
      assert.equal(sequelizeTableOf(reference, program.getTypeChecker()), undefined);
    },
  );
});
