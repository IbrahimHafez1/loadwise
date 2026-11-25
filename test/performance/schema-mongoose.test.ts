import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { withProgram } from './helpers.js';
import { mongoose } from './fixtures/schema/orm-stubs.js';
import { mongooseTableOf } from '../../lib/performance/schema/mongoose-schema.js';
import { coverage } from '../../lib/performance/schema/model.js';
import type { Expression, SourceFile } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.js';
import type { SchemaTable } from '../../lib/performance/types/schema-model.js';
import type { FileMap } from '../types/project-files.js';
import { initializerOf, requireColumn } from '../types/schema-lookups.js';

const projectDirectory = '../fixtures/schema/mongoose-app/';

// Condensed from a multi-tenant Mongoose ERP backend: field `index: true`, compound indexes,
// plugins.
const models = `import mongoose, { Schema, model } from 'mongoose';

const auditLogSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, enum: ['create', 'update'] },
    resource: String,
    email: { type: String, unique: true },
    tags: [{ type: String, index: true }],
    location: { city: String },
    archived: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditLogSchema.index({ tenantId: 1, createdAt: -1 });
auditLogSchema.index({ resource: 1, userId: 1 }, { unique: true, partialFilterExpression: { archived: false } });
auditLogSchema.index({ resource: 'text' });
export const AuditLog = mongoose.model('AuditLog', auditLogSchema);

const customerSchema = new mongoose.Schema({ name: String }, { collection: 'clients' });
customerSchema.plugin(() => undefined);
export const Customer = model('Customer', customerSchema);

export const invoiceSchema = new Schema({ number: String });
export const Invoice = model('Invoice', invoiceSchema, 'billing');
export const Lookup = mongoose.model('AuditLog');
`;

type TableLookup = (name: string) => SchemaTable;
type OptionalTableLookup = (name: string) => SchemaTable | undefined;

function withModels(callback: (table: TableLookup, find: OptionalTableLookup) => void): void {
  const files: FileMap = { [projectDirectory + 'models.ts']: models };
  for (const [name, contents] of Object.entries(mongoose)) files[projectDirectory + name] = contents;
  const main = `import { AuditLog, Customer, Invoice, Lookup } from '${projectDirectory}models';
export const references = [AuditLog, Customer, Invoice, Lookup];`;
  return withProgram(main, files, (program: ProgramAdapter, sourceFile: SourceFile) => {
    const checker = program.getTypeChecker();
    const array = initializerOf(sourceFile.statements[1]);
    assert.ok(ts.isArrayLiteralExpression(array));
    const byName = new Map<string, Expression>();
    for (const element of array.elements) {
      assert.ok(ts.isIdentifier(element));
      byName.set(element.text, element);
    }
    const find: OptionalTableLookup = (name) => mongooseTableOf(byName.get(name), checker);
    return callback((name) => {
      const found = find(name);
      assert.ok(found, `expected ${name} to read as a Mongoose model`);
      return found;
    }, find);
  });
}

test('reads field indexes, schema.index calls and timestamps', () => {
  withModels((table) => {
    const auditLog = table('AuditLog');
    assert.equal(auditLog.dialect, 'mongo');
    assert.equal(auditLog.dbName, 'auditlogs');
    assert.equal(auditLog.schemaName, 'auditLogSchema');
    assert.equal(auditLog.complete, true);
    assert.equal(coverage(auditLog, '_id'), 'leading');
    assert.equal(coverage(auditLog, 'tenantId'), 'leading');
    assert.equal(coverage(auditLog, 'createdAt'), 'non-leading');
    assert.equal(coverage(auditLog, 'email'), 'leading');
    assert.equal(coverage(auditLog, 'tags'), 'leading');
    assert.equal(coverage(auditLog, 'userId'), 'none', 'the partial index does not count');
    assert.equal(coverage(auditLog, 'resource'), 'none', 'a text index cannot serve equality');
    assert.equal(requireColumn(auditLog, 'action').type, 'enum');
    assert.equal(requireColumn(auditLog, 'archived').type, 'boolean');
    assert.equal(auditLog.columns.has('location'), false, 'nested paths are not top-level columns');
    assert.equal(auditLog.columns.has('createdAt'), true);
  });
});

test('records plugins, collection names and exported schemas', () => {
  withModels((table, find) => {
    const customer = table('Customer');
    assert.equal(customer.dbName, 'clients');
    assert.equal(customer.plugins, true);
    const invoice = table('Invoice');
    assert.equal(invoice.dbName, 'billing');
    assert.equal(invoice.complete, false, 'another module may add indexes to an exported schema');
    assert.equal(find('Lookup'), undefined, 'a model looked up by name alone is not resolved');
  });
});
