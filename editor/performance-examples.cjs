'use strict';

// Examples are illustrative fragments. The scanner knows the site, but cannot choose a business-preserving rewrite.
const examples = {
  'known-reads-awaited-serially': [
    'const [profile, preferences] = await Promise.all([readProfile(), readPreferences()]);',
    'Use this for independent reads whose ordering, failure behavior and concurrency budget allow it.',
  ],
  'array-repeated-membership': [
    'const allowed = new Set(allowedIds);\nconst visible = rows.filter(row => allowed.has(row.id));',
    'Build the set once while allowedIds is stable.',
  ],
  'array-repeated-find': [
    'const firstById = new Map();\nfor (const row of rows) {\n  if (!firstById.has(row.id)) firstById.set(row.id, row);\n}\nconst matches = ids.map(id => firstById.get(id));',
    'For stable string IDs this preserves the first match, duplicate requests and undefined for missing IDs. Check equality semantics for other key types.',
  ],
  'reduce-copy-accumulator': [
    'const labels = [];\nfor (const row of rows) labels.push(row.label);',
    'Mutate only a fresh result whose intermediate versions are never observed.',
  ],
  'loop-copy-accumulator': [
    'const result = [];\nfor (const batch of batches) {\n  for (const item of batch) result.push(item);\n}',
    'For dense arrays, build one fresh result if nothing observes intermediate copies.',
  ],
  'filter-for-existence': [
    'const hasPending = rows.some(row => row.status === pendingStatus);',
    'Use for a pure predicate when the consumer needs only a yes/no answer.',
  ],
  'pg-query-in-loop': [
    "const { rows } = await client.query(\n  'SELECT id, name FROM users WHERE organization_id = $1 AND id = ANY($2::uuid[])',\n  [authorizedOrganizationId, ids]\n);\nconst byId = new Map(rows.map(row => [row.id, row]));\nconst matches = ids.map(id => byId.get(id));",
    'For independent reads with unique UUID keys. Preserve every original scope predicate, the transaction client, missing-row behavior and query batch limits.',
  ],
  'prisma-query-in-loop': [
    'const rows = await prisma.user.findMany({ where: { AND: [scope, { id: { in: ids } }] } });\nconst byId = new Map(rows.map(row => [row.id, row]));\nconst matches = ids.map(id => byId.get(id) ?? null);',
    'For independent findUnique-style reads on unique IDs. Keep projection, authorization scope, transaction and original missing-row behavior.',
  ],
  'drizzle-query-in-loop': [
    'const rows = ids.length\n  ? await db.select().from(users).where(and(scope, inArray(users.id, ids)))\n  : [];\nconst byId = new Map(rows.map(row => [row.id, row]));\nconst matches = ids.map(id => byId.get(id));',
    'and and inArray come from drizzle-orm. This example batches independent reads by a unique key.',
  ],
  'pg-count-materialization': [
    "const { rows } = await client.query(\n  'SELECT count(*) AS total FROM orders WHERE status = $1', [status]\n);\nconst total = BigInt(rows[0].total);",
    'PostgreSQL COUNT returns bigint. If your API returns a JavaScript number, convert only within its safe integer range.',
  ],
  'prisma-count-materialization': [
    'const total = await prisma.order.count({ where });',
    'Keep the original filters and verify that pagination or distinct rows do not change the count.',
  ],
  'pg-first-materialization': [
    "const { rows: [first] } = await client.query(\n  'SELECT id FROM orders WHERE status = $1 ORDER BY id LIMIT 1', [status]\n);",
    'Preserve the intended ordering, filters and projection. An empty result leaves first undefined.',
  ],
  'prisma-first-materialization': [
    'const first = (await prisma.order.findFirst({ where, orderBy, select })) ?? undefined;',
    'Carry over the original filters, ordering and projection. Here null is converted to match array indexing.',
  ],
  'pg-filter-materialization': [
    "const { rows } = await client.query(\n  'SELECT id, status FROM orders WHERE status = $1', [status]\n);",
    'Combine the filter with all existing predicates. Check collation and NULL handling against the JavaScript comparison.',
  ],
  'prisma-filter-materialization': [
    'const rows = await prisma.order.findMany({\n  where: { AND: [where, { status }] }, orderBy, select\n});',
    'For an unbounded read with an equivalent database equality comparison. Check collation and NULL handling.',
  ],
  'pg-top-k-materialization': [
    "const { rows } = await client.query(\n  'SELECT id, score FROM entries WHERE category = $1 ORDER BY score DESC, id ASC LIMIT $2',\n  [category, limit]\n);",
    'Use the original ordering and tie-break rule, including NULL handling. Here ties are ordered by ID.',
  ],
  'prisma-top-k-materialization': [
    "const top = await prisma.entry.findMany({\n  where, orderBy: [{ score: 'desc' }, { id: 'asc' }], take: limit, select\n});",
    'Use a nonnegative limit and preserve the previous sort direction, tie behavior and NULL handling.',
  ],
  'node-sync-fs-in-async': [
    "const { readFile } = require('node:fs/promises');\nconst contents = await readFile(filename, 'utf8');",
    'readFile example. Choose the asynchronous counterpart of the original operation and preserve its options and errors.',
  ],
  'node-sync-compression-in-async': [
    "const { promisify } = require('node:util');\nconst gzip = promisify(require('node:zlib').gzip);\nconst compressed = await gzip(contents, options);",
    'gzip example. Match the codec and options used by the synchronous operation.',
  ],
  'node-sync-crypto-in-async': [
    "const { promisify } = require('node:util');\nconst scrypt = promisify(require('node:crypto').scrypt);\nconst key = await scrypt(password, salt, keyLength, options);",
    'scrypt example. Preserve the selected algorithm and cost parameters, and bound concurrent work.',
  ],
  'node-sync-process-in-async': [
    "const { promisify } = require('node:util');\nconst execFile = promisify(require('node:child_process').execFile);\nconst { stdout } = await execFile(executable, args, options);",
    'Use a trusted executable and pass arguments separately. For streaming output use spawn and handle completion and errors.',
  ],
  'pool-created-per-request-or-item': [
    "const { Pool } = require('pg');\nconst pool = new Pool(databaseOptions); // module scope\nasync function loadOrders(status) {\n  return pool.query('SELECT id FROM orders WHERE status = $1', [status]);\n}",
    'PostgreSQL example. Share the client only across compatible credentials, endpoint and lifecycle. Close it at application shutdown.',
  ],
  'pg-unreleased-checkout': [
    "const { rows } = await pool.query('SELECT id FROM orders WHERE status = $1', [status]);",
    'For a single statement, the pool borrows and returns the client. A multi-statement transaction needs its own checked-out client.',
  ],
  'pg-transaction-on-pool': [
    "const client = await pool.connect();\ntry {\n  await client.query('BEGIN'); await updateOrders(client); await client.query('COMMIT');\n} catch (error) { await client.query('ROLLBACK'); throw error; }\nfinally { client.release(); }",
    'Send every operation in the transaction through this client; discard an unusable connection if rollback itself fails.',
  ],
  'pg-dynamic-query-text': [
    "const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [email]);",
    'Bind values as parameters. For dynamic identifiers or sort directions, choose among fixed, allowlisted SQL fragments.',
  ],
  'prisma-transaction-client-escape': [
    'await prisma.$transaction(async tx => {\n  await tx.order.create({ data: orderData });\n  await tx.auditEntry.create({ data: auditData });\n});',
    'Pass tx to any helper that participates in this transaction.',
  ],
  'prisma-read-modify-write': [
    'await prisma.counter.update({\n  where: uniqueCounterFilter, data: { value: { increment: delta } }\n});',
    'For a non-null counter and a simple addition. Conditional business rules may require a guarded update or version check.',
  ],
  'prisma-dependent-writes': [
    'await prisma.$transaction(async tx => {\n  const order = await tx.order.create({ data: orderData });\n  await tx.lineItem.create({ data: { ...lineData, orderId: order.id } });\n});',
    'Use when the writes must succeed or fail together. A nested write is another option for an existing relation.',
  ],
  'drizzle-unfiltered-write': [
    'await db.update(orders).set(changes).where(and(scope, eq(orders.id, orderId)));',
    'Use the intended filter for this operation. Confirm explicitly if a whole-table mutation is intentional.',
  ],
  'prisma-scope-unverified': [
    'const rows = await prisma.invoice.findMany({\n  where: { AND: [filter, { organizationId: currentOrganization() }] }\n});',
    'Read example. Substitute the field and trusted scope helper declared by your policy. Protected writes must also preserve ownership in their input data.',
  ],
  'drizzle-scope-unverified': [
    'const rows = await db.select().from(invoices).where(\n  and(filter, eq(invoices.organizationId, currentOrganization()))\n);',
    'Read example. Use the actual scoped property and trusted helper declared for your table. Preserve the predicate and ownership on writes.',
  ],
};

