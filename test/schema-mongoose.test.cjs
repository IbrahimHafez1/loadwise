'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { withProgram } = require('./helpers.cjs');
const { mongoose } = require('./fixtures/schema/orm-stubs.cjs');
const { mongooseTableOf } = require('../lib/schema/mongoose-schema.cjs');
const { coverage } = require('../lib/schema/model.cjs');

const projectDirectory = '../fixtures/schema/mongoose-app/';

// Condensed from a multi-tenant Mongoose ERP backend: field `index: true`, compound indexes, plugins.
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

function withModels(callback) {
  const files = { [projectDirectory + 'models.ts']: models };
  for (const [name, contents] of Object.entries(mongoose)) files[projectDirectory + name] = contents;
  const main = `import { AuditLog, Customer, Invoice, Lookup } from '${projectDirectory}models';
export const references = [AuditLog, Customer, Invoice, Lookup];`;
  return withProgram(main, files, (program, sourceFile) => {
    const checker = program.getTypeChecker();
    const array = sourceFile.statements[1].declarationList.declarations[0].initializer;
    const byName = new Map(array.elements.map((element) => [element.text, element]));
    return callback((name) => mongooseTableOf(byName.get(name), checker));
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
    assert.equal(auditLog.columns.get('action').type, 'enum');
    assert.equal(auditLog.columns.get('archived').type, 'boolean');
    assert.equal(auditLog.columns.has('location'), false, 'nested paths are not top-level columns');
    assert.equal(auditLog.columns.has('createdAt'), true);
  });
});

test('records plugins, collection names and exported schemas', () => {
  withModels((table) => {
    const customer = table('Customer');
    assert.equal(customer.dbName, 'clients');
    assert.equal(customer.plugins, true);
    const invoice = table('Invoice');
    assert.equal(invoice.dbName, 'billing');
    assert.equal(invoice.complete, false, 'another module may add indexes to an exported schema');
    assert.equal(table('Lookup'), undefined, 'a model looked up by name alone is not resolved');
  });
});
