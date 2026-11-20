'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  parsePrismaSchema,
  findPrismaSchemaFiles,
  loadPrismaSchema,
} = require('../../lib/performance/schema/prisma-schema.cjs');
const { coverage, patternIndex } = require('../../lib/performance/schema/model.cjs');

const shopRoot = path.join(__dirname, 'fixtures', 'schema', 'prisma-shop');
// Generous enough for a slow CI machine; the parser takes a few milliseconds on a 2,400-line schema.
const parseBudgetMilliseconds = 500;

function parse(text) {
  return parsePrismaSchema([{ file: 'schema.prisma', text }]);
}

test('reads the datasource, mapped names, unique fields and block indexes', () => {
  const schema = loadPrismaSchema(shopRoot);
  assert.equal(schema.dialect, 'postgres');
  const user = schema.models.get('User');
  assert.equal(user.dbName, 'user');
  assert.equal(user.line, 12);
  assert.equal(coverage(user, 'id'), 'leading');
  assert.equal(coverage(user, 'email'), 'leading', '@unique counts');
  assert.equal(coverage(user, 'role'), 'leading');
  assert.equal(coverage(user, 'name'), 'none', 'a Gin trigram index cannot serve equality');
  assert.equal(patternIndex(user, 'name'), true);
  assert.equal(user.columns.get('active').type, 'Boolean');
  const product = schema.models.get('Product');
  assert.equal(product.columns.get('createdAt').dbName, 'created_at');
  assert.equal(coverage(product, 'storeId'), 'leading', '@@unique counts');
  assert.equal(coverage(product, 'isActive'), 'non-leading');
  assert.equal(patternIndex(product, 'description'), false);
});

test('records relation scalars as foreign keys and enum columns by kind', () => {
  const schema = loadPrismaSchema(shopRoot);
  const order = schema.models.get('Order');
  assert.deepEqual(order.columns.get('customerId').foreignKey, { table: 'User', column: 'id', position: 0 });
  assert.equal(order.columns.get('status').type, 'enum');
  assert.equal(order.columns.has('customer'), false, 'relation fields are not columns');
  const sorted = order.indexes.find((index) => index.keys.length === 3);
  assert.deepEqual(sorted.keys, [{ column: 'storeId' }, { column: 'createdAt', direction: 'desc' }, { column: 'id' }]);
  assert.equal(order.indexes.find((index) => index.method === 'hash').keys[0].column, 'couponCode');
  assert.equal(schema.views.has('OrderSummary'), true);
  assert.equal(schema.models.has('OrderSummary'), false, 'views are never treated as tables');
});

test('joins multi-line attributes, skips comments and reads partial and named indexes', () => {
  const schema = parse(`datasource db {
  provider = "mysql" // comment with "quotes"
}
model Post {
  id       Int    @id
  authorId Int    @map("author_id")
  title    String // @unique in a comment is ignored
  body     Unsupported("tsvector")?
  @@index([
    authorId,
    title(length: 20)
  ], map: "post_author_title")
  @@index([title], where: raw("\\"authorId\\" IS NOT NULL"))
  @@ignore
}
model Tag {
  name String
  slug String
  @@id([name, slug])
}`);
  assert.equal(schema.dialect, 'mysql');
  assert.equal(schema.models.has('Post'), false, '@@ignore models are skipped');
  const tag = schema.models.get('Tag');
  assert.equal(coverage(tag, 'name'), 'leading');
  assert.equal(coverage(tag, 'slug'), 'non-leading');
  const post = parse(`model Post {
  id       Int    @id
  authorId Int    @map("author_id")
  title    String // @unique in a comment is ignored
  @@index([
    authorId,
    title(length: 20)
  ], map: "post_author_title")
  @@index([title], where: raw("\\"authorId\\" IS NOT NULL"))
}`).models.get('Post');
  assert.equal(post.columns.get('authorId').dbName, 'author_id');
  assert.equal(post.indexes.length, 3);
  assert.equal(post.indexes[1].name, 'post_author_title');
  assert.equal(post.indexes[1].line, 5);
  assert.equal(post.indexes[2].predicate, '"authorId" IS NOT NULL');
  assert.equal(coverage(post, 'title'), 'non-leading', 'partial indexes do not count');
});

test('finds package.json#prisma.schema and multi-file schema folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-schema-'));
  try {
    fs.mkdirSync(path.join(root, 'prisma', 'schema', 'models'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(
      path.join(root, 'prisma', 'schema', 'main.prisma'),
      'datasource db {\n  provider = "postgresql"\n}\n',
    );
    fs.writeFileSync(path.join(root, 'prisma', 'schema', 'models', 'user.prisma'), 'model User {\n  id Int @id\n}\n');
    assert.equal(findPrismaSchemaFiles(root).length, 2);
    const schema = loadPrismaSchema(root);
    assert.equal(schema.dialect, 'postgres', 'the datasource in another file applies');
    assert.equal(schema.models.get('User').file, path.join(root, 'prisma', 'schema', 'models', 'user.prisma'));
    fs.mkdirSync(path.join(root, 'db'));
    fs.writeFileSync(path.join(root, 'db', 'custom.prisma'), 'model Custom {\n  id Int @id\n}\n');
    fs.writeFileSync(path.join(root, 'package.json'), '{"prisma":{"schema":"db/custom.prisma"}}');
    assert.deepEqual(findPrismaSchemaFiles(root), [path.join(root, 'db', 'custom.prisma')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(loadPrismaSchema(path.join(__dirname, 'fixtures', 'sql')), undefined);
});

test('parses a 2,400-line schema within the time budget', () => {
  const models = [];
  for (let model = 0; model < 120; model++) {
    const fields = [];
    for (let field = 0; field < 14; field++) fields.push(`  field${field} String @map("field_${field}") // note`);
    models.push(`model Model${model} {
  id        String   @id @default(cuid())
  ownerId   String
  owner     Model${(model + 1) % 120} @relation("Link${model}", fields: [ownerId], references: [id])
${fields.join('\n')}
  @@index([ownerId, field1(sort: Desc)])
  @@unique([field2, field3])
}`);
  }
  const text = 'datasource db {\n  provider = "postgresql"\n}\n' + models.join('\n');
  assert.ok(text.split('\n').length >= 2400);
  const started = performance.now();
  const schema = parse(text);
  const elapsed = performance.now() - started;
  assert.equal(schema.models.size, 120);
  assert.ok(elapsed < parseBudgetMilliseconds, `parsed in ${elapsed.toFixed(1)} ms`);
});