// Rules whose findings come from SQL files, plans or traces rather than a TypeScript source line, plus the
// newest source rules. Each entry is a before/after pair that does not depend on the editor language.
const sqlExample = (before, after, note) => ({ language: 'sql', before, code: after, note });
const foreignKeyBefore = 'ALTER TABLE orders ADD FOREIGN KEY (customer_id) REFERENCES customers (id);';
const foreignKeyIndex = 'CREATE INDEX CONCURRENTLY orders_customer_id_idx ON orders (customer_id);';
const foreignKeyNote = 'PostgreSQL does not index the referencing column; joins and parent deletes scan without it.';
const collectionScan = {
  language: 'javascript',
  before: "await orders.find({ status: 'open' }).toArray(); // COLLSCAN",
  code: "await orders.createIndex({ status: 1 });\nawait orders.find({ status: 'open' }).toArray(); // IXSCAN",
  note: 'Index the filtered fields and re-run explain("executionStats") to confirm an index scan.',
};
const missingIndex = sqlExample(
  'SELECT id FROM orders WHERE customer_id = $1;',
  foreignKeyIndex,
  'Index the filtered column, then re-run EXPLAIN ANALYZE to confirm an index scan.',
);

const standaloneExamples = {
  'duplicate-key-read': {
    language: 'javascript',
    before: 'const user = await cache.get(key);\nconst again = await cache.get(key); // same key, same request',
    code: 'const user = await cache.get(key);\n// reuse `user` for the rest of this request',
    note: 'Reuse the first result only when freshness, ordering and authorization allow it; otherwise keep the separate read.',
  },
  'repeated-db-span': {
    language: 'javascript',
    before: "for (const id of ids) await db.query('SELECT * FROM users WHERE id = $1', [id]);",
    code: "const { rows } = await db.query('SELECT * FROM users WHERE id = ANY($1)', [ids]);",
    note: 'Batch repeated lookups into one statement and keep the original scope predicates.',
  },
  'redis-keys-scan': {
    language: 'javascript',
    before: "const keys = await redis.keys('session:*');",
    code: "for await (const key of redis.scanIterator({ MATCH: 'session:*', COUNT: 100 })) await handle(key);",
    note: 'KEYS blocks Redis while it walks the whole keyspace; SCAN is incremental. ioredis offers scanStream.',
  },
  'redis-repeated-read': {
    language: 'javascript',
    before: "for (const id of ids) values.push(await redis.get('user:' + id));",
    code: "const values = await redis.mGet(ids.map((id) => 'user:' + id));",
    note: 'One MGET replaces one round trip per key. ioredis spells it mget; use a pipeline for HGET.',
  },
  'redis-command-in-loop': {
    language: 'javascript',
    before: "for (const id of ids) await redis.get('user:' + id);",
    code: "const values = await redis.mGet(ids.map((id) => 'user:' + id));",
    note: 'Use a multi-key command or a pipeline. Ignore if each command depends on the previous reply.',
  },
  'password-hash-sync-in-async': {
    language: 'javascript',
    before: 'const hash = bcrypt.hashSync(password, 10);',
    code: 'const hash = await bcrypt.hash(password, 10);\nconst matches = await bcrypt.compare(password, hash);',
    note: 'The synchronous hash blocks the event loop for every other request. Keep the same cost factor.',
  },
  'serial-awaits-in-literal': {
    language: 'javascript',
    before: 'const [posts, accounts] = [await syncPosts(), await syncAccounts()];',
    code: 'const [posts, accounts] = await Promise.all([syncPosts(), syncAccounts()]);',
    note: 'Awaits inside a literal still run one after the other, so the wait is the sum. Keep them serial if one depends on the other.',
  },
  'typeorm-load-then-save': {
    language: 'javascript',
    before:
      'const user = await users.findOneBy({ id });\nuser.lastLoginAt = new Date();\nuser.tokenVersion += 1;\nawait users.save(user);',
    code: "await users.increment({ id }, 'tokenVersion', 1);\nawait users.update({ id }, { lastLoginAt: new Date() });",
    note: 'save() of a loaded entity costs a SELECT, an UPDATE and a transaction. update() skips entity listeners.',
  },
  'queue-add-in-loop': {
    language: 'javascript',
    before: "for (const id of ids) await queue.add('render', { id });",
    code: "await queue.addBulk(ids.map((id) => ({ name: 'render', data: { id } })));",
    note: 'addBulk sends every job in one Redis call instead of one round trip per job.',
  },
  'prisma-distinct-in-memory': {
    language: 'javascript',
    before: "await prisma.product.findMany({ where, select: { storeId: true }, distinct: ['storeId'] });",
    code: "await prisma.product.groupBy({ by: ['storeId'], where });",
    note: 'Prisma applies distinct after reading every matching row; groupBy dedupes in SQL. Not needed with the nativeDistinct preview feature.',
  },
  'prisma-relation-count-in-list': {
    language: 'javascript',
    before: 'await prisma.brand.findMany({ take: 20, include: { _count: { select: { products: true } } } });',
    code: "const brands = await prisma.brand.findMany({ take: 20 });\nconst counts = await prisma.product.groupBy({\n  by: ['brandId'],\n  where: { brandId: { in: brands.map((brand) => brand.id) } },\n  _count: { _all: true },\n});",
    note: 'The _count join groups the whole related table, not just the page. Counting only the page ids keeps the cost tied to take.',
  },
  'guard-query-per-request': {
    language: 'javascript',
    before: 'async function canActivate(context) {\n  const user = await this.users.findOne({ where: { id } });\n}',
    code: 'async function canActivate(context) {\n  const user = await this.userCache.wrap(id, () => this.users.findOne({ where: { id } }), 60_000);\n}',
    note: 'A global guard runs this query before every handler. Cache it by id with a short TTL and invalidate it when the user changes.',
  },
  'count-then-page-serial': {
    language: 'javascript',
    before: 'const total = await qb.getCount();\nconst rows = await qb.skip(offset).take(limit).getMany();',
    code: 'const [rows, total] = await qb.skip(offset).take(limit).getManyAndCount();',
    note: 'The page waits for the count, so one list costs two round trips. Prisma has no combined call; run both with Promise.all.',
  },
  'redis-keys-command': {
    language: 'javascript',
    before: "const keys = await redis.keys('session:*');",
    code: "const keys = [];\nfor await (const batch of redis.scanStream({ match: 'session:*', count: 100 })) keys.push(...batch);",
    note: 'KEYS blocks every Redis client while it walks the whole keyspace; SCAN works in small steps.',
  },
  'service-query-in-loop': {
    language: 'javascript',
    before: 'for (const id of ids) await this.approve(id); // approve() runs findOne + save',
    code: 'await this.approveMany(ids); // one In(ids) read and one bulk save',
    note: 'The helper hides queries that run once per item. Add a batch variant and keep per-item validation and transaction needs.',
  },
  'http-call-without-timeout': {
    language: 'javascript',
    before: "const response = await fetch(url, { method: 'POST', body });",
    code: "const response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });",
    note: 'Without a timeout a hung upstream holds this request and its socket for up to 5 minutes (undici defaults). Tune the limit per API.',
  },
  'upload-without-size-limit': {
    language: 'javascript',
    before: "FileInterceptor('file')",
    code: "FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } })",
    note: 'Without a cap one large upload is buffered in full and can exhaust memory. Tune the limit per endpoint.',
  },
  'external-call-in-transaction': {
    language: 'javascript',
    before: [
      'await prisma.$transaction(async (tx) => {',
      '  await tx.order.create({ data });',
      '  await fetch(webhookUrl, { method: "POST" });',
      '});',
    ].join('\n'),
    code: [
      'await prisma.$transaction(async (tx) => {',
      '  await tx.order.create({ data });',
      '});',
      'await fetch(webhookUrl, { method: "POST" }); // after commit',
    ].join('\n'),
    note: 'The transaction holds a pool connection and its locks for the whole network call. Make the call after commit, or before the transaction when the write needs its result.',
  },
  'typeorm-transaction-client-escape': {
    language: 'javascript',
    before: [
      'await dataSource.transaction(async (manager) => {',
      '  await manager.save(order);',
      "  await this.usageRepository.increment({ organizationId }, 'orders', 1);",
      '});',
    ].join('\n'),
    code: [
      'await dataSource.transaction(async (manager) => {',
      '  await manager.save(order);',
      "  await manager.getRepository(Usage).increment({ organizationId }, 'orders', 1);",
      '});',
    ].join('\n'),
    note: 'An injected repository runs on its own pooled connection and autocommits. Use the callback manager, or pass it to helpers that write.',
  },
  'password-hash-pure-js': {
    language: 'javascript',
    before: "import { hash } from 'bcryptjs';",
    code: "import { hash } from 'bcrypt';",
    note: 'bcryptjs hashes in pure JavaScript on the main thread and blocks every request for 50-400 ms. Native bcrypt runs on the libuv threadpool with the same API and hash format; install bcrypt and @types/bcrypt.',
  },
  'mongo-collection-scan': collectionScan,
  'mongo-collection-scan-observed': collectionScan,
  'mongo-disk-sort': {
    language: 'javascript',
    before: "orders.find({ status: 'open' }).sort({ createdAt: -1 });",
    code: "await orders.createIndex({ status: 1, createdAt: -1 });\norders.find({ status: 'open' }).sort({ createdAt: -1 });",
    note: 'An index in sort order lets MongoDB skip the in-memory sort. Equality fields come first in the index.',
  },
  'mongo-deep-skip': {
    language: 'javascript',
    before: 'orders.find(filter).sort({ _id: 1 }).skip(page * size).limit(size);',
    code: 'orders.find({ ...filter, _id: { $gt: lastSeenId } }).sort({ _id: 1 }).limit(size);',
    note: 'Keyset pagination: return the last _id with each page. It fits sequential navigation, not random page jumps.',
  },
  'pg-sequential-scan': missingIndex,
  'pg-disk-sort': sqlExample(
    'SELECT * FROM events ORDER BY created_at DESC LIMIT 50;',
    'CREATE INDEX CONCURRENTLY events_created_at_idx ON events (created_at DESC);\nSELECT id, created_at FROM events ORDER BY created_at DESC LIMIT 50;',
    'An index in the requested order removes the sort. Selecting fewer columns also shrinks it.',
  ),
  'pg-deep-offset': sqlExample(
    'SELECT id FROM orders ORDER BY id LIMIT 50 OFFSET 100000;',
    'SELECT id FROM orders WHERE id > $1 ORDER BY id LIMIT 50;',
    'Keyset pagination with the last id of the previous page. Needs a unique, indexed sort key.',
  ),
  'index-missing-foreign-key': sqlExample(foreignKeyBefore, foreignKeyIndex, foreignKeyNote),
  'index-missing-filter': sqlExample(
    'SELECT id FROM orders WHERE status = $1;',
    'CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);',
    'Skip it for a column with very few distinct values unless the query also filters further.',
  ),
  'index-missing-order': sqlExample(
    'SELECT id FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20;',
    'CREATE INDEX CONCURRENTLY orders_customer_created_idx ON orders (customer_id, created_at DESC);',
    'Equality columns first, then the sort column, so the index returns rows already ordered.',
  ),
  'index-unusable-pattern': sqlExample(
    "SELECT id FROM users WHERE name LIKE '%smith';",
    'CREATE INDEX CONCURRENTLY users_name_trgm_idx ON users USING gin (name gin_trgm_ops);',
    'A leading wildcard defeats a btree index. A trigram index (pg_trgm extension) serves it.',
  ),
  'index-unusable-expression': sqlExample(
    'SELECT id FROM users WHERE lower(email) = $1;',
    'CREATE INDEX CONCURRENTLY users_email_lower_idx ON users (lower(email));',
    'Index the exact expression the query uses, or compare the plain column.',
  ),
  'migration-index-not-concurrent': sqlExample(
    'CREATE INDEX orders_status_idx ON orders (status);',
    'CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);',
    'Plain CREATE INDEX blocks writes for the whole build. CONCURRENTLY cannot run inside a transaction.',
  ),
  'migration-concurrent-in-transaction': sqlExample(
    'BEGIN;\nCREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);\nCOMMIT;',
    'CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status); -- no transaction',
    'Run it in its own migration with the runner transaction disabled.',
  ),
  'migration-not-null-without-default': sqlExample(
    'ALTER TABLE users ADD COLUMN plan text NOT NULL;',
    "ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free';",
    'Existing rows need a value. A constant default is cheap on PostgreSQL 11 and later.',
  ),
  'migration-volatile-default': sqlExample(
    'ALTER TABLE users ADD COLUMN token uuid DEFAULT gen_random_uuid();',
    'ALTER TABLE users ADD COLUMN token uuid;\n-- backfill in batches, then:\nALTER TABLE users ALTER COLUMN token SET DEFAULT gen_random_uuid();',
    'A volatile default rewrites the whole table under an exclusive lock.',
  ),
  'migration-column-type-rewrite': sqlExample(
    'ALTER TABLE payments ALTER COLUMN amount TYPE bigint;',
    'ALTER TABLE payments ADD COLUMN amount_big bigint;\n-- backfill in batches, switch reads and writes, then drop amount',
    'A type change that is not binary compatible rewrites the table under an exclusive lock.',
  ),
  'migration-set-not-null-scan': sqlExample(
    'ALTER TABLE users ALTER COLUMN email SET NOT NULL;',
    'ALTER TABLE users ADD CONSTRAINT users_email_nn CHECK (email IS NOT NULL) NOT VALID;\nALTER TABLE users VALIDATE CONSTRAINT users_email_nn;\nALTER TABLE users ALTER COLUMN email SET NOT NULL;',
    'On PostgreSQL 12 and later the validated CHECK lets SET NOT NULL skip its scan. Drop the CHECK afterwards.',
  ),
  'migration-constraint-not-valid': sqlExample(
    'ALTER TABLE orders ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id);',
    'ALTER TABLE orders ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) NOT VALID;\nALTER TABLE orders VALIDATE CONSTRAINT orders_customer_fk;',
    'NOT VALID skips the blocking scan; VALIDATE CONSTRAINT checks existing rows with a weaker lock.',
  ),
  'migration-constraint-without-index': sqlExample(
    foreignKeyBefore,
    foreignKeyIndex,
    'Index the referencing column in the same release so parent deletes and joins do not scan the table.',
  ),
  'migration-breaking-drop': sqlExample(
    'ALTER TABLE users DROP COLUMN legacy_name;',
    '-- release 1: stop reading and writing legacy_name\n-- release 2:\nALTER TABLE users DROP COLUMN legacy_name;',
    'Dropping while old application versions still run breaks them. Drop after the code no longer uses it.',
  ),
  'migration-breaking-rename': sqlExample(
    'ALTER TABLE users RENAME COLUMN name TO full_name;',
    'ALTER TABLE users ADD COLUMN full_name text;\n-- dual-write, backfill, switch reads, then drop name',
    'A rename breaks every running application version that still uses the old name.',
  ),
  'migration-missing-lock-timeout': sqlExample(
    'ALTER TABLE orders ADD COLUMN note text;',
    "SET lock_timeout = '5s';\nALTER TABLE orders ADD COLUMN note text;",
    'Without a timeout the DDL queues behind a long transaction and blocks every later query on the table.',
  ),
  'migration-table-rewrite-command': sqlExample(
    'VACUUM FULL orders;',
    'VACUUM orders; -- or pg_repack for an online rewrite',
    'VACUUM FULL and CLUSTER hold an exclusive lock while they rewrite the table.',
  ),
  'migration-unparsed': sqlExample(
    "DO $$ BEGIN EXECUTE format('CREATE INDEX ON %I (id)', tbl); END $$;",
    'CREATE INDEX CONCURRENTLY orders_id_idx ON orders (id);',
    'Plain static statements can be analyzed; dynamic SQL cannot, so it is not checked.',
  ),
  'migration-mysql-table-copy': sqlExample(
    'ALTER TABLE orders MODIFY status VARCHAR(20);',
    'ALTER TABLE orders MODIFY status VARCHAR(20), ALGORITHM=INPLACE, LOCK=NONE;',
    'MySQL fails instead of copying the table if the change cannot run online; use gh-ost for those.',
  ),
  'migration-mysql-lock-unspecified': sqlExample(
    'ALTER TABLE orders ADD COLUMN note TEXT;',
    'ALTER TABLE orders ADD COLUMN note TEXT, ALGORITHM=INSTANT;',
    'State ALGORITHM (and LOCK) so MySQL refuses a statement that would silently lock or copy the table.',
  ),
  'db-unindexed-foreign-key': sqlExample(foreignKeyBefore, foreignKeyIndex, foreignKeyNote),
  'db-unused-index': sqlExample(
    'SELECT indexrelname FROM pg_stat_user_indexes WHERE idx_scan = 0;',
    'DROP INDEX CONCURRENTLY orders_legacy_idx;',
    'Confirm on every replica over a full business cycle, and that no constraint depends on the index.',
  ),
  'db-duplicate-index': sqlExample(
    'CREATE INDEX a_idx ON orders (customer_id);\nCREATE INDEX b_idx ON orders (customer_id);',
    'DROP INDEX CONCURRENTLY b_idx;',
    'Keep one of two identical indexes. An index that is a prefix of another is also redundant.',
  ),
  'db-seq-scan-heavy-table': sqlExample(
    'SELECT relname, seq_scan, idx_scan FROM pg_stat_user_tables ORDER BY seq_scan DESC;',
    foreignKeyIndex,
    'Find the queries scanning this table (pg_stat_statements) and index their filter columns.',
  ),
  'db-slow-query-plan': sqlExample(
    'EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE customer_id = $1;',
    foreignKeyIndex,
    'Add the index the plan lacks, or rewrite the query, then compare the plan.',
  ),
  'db-missing-index': sqlExample(
    'SELECT id FROM orders WHERE customer_id = $1;',
    foreignKeyIndex,
    'Check that the write cost of one more index is acceptable for this table.',
  ),
};

const polyglot = {
  'python-copy-growing-list': [
    'python',
    'items = []\nfor value in values:\n    items.append(value)',
    'For a list with no observers depending on intermediate copies.',
  ],
  'go-fixed-regexp-in-loop': [
    'go',
    'pattern := regexp.MustCompile(`^[0-9]+$`)\nfor _, value := range values {\n    if pattern.MatchString(value) { collect(value) }\n}',
    'For a known valid constant pattern. Keep error handling if the original used regexp.Compile.',
  ],
  'java-fixed-regex-in-loop': [
    'java',
    'Pattern digits = Pattern.compile("^[0-9]+$");\nfor (String value : values) {\n    if (digits.matcher(value).matches()) collect(value);\n}',
    'Reuse the Pattern and create a matcher per input. Preserve the original matching method and flags.',
  ],
  'csharp-fixed-regex-in-loop': [
    'csharp',
    'var digits = new Regex("^[0-9]+$");\nforeach (var value in values) {\n    if (digits.IsMatch(value)) Collect(value);\n}',
    'Preserve the original options and timeout.',
  ],
  'rust-fixed-regex-in-loop': [
    'rust',
    'let digits = regex::Regex::new(r"^[0-9]+$")?;\nfor value in values {\n    if digits.is_match(value) { collect(value); }\n}',
    'This example propagates a regex construction error from the enclosing function.',
  ],
};

const ormBatchReads = {
  TypeORM:
    "const { In } = require('typeorm');\nconst rows = await repository.findBy({ organizationId: authorizedOrganizationId, id: In(ids) });",
  Sequelize: 'const rows = await User.findAll({ where: { [Op.and]: [scope, { id: { [Op.in]: ids } }] } });',
  Mongoose: 'const rows = await User.find({ $and: [scope, { _id: { $in: ids } }] }).exec();',
  Knex: "const rows = await db('users').select('id', 'name').where(scope).whereIn('id', ids);",
  Kysely:
    "const rows = ids.length\n  ? await db.selectFrom('users').select(['id', 'name']).where(scope).where('id', 'in', ids).execute()\n  : [];",
};

const prismaWrites = {
  create: [
    'await tx.order.createMany({ data: authorizedRows });',
    'For independent inserts when you only need a count. Preserve validated ownership fields and check your connector’s support.',
  ],
  update: [
    'await tx.order.updateMany({ where: { AND: [scope, { id: { in: ids } }] }, data: changes });',
    'Use when every target receives the same validated change and counts meet your return contract. Check expected affected rows in the transaction.',
  ],
  delete: [
    'await tx.order.deleteMany({ where: { AND: [scope, { id: { in: ids } }] } });',
    'For an authorized set of rows when you only need a count. Preserve missing-row behavior, referential actions and transaction scope.',
  ],
  upsert: [
    'for (const args of authorizedUpserts) {\n  await tx.order.upsert(args);\n}',
    'When upsert order, return values or per-row behavior matter, keep the individual upserts. Only substitute a connector-specific bulk upsert after verifying conflict keys and atomicity.',
  ],
};

function fileSystemExample(message) {
  const method = message.match(/\bfs\.([a-zA-Z]+)Sync\b/)?.[1];
  if (!method) return;
  if (method === 'readFile') return examples['node-sync-fs-in-async'];
  if (method === 'exists')
    return [
      "const { access } = require('node:fs/promises');\ntry {\n  await access(filename);\n} catch (error) {\n  if (error.code !== 'ENOENT') throw error;\n  handleMissingFile();\n}",
      'If checking before a read or write, attempt the actual operation and handle its errors to avoid a check/use race.',
    ];
  const commonArgs = {
    writeFile: 'filename, contents, options',
    appendFile: 'filename, contents, options',
    copyFile: 'source, destination',
    mkdir: 'directory, options',
    readdir: 'directory, options',
    rename: 'source, destination',
    stat: 'filename',
    unlink: 'filename',
  };
  if (Object.hasOwn(commonArgs, method)) {
    const assignment = method === 'stat' || method === 'readdir' ? 'const result = ' : '';
    return [
      `const { ${method} } = require('node:fs/promises');\n${assignment}await ${method}(${commonArgs[method]});`,
      'Keep the original paths, options, error handling and ordering.',
    ];
  }
  if (method === 'glob')
    return [
      "const { glob } = require('node:fs/promises');\nconst matches = [];\nfor await (const name of glob(pattern, options)) matches.push(name);",
    ];
  if (method === 'mkdtempDisposable')
    return [
      "const { mkdtempDisposable } = require('node:fs/promises');\nconst temp = await mkdtempDisposable(prefix);\ntry {\n  await useDirectory(temp.path);\n} finally {\n  await temp.remove();\n}",
    ];
  // Descriptor-based fs methods have callback equivalents even where fs/promises requires a FileHandle.
  return [
    `const { promisify } = require('node:util');\nconst ${method}Async = promisify(require('node:fs').${method});\nconst result = await ${method}Async(...originalArguments);`,
    'Preserve arguments, error handling and descriptor cleanup. Some callback APIs return multiple values via promisify.',
  ];
}

function ormExample(ruleId, message) {
  if (ruleId === 'orm-query-in-loop') {
    const owner = Object.keys(ormBatchReads).find((name) => message.startsWith(name)) ?? 'TypeORM';
    return [
      ormBatchReads[owner],
      owner +
        ' example for independent reads by a unique key. Keep all original authorization predicates and transaction scope. Map results to the original key order if needed.',
    ];
  }
  if (message.includes('Repository.countBy')) return ['const count = await repository.countBy(where);'];
  if (message.includes('Repository.count')) return ['const count = await repository.count({ where });'];
  if (message.includes('Model.countDocuments')) return ['const count = await Model.countDocuments(filter).exec();'];
  if (message.includes('Model.count()')) return ['const count = await Model.count({ where });'];
  return [
    'SELECT COUNT(*) AS total FROM orders WHERE status = ?;',
    'Parameterized SQL shape. Use your query builder’s count aggregate and binding syntax. Preserve filters, scopes and the expected numeric result type.',
    'sql',
  ];
}

function exampleFor(ruleId, languageId, message = '') {
  if (Object.hasOwn(standaloneExamples, ruleId)) return { ...standaloneExamples[ruleId] };
  if (Object.hasOwn(polyglot, ruleId)) {
    const [language, code, note] = polyglot[ruleId];
    return languageId === language ? { language, code, note } : undefined;
  }
  if (!['javascript', 'javascriptreact', 'typescript', 'typescriptreact'].includes(languageId)) return;
  const language = languageId.startsWith('typescript') ? 'typescript' : 'javascript';
  if (ruleId === 'typeorm-existence-materialization') {
    const method = message.includes('Repository.existsBy()') ? 'existsBy' : 'exists';
    return {
      language,
      code:
        method === 'exists'
          ? 'const found = await repository.exists({ where });'
          : 'const found = await repository.existsBy(where);',
      note: 'Keep every original predicate. This is appropriate when only existence matters and entity loading has no required side effects.',
    };
  }
  if (ruleId === 'typeorm-wide-projection') {
    const select = /Consider (select: \{ [\w$, :]+ \}) to avoid/.exec(message)?.[1];
    return {
      language,
      code: 'const rows = await repository.find({ ...options, ' + (select ?? 'select: selectedColumns') + ' });',
      inline: select
        ? 'Consider ' + select + ' after checking subscribers.'
        : 'Review: select only the mapped columns after checking subscribers.',
      note: 'Preserve the original options and output mapping. Check subscribers and loaders before returning partially loaded entities.',
    };
  }
  if (ruleId === 'typeorm-transaction-in-loop') {
    return {
      language,
      code: 'for (const batch of batches) {\n  await dataSource.transaction(manager => writeBatch(manager, batch));\n}',
      review:
        'Consider bounded batch writes only if ordering, per-row failures and rollback behavior can be preserved.',
    };
  }
  if (ruleId === 'node-sync-fs-in-async' || ruleId === 'prisma-query-in-loop') {
    const operation = message.match(/\bPrisma (create|update|delete|upsert)\(\)/)?.[1];
    const specialized = ruleId === 'node-sync-fs-in-async' ? fileSystemExample(message) : prismaWrites[operation];
    if (specialized) return { language, code: specialized[0], note: specialized[1] };
  }
  if (ruleId === 'numeric-sort-for-extreme') {
    const operator = message.includes('maximum') ? '>' : '<';
    return {
      language,
      code: `let extreme = values[0];\nfor (const value of values) {\n  if (extreme === undefined || value ${operator} extreme) extreme = value;\n}`,
      note: 'For dense finite numbers. Empty input yields undefined. If signed-zero ties matter, preserve which tied element the original sort selected.',
    };
  }
  if (ruleId === 'promise-combinator-serial-await') {
    const method = message.includes('allSettled') ? 'allSettled' : 'all';
    return {
      language,
      code: `const results = await Promise.${method}([loadProfile(), loadSettings()]);`,
      note:
        method === 'allSettled'
          ? 'For independent operations when callers expect a settlement record for each result, including rejected ones.'
          : 'Start independent calls together only when later work may still run after an earlier failure.',
    };
  }
  if (ruleId === 'rebuild-lookup-in-loop') {
    const map = message.includes('this Map');
    return {
      language,
      code: map
        ? 'const byId = new Map(entries);\nfor (const id of ids) consume(byId.get(id));'
        : 'const allowed = new Set(allowedIds);\nfor (const id of ids) {\n  if (allowed.has(id)) consume(id);\n}',
      note: 'Reuse this lookup only while the source entries stay stable.',
    };
  }
  if (ruleId === 'pool-created-per-request-or-item') {
    const note =
      'Create one client at application startup per compatible endpoint and credential set. Close it during shutdown.';
    if (message.includes('PrismaClient'))
      return {
        language,
        code: 'const prisma = new PrismaClient(options); // module scope\nasync function findOrder(id) {\n  return prisma.order.findUnique({ where: { id } });\n}',
        note,
      };
    if (message.includes('MongoClient'))
      return {
        language,
        code: 'const mongo = new MongoClient(uri);\nawait mongo.connect(); // startup\nconst orders = mongo.db(databaseName).collection(collectionName);',
        note,
      };
    if (message.includes('createClient'))
      return {
        language,
        code: "const redis = createClient(options);\nredis.on('error', handleRedisError);\nawait redis.connect(); // startup",
        note,
      };
  }
  const example =
    ruleId === 'orm-query-in-loop' || ruleId === 'orm-count-materialization'
      ? ormExample(ruleId, message)
      : Object.hasOwn(examples, ruleId) && examples[ruleId];
  if (example) {
    const [code, note, snippetLanguage = language] = example;
    if (ruleId === 'orm-query-in-loop')
      return {
        language: snippetLanguage,
        code,
        note,
        inline: 'Review: batch independent reads by key while preserving filters, order and transaction scope.',
      };
    return { language: snippetLanguage, code, note };
  }
}

module.exports = { exampleFor };
