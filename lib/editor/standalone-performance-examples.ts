// Rules whose findings come from SQL files, plans or traces rather than a TypeScript source line,
// plus the newest source rules. Each entry is a before/after pair that does not depend on the
// editor language.
import type { FixExample } from './types/fix-example.js';

const sqlExample = (before: string, after: string, note: string): FixExample => ({
  language: 'sql',
  before,
  code: after,
  note,
});
const foreignKeyBefore = 'ALTER TABLE orders ADD FOREIGN KEY (customer_id) REFERENCES customers (id);';
const foreignKeyIndex = 'CREATE INDEX CONCURRENTLY orders_customer_id_idx ON orders (customer_id);';
const foreignKeyNote = 'PostgreSQL does not index the referencing column; joins and parent deletes scan without it.';
const collectionScan: FixExample = {
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

const contractExample = (language: string, before: string, after: string, note: string): FixExample => ({
  language,
  before,
  code: after,
  note,
});

// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const standaloneExamples: Record<string, FixExample> = {
  'angular-default-change-detection': {
    language: 'typescript',
    before: "@Component({ selector: 'x' })\nclass X {}",
    code: "@Component({ selector: 'x', changeDetection: ChangeDetectionStrategy.OnPush })\nclass X {}",
    note: 'Check inputs are not mutated in place first.',
  },
  'angular-ngfor-missing-trackby': {
    language: 'typescript',
    before: '@Component({ template: \'<li *ngFor="let item of items"></li>\' })\nclass List {}',
    code: '@Component({ template: \'<li *ngFor="let item of items; trackBy: trackById"></li>\' })\nclass List { trackById(index: number, item: { id: string }) { return item.id; } }',
    note: 'Return a stable identifier from trackBy.',
  },
  'angular-subscribe-without-cleanup': {
    language: 'typescript',
    before: 'interval(1000).subscribe(tick);',
    code: 'interval(1000).pipe(takeUntilDestroyed()).subscribe(tick);',
    note: 'End the subscription with the component.',
  },
  'api-enum-value-removed': contractExample(
    'typescript',
    "type Status = 'open' | 'closed' | 'archived';",
    "type Status = 'open' | 'closed' | 'archived'; // keep accepting 'archived'",
    'Keep accepting the old value (map it to the new one) until clients stop sending it.',
  ),
  'api-removed-field': contractExample(
    'typescript',
    'class UserDto {\n  name: string;\n}',
    'class UserDto {\n  name: string;\n  /** @deprecated read name */\n  fullName?: string;\n}',
    'Deprecate a response field first and remove it after clients stop reading it.',
  ),
  'api-removed-operation': contractExample(
    'graphql',
    'type Query {\n  user(id: ID!): User\n}',
    'type Query {\n  user(id: ID!): User\n  userV2(id: ID!): User\n}',
    'Keep the old operation (or serve /v1 beside a new /v2) until no deployed client calls it.',
  ),
  'api-required-input': contractExample(
    'typescript',
    'class CreateUserDto {\n  nickname?: string;\n}',
    'class CreateUserDto {\n  nickname?: string;\n}\n// make it required only in a new API version',
    'A newly required input rejects every client that has not been updated; give it a default or version the API.',
  ),
  'api-type-changed': contractExample(
    'typescript',
    'class OrderDto {\n  total: number;\n}',
    'class OrderDto {\n  total: number;\n  totalText: string;\n}',
    'Add a new field for the new type and keep the old one until clients migrate.',
  ),
  'async-callback-unhandled-rejection': {
    language: 'javascript',
    before: 'setInterval(async () => {\n  await syncAccounts();\n}, 60_000);',
    code: 'setInterval(async () => {\n  try {\n    await syncAccounts();\n  } catch (error) { logger.error(error); }\n}, 60_000);',
    note: 'Nothing awaits a callback timers and emitters call, so its rejection is unhandled unless the callback catches it.',
  },
  'async-route-unhandled-rejection': {
    language: 'javascript',
    before: "app.get('/users', async (req, res) => {\n  res.json(await loadUsers());\n});",
    code: "app.get('/users', async (req, res, next) => {\n  try {\n    res.json(await loadUsers());\n  } catch (error) { next(error); }\n});",
    note: 'Express 4 ignores the promise a handler returns; passing the error to next reaches the error middleware.',
  },
  'await-before-early-exit': {
    language: 'javascript',
    before:
      "const user = await prisma.user.findUnique({ where: { id } });\nif (!dto.name) throw new BadRequestException('name required');",
    code: "if (!dto.name) throw new BadRequestException('name required');\nconst user = await prisma.user.findUnique({ where: { id } });",
    note: 'Run the guard before the read it does not use. Keep the order when the read is there for its own error or timing.',
  },
  'check-then-update-race': {
    language: 'typescript',
    before: 'account.balance -= amount; await account.save();',
    code: 'await Account.updateOne({ _id: id, balance: { $gte: amount } }, { $inc: { balance: -amount } });',
    note: 'Let the database apply the change atomically.',
  },
  'count-then-page-serial': {
    language: 'javascript',
    before: 'const total = await qb.getCount();\nconst rows = await qb.skip(offset).take(limit).getMany();',
    code: 'const [rows, total] = await qb.skip(offset).take(limit).getManyAndCount();',
    note: 'The page waits for the count, so one list costs two round trips. Prisma has no combined call; run both with Promise.all.',
  },
  'db-duplicate-index': sqlExample(
    'CREATE INDEX a_idx ON orders (customer_id);\nCREATE INDEX b_idx ON orders (customer_id);',
    'DROP INDEX CONCURRENTLY b_idx;',
    'Keep one of two identical indexes. An index that is a prefix of another is also redundant.',
  ),
  'db-missing-index': sqlExample(
    'SELECT id FROM orders WHERE customer_id = $1;',
    foreignKeyIndex,
    'Check that the write cost of one more index is acceptable for this table.',
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
  'db-unindexed-foreign-key': sqlExample(foreignKeyBefore, foreignKeyIndex, foreignKeyNote),
  'db-unused-index': sqlExample(
    'SELECT indexrelname FROM pg_stat_user_indexes WHERE idx_scan = 0;',
    'DROP INDEX CONCURRENTLY orders_legacy_idx;',
    'Confirm on every replica over a full business cycle, and that no constraint depends on the index.',
  ),
  'discarded-error-result': {
    language: 'javascript',
    before: 'await updateProvider();',
    code: "const result = await updateProvider();\nif (result._tag === 'Left') return result;",
    note: 'This fp-ts Either example forwards the failure to a caller that handles it. Keep the success path after the guard.',
  },
  'dom-layout-thrashing': {
    language: 'typescript',
    before: "for (const el of els) { const w = el.offsetWidth; el.style.width = w + 1 + 'px'; }",
    code: "const widths = els.map((el) => el.offsetWidth); els.forEach((el, i) => { el.style.width = widths[i] + 1 + 'px'; });",
    note: 'Batch reads before writes.',
  },
  'dom-listener-without-cleanup': {
    language: 'typescript',
    before: "window.addEventListener('online', () => sync());",
    code: "window.addEventListener('online', () => sync(), { signal: controller.signal });",
    note: 'Make the listener removable.',
  },
  'dom-unthrottled-scroll-resize': {
    language: 'typescript',
    before: "window.addEventListener('wheel', onWheel);",
    code: "window.addEventListener('wheel', onWheel, { passive: true });",
    note: 'Passive listeners, and throttle work with requestAnimationFrame.',
  },
  'duplicate-key-read': {
    language: 'javascript',
    before: 'const user = await cache.get(key);\nconst again = await cache.get(key); // same key, same request',
    code: 'const user = await cache.get(key);\n// reuse `user` for the rest of this request',
    note: 'Reuse the first result only when freshness, ordering and authorization allow it; otherwise keep the separate read.',
  },
  'express-missing-compression': {
    language: 'javascript',
    before: 'const app = express(); app.listen(3000);',
    code: "import compression from 'compression';\nconst app = express();\napp.use(compression());\napp.listen(3000);",
    note: 'Compresses JSON and HTML responses on the wire; skip if your reverse proxy already compresses responses.',
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
  'find-then-create-race': {
    language: 'javascript',
    before:
      'const found = await prisma.user.findFirst({ where: { email } });\nif (!found) await prisma.user.create({ data: { email } });',
    code: 'await prisma.user.upsert({ where: { email }, update: {}, create: { email } });',
    note: 'Needs a unique constraint on email; two requests can otherwise both find nothing and both insert. Or insert and catch P2002.',
  },
  'floating-promise': {
    language: 'javascript',
    before: 'sendWelcomeEmail(user.email);',
    code: 'await sendWelcomeEmail(user.email);\n// or, on purpose in the background:\nvoid sendWelcomeEmail(user.email).catch((error) => logger.error(error));',
    note: 'An unawaited rejection is unhandled and can stop the process. List deliberate background helpers under fireAndForget in the policy.',
  },
  'frontend-barrel-heavy-import': {
    language: 'tsx',
    before: "import _ from 'lodash';",
    code: "import debounce from 'lodash/debounce';",
    note: 'Import subpaths.',
  },
  'guard-query-per-request': {
    language: 'javascript',
    before: 'async function canActivate(context) {\n  const user = await this.users.findOne({ where: { id } });\n}',
    code: 'async function canActivate(context) {\n  const user = await this.userCache.wrap(id, () => this.users.findOne({ where: { id } }), 60_000);\n}',
    note: 'A global guard runs this query before every handler. Cache it by id with a short TTL and invalidate it when the user changes.',
  },
  'heavy-media-in-request-handler': {
    language: 'javascript',
    before: "app.post('/avatar', async (req, res) => { res.send(await sharp(req.body).resize(256).toBuffer()); });",
    code: "app.post('/avatar', async (req, res) => { await mediaQueue.add('resize', { fileId }); res.status(202).json({ queued: true }); });",
    note: 'Move CPU-intensive sharp or PDF rendering to a background worker queue to protect request latency.',
  },
  'http-call-without-timeout': {
    language: 'javascript',
    before: "const response = await fetch(url, { method: 'POST', body });",
    code: "const response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });",
    note: 'Without a timeout a hung upstream holds this request and its socket for up to 5 minutes (undici defaults). Tune the limit per API.',
  },
  'index-missing-filter': sqlExample(
    'SELECT id FROM orders WHERE status = $1;',
    'CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);',
    'Skip it for a column with very few distinct values unless the query also filters further.',
  ),
  'index-missing-foreign-key': sqlExample(foreignKeyBefore, foreignKeyIndex, foreignKeyNote),
  'index-missing-order': sqlExample(
    'SELECT id FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20;',
    'CREATE INDEX CONCURRENTLY orders_customer_created_idx ON orders (customer_id, created_at DESC);',
    'Equality columns first, then the sort column, so the index returns rows already ordered.',
  ),
  'index-redundant-prefix': sqlExample(
    'CREATE INDEX orders_tenant_idx ON orders (tenant_id);\nCREATE INDEX orders_tenant_created_idx ON orders (tenant_id, created_at);',
    'CREATE INDEX orders_tenant_created_idx ON orders (tenant_id, created_at);',
    'The composite index already serves lookups on tenant_id alone. Drop the shorter one with DROP INDEX orders_tenant_idx; in a new migration.',
  ),
  'index-unusable-expression': sqlExample(
    'SELECT id FROM users WHERE lower(email) = $1;',
    'CREATE INDEX CONCURRENTLY users_email_lower_idx ON users (lower(email));',
    'Index the exact expression the query uses, or compare the plain column.',
  ),
  'index-unusable-pattern': sqlExample(
    "SELECT id FROM users WHERE name LIKE '%smith';",
    'CREATE INDEX CONCURRENTLY users_name_trgm_idx ON users USING gin (name gin_trgm_ops);',
    'A leading wildcard defeats a btree index. A trigram index (pg_trgm extension) serves it.',
  ),
  'json-parse-unguarded': {
    language: 'javascript',
    before: 'const settings = JSON.parse(req.body.settings);',
    code: "let settings;\ntry {\n  settings = JSON.parse(req.body.settings);\n} catch {\n  return res.status(400).json({ error: 'Invalid settings' });\n}",
    note: 'Malformed input becomes a 400 instead of an unhandled throw.',
  },
  'json-roundtrip-clone': {
    language: 'javascript',
    before: 'items.map((item) => JSON.parse(JSON.stringify(item)))',
    code: 'items.map((item) => structuredClone(item))',
    note: 'structuredClone is faster and keeps Dates and Maps, which a JSON round trip drops.',
  },
  'list-count-per-request': {
    language: 'javascript',
    before: 'const [rows, total] = await Promise.all([prisma.order.findMany({ skip, take }), prisma.order.count()]);',
    code: 'const rows = await prisma.order.findMany({ skip, take: take + 1 });\nconst hasMore = rows.length > take;',
    note: 'A full count scans the table on every page. Fetch one extra row for "has more", or count once and cache it.',
  },
  'list-query-overfetch': {
    language: 'javascript',
    before: 'const posts = await prisma.post.findMany({ include: { author: { include: { team: true } } } });',
    code: 'const posts = await prisma.post.findMany({ select: { id: true, title: true, author: { select: { name: true } } } });',
    note: 'Each row drags large columns or nested relations along. Select the fields the list shows and load the rest on demand.',
  },
  'llm-call-without-max-tokens': {
    language: 'javascript',
    before: 'await openai.chat.completions.create({ model, messages });',
    code: 'await openai.chat.completions.create({ model, messages, max_completion_tokens: 1024 });',
    note: 'Without a cap a long or runaway completion is billed in full. Pick a limit the feature can justify.',
  },
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
  'migration-column-type-rewrite': sqlExample(
    'ALTER TABLE payments ALTER COLUMN amount TYPE bigint;',
    'ALTER TABLE payments ADD COLUMN amount_big bigint;\n-- backfill in batches, switch reads and writes, then drop amount',
    'A type change that is not binary compatible rewrites the table under an exclusive lock.',
  ),
  'migration-concurrent-in-transaction': sqlExample(
    'BEGIN;\nCREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);\nCOMMIT;',
    'CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status); -- no transaction',
    'Run it in its own migration with the runner transaction disabled.',
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
  'migration-index-not-concurrent': sqlExample(
    'CREATE INDEX orders_status_idx ON orders (status);',
    'CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);',
    'Plain CREATE INDEX blocks writes for the whole build. CONCURRENTLY cannot run inside a transaction.',
  ),
  'migration-missing-lock-timeout': sqlExample(
    'ALTER TABLE orders ADD COLUMN note text;',
    "SET lock_timeout = '5s';\nALTER TABLE orders ADD COLUMN note text;",
    'Without a timeout the DDL queues behind a long transaction and blocks every later query on the table.',
  ),
  'migration-mysql-lock-unspecified': sqlExample(
    'ALTER TABLE orders ADD COLUMN note TEXT;',
    'ALTER TABLE orders ADD COLUMN note TEXT, ALGORITHM=INSTANT;',
    'State ALGORITHM (and LOCK) so MySQL refuses a statement that would silently lock or copy the table.',
  ),
  'migration-mysql-table-copy': sqlExample(
    'ALTER TABLE orders MODIFY status VARCHAR(20);',
    'ALTER TABLE orders MODIFY status VARCHAR(20), ALGORITHM=INPLACE, LOCK=NONE;',
    'MySQL fails instead of copying the table if the change cannot run online; use gh-ost for those.',
  ),
  'migration-not-null-without-default': sqlExample(
    'ALTER TABLE users ADD COLUMN plan text NOT NULL;',
    "ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free';",
    'Existing rows need a value. A constant default is cheap on PostgreSQL 11 and later.',
  ),
  'migration-set-not-null-scan': sqlExample(
    'ALTER TABLE users ALTER COLUMN email SET NOT NULL;',
    'ALTER TABLE users ADD CONSTRAINT users_email_nn CHECK (email IS NOT NULL) NOT VALID;\nALTER TABLE users VALIDATE CONSTRAINT users_email_nn;\nALTER TABLE users ALTER COLUMN email SET NOT NULL;',
    'On PostgreSQL 12 and later the validated CHECK lets SET NOT NULL skip its scan. Drop the CHECK afterwards.',
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
  'migration-volatile-default': sqlExample(
    'ALTER TABLE users ADD COLUMN token uuid DEFAULT gen_random_uuid();',
    'ALTER TABLE users ADD COLUMN token uuid;\n-- backfill in batches, then:\nALTER TABLE users ALTER COLUMN token SET DEFAULT gen_random_uuid();',
    'A volatile default rewrites the whole table under an exclusive lock.',
  ),
  'mongo-collection-scan': collectionScan,
  'mongo-collection-scan-observed': collectionScan,
  'mongo-deep-skip': {
    language: 'javascript',
    before: 'orders.find(filter).sort({ _id: 1 }).skip(page * size).limit(size);',
    code: 'orders.find({ ...filter, _id: { $gt: lastSeenId } }).sort({ _id: 1 }).limit(size);',
    note: 'Keyset pagination: return the last _id with each page. It fits sequential navigation, not random page jumps.',
  },
  'mongo-disk-sort': {
    language: 'javascript',
    before: "orders.find({ status: 'open' }).sort({ createdAt: -1 });",
    code: "await orders.createIndex({ status: 1, createdAt: -1 });\norders.find({ status: 'open' }).sort({ createdAt: -1 });",
    note: 'An index in sort order lets MongoDB skip the in-memory sort. Equality fields come first in the index.',
  },
  'mongoose-aggregate-uncast-id': {
    language: 'javascript',
    before: 'await Order.aggregate([{ $match: { _id: id } }]);',
    code: 'await Order.aggregate([{ $match: { _id: new Types.ObjectId(id) } }]);',
    note: 'Mongoose does not auto-cast strings inside aggregate() pipelines; wrap string ids in Types.ObjectId.',
  },
  'mongoose-hydrate-for-to-object': {
    language: 'javascript',
    before: 'const doc = await User.findById(id); return doc.toObject();',
    code: 'return await User.findById(id).lean();',
    note: 'Using .lean() returns a plain JavaScript object directly without hydrating a Mongoose Document.',
  },
  'notification-send-in-loop': {
    language: 'javascript',
    before: 'for (const token of tokens) await messaging.send({ token, notification });',
    code: 'await messaging.sendEach(tokens.map((token) => ({ token, notification })));',
    note: 'One request per recipient multiplies latency and rate-limit use. Keep per-recipient sends only when each message is personalised.',
  },
  'orm-cartesian-include': {
    language: 'javascript',
    before:
      "repo.createQueryBuilder('u').leftJoinAndSelect('u.posts', 'p').leftJoinAndSelect('u.tags', 't').getMany();",
    code: "repo.find({ relations: ['posts', 'tags'], relationLoadStrategy: 'query' });",
    note: 'Each collection loads in its own query, so no row is repeated for every combination.',
  },
  'orm-deep-offset': {
    language: 'javascript',
    before: 'const rows = await prisma.order.findMany({ skip: Number(req.query.page) * 50, take: 50 });',
    code: "const rows = await prisma.order.findMany({ take: 50, ...(cursor && { cursor: { id: cursor }, skip: 1 }), orderBy: { id: 'asc' } });",
    note: 'A deep offset makes the database read and discard every earlier row. Page by the last seen key instead.',
  },
  'password-hash-pure-js': {
    language: 'javascript',
    before: "import { hash } from 'bcryptjs';",
    code: "import { hash } from 'bcrypt';",
    note: 'bcryptjs hashes in pure JavaScript on the main thread and blocks every request for 50-400 ms. Native bcrypt runs on the libuv threadpool with the same API and hash format; install bcrypt and @types/bcrypt.',
  },
  'password-hash-sync-in-async': {
    language: 'javascript',
    before: 'const hash = bcrypt.hashSync(password, 10);',
    code: 'const hash = await bcrypt.hash(password, 10);\nconst matches = await bcrypt.compare(password, hash);',
    note: 'The synchronous hash blocks the event loop for every other request. Keep the same cost factor.',
  },
  'payment-missing-idempotency-key': {
    language: 'typescript',
    before: 'await stripe.paymentIntents.create({ amount, currency });',
    code: 'await stripe.paymentIntents.create({ amount, currency }, { idempotencyKey: `order-${orderId}` });',
    note: 'Derive the key from a stable order or attempt id.',
  },
  'pg-deep-offset': sqlExample(
    'SELECT id FROM orders ORDER BY id LIMIT 50 OFFSET 100000;',
    'SELECT id FROM orders WHERE id > $1 ORDER BY id LIMIT 50;',
    'Keyset pagination with the last id of the previous page. Needs a unique, indexed sort key.',
  ),
  'pg-disk-sort': sqlExample(
    'SELECT * FROM events ORDER BY created_at DESC LIMIT 50;',
    'CREATE INDEX CONCURRENTLY events_created_at_idx ON events (created_at DESC);\nSELECT id, created_at FROM events ORDER BY created_at DESC LIMIT 50;',
    'An index in the requested order removes the sort. Selecting fewer columns also shrinks it.',
  ),
  'pg-sequential-scan': missingIndex,
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
  'promise-return-escapes-catch': {
    language: 'javascript',
    before: 'try {\n  return loadProfile();\n} catch (error) {\n  return respondToFailure(error);\n}',
    code: 'try {\n  return await loadProfile();\n} catch (error) {\n  return respondToFailure(error);\n}',
    note: 'Await inside the protected try block when its catch is responsible for handling the rejection.',
  },
  'queue-add-in-loop': {
    language: 'javascript',
    before: "for (const id of ids) await queue.add('render', { id });",
    code: "await queue.addBulk(ids.map((id) => ({ name: 'render', data: { id } })));",
    note: 'addBulk sends every job in one Redis call instead of one round trip per job.',
  },
  'react-component-defined-in-component': {
    language: 'tsx',
    before: 'function List() { const Row = () => <li />; return <Row />; }',
    code: 'const Row = () => <li />;\nfunction List() { return <Row />; }',
    note: 'Declare the component at module scope and pass props.',
  },
  'react-fetch-in-effect-no-abort': {
    language: 'tsx',
    before: 'useEffect(() => { fetch(url); }, [url]);',
    code: 'useEffect(() => { const controller = new AbortController(); fetch(url, { signal: controller.signal }); return () => controller.abort(); }, [url]);',
    note: 'Abort the request on cleanup.',
  },
  'react-index-as-key': {
    language: 'tsx',
    before: 'rows.map((r, i) => <li key={i}>{r.name}</li>)',
    code: 'rows.map((r) => <li key={r.id}>{r.name}</li>)',
    note: 'Use a stable id from the item.',
  },
  'react-inline-object-in-jsx-prop': {
    language: 'tsx',
    before: '<Row options={{ dense: true }} />',
    code: 'const options = { dense: true };\n<Row options={options} />',
    note: 'Hoist the object or memoise it.',
  },
  'react-missing-cleanup': {
    language: 'tsx',
    before: "useEffect(() => { window.addEventListener('resize', onResize); }, []);",
    code: "useEffect(() => { window.addEventListener('resize', onResize); return () => window.removeEventListener('resize', onResize); }, []);",
    note: 'Return a cleanup that removes what the effect added.',
  },
  'redis-command-in-loop': {
    language: 'javascript',
    before: "for (const id of ids) await redis.get('user:' + id);",
    code: "const values = await redis.mGet(ids.map((id) => 'user:' + id));",
    note: 'Use a multi-key command or a pipeline. Ignore if each command depends on the previous reply.',
  },
  'redis-incr-then-expire': {
    language: 'javascript',
    before: 'const hits = await redis.incr(key);\nif (hits === 1) await redis.expire(key, 60);',
    code: "const [[, hits]] = await redis.multi().incr(key).expire(key, 60, 'NX').exec();",
    note: 'Two round trips, and a crash between them leaves the counter with no TTL. One MULTI sends both; NX needs Redis 7+.',
  },
  'redis-keys-command': {
    language: 'javascript',
    before: "const keys = await redis.keys('session:*');",
    code: "const keys = [];\nfor await (const batch of redis.scanStream({ match: 'session:*', count: 100 })) keys.push(...batch);",
    note: 'KEYS blocks every Redis client while it walks the whole keyspace; SCAN works in small steps.',
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
  'repeated-db-span': {
    language: 'javascript',
    before: "for (const id of ids) await db.query('SELECT * FROM users WHERE id = $1', [id]);",
    code: "const { rows } = await db.query('SELECT * FROM users WHERE id = ANY($1)', [ids]);",
    note: 'Batch repeated lookups into one statement and keep the original scope predicates.',
  },
  'request-number-unvalidated': {
    language: 'javascript',
    before:
      'const page = Number(req.query.page);\nconst rows = await db.order.findMany({ skip: page * 20, take: 20 });',
    code: "const page = Number(req.query.page);\nif (!Number.isInteger(page) || page < 0) return res.status(400).json({ error: 'Invalid page' });\nconst rows = await db.order.findMany({ skip: page * 20, take: 20 });",
    note: 'NaN or a negative number reaching the query errors or returns the wrong rows; reject it first.',
  },
  'retry-without-backoff': {
    language: 'javascript',
    before: 'for (let attempt = 0; attempt < 3; attempt++) {\n  try { return await fetch(url); } catch {}\n}',
    code: 'for (let attempt = 0; attempt < 3; attempt++) {\n  try { return await fetch(url); } catch { await sleep(2 ** attempt * 100 + Math.random() * 100); }\n}',
    note: 'Waiting longer after each failure keeps retries from hammering a struggling service.',
  },
  'return-in-finally': {
    language: 'javascript',
    before: 'try {\n  return readValue();\n} finally {\n  return release();\n}',
    code: 'try {\n  return readValue();\n} finally {\n  release();\n}',
    note: 'Keep cleanup in finally so the caller receives the original return value or error.',
  },
  'return-newline': {
    language: 'javascript',
    before: 'function read() {\n  return\n    ({ value: 1 });\n}',
    code: 'function read() {\n  return { value: 1 };\n}',
    note: 'Start the expression on the same line as return to prevent automatic semicolon insertion.',
  },
  'sequential-http-in-loop': {
    language: 'typescript',
    before: 'for (const url of urls) { await fetch(url); }',
    code: 'await Promise.all(urls.map((url) => fetch(url)));',
    note: 'Bound concurrency (p-limit) for large lists or rate-limited APIs.',
  },
  'serial-awaits-in-literal': {
    language: 'javascript',
    before: 'const [posts, accounts] = [await syncPosts(), await syncAccounts()];',
    code: 'const [posts, accounts] = await Promise.all([syncPosts(), syncAccounts()]);',
    note: 'Awaits inside a literal still run one after the other, so the wait is the sum. Keep them serial if one depends on the other.',
  },
  'service-query-in-loop': {
    language: 'javascript',
    before: 'for (const id of ids) await this.approve(id); // approve() runs findOne + save',
    code: 'await this.approveMany(ids); // one In(ids) read and one bulk save',
    note: 'The helper hides queries that run once per item. Add a batch variant and keep per-item validation and transaction needs.',
  },
  'session-memory-store': {
    language: 'javascript',
    before: 'app.use(session({ secret, resave: false }));',
    code: 'app.use(session({ secret, resave: false, store: new RedisStore({ client: redisClient }) }));',
    note: 'A shared store keeps sessions across restarts and instances and does not grow process memory.',
  },
  'sql-select-star-in-query': {
    language: 'typescript',
    before: "await pool.query('SELECT * FROM orders WHERE status = $1', [s]);",
    code: "await pool.query('SELECT id, total, status FROM orders WHERE status = $1', [s]);",
    note: 'List the columns the caller uses.',
  },
  'stream-pipe-unhandled-error': {
    language: 'javascript',
    before: 'fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);',
    code: "import { pipeline } from 'node:stream/promises';\n\nawait pipeline(fs.createReadStream(file), zlib.createGzip(), res);",
    note: 'pipeline forwards an error from any stage and closes every stream; .pipe() does neither.',
  },
  'typeorm-load-then-save': {
    language: 'javascript',
    before:
      'const user = await users.findOneBy({ id });\nuser.lastLoginAt = new Date();\nuser.tokenVersion += 1;\nawait users.save(user);',
    code: "await users.increment({ id }, 'tokenVersion', 1);\nawait users.update({ id }, { lastLoginAt: new Date() });",
    note: 'save() of a loaded entity costs a SELECT, an UPDATE and a transaction. update() skips entity listeners.',
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
  'unbounded-list-query': {
    language: 'javascript',
    before: 'return prisma.order.findMany({ where: { userId } });',
    code: 'return prisma.order.findMany({ where: { userId }, orderBy: { id: "desc" }, take: 50, cursor });',
    note: 'The response grows with the table. Page the list with a stable order and cap the page size.',
  },
  'unbounded-module-cache': {
    language: 'javascript',
    before:
      'const cache = new Map();\nfunction load(id) {\n  if (!cache.has(id)) cache.set(id, read(id));\n  return cache.get(id);\n}',
    code: 'const cache = new LRUCache({ max: 5000, ttl: 60_000 });\nfunction load(id) {\n  if (!cache.has(id)) cache.set(id, read(id));\n  return cache.get(id);\n}',
    note: 'A cache keyed by request data with no eviction grows until the process runs out of memory. Cap it by size or age.',
  },
  'upload-without-size-limit': {
    language: 'javascript',
    before: "FileInterceptor('file')",
    code: "FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } })",
    note: '10 MiB is an example. Verify the endpoint’s accepted file sizes and preserve any inherited upload limits.',
  },
  'vue-v-for-missing-key': {
    language: 'typescript',
    before: "rows.map((r) => h('li', r.name))",
    code: "rows.map((r) => h('li', { key: r.id }, r.name))",
    note: 'Give each item a stable key.',
  },
  'vue-watch-missing-cleanup': {
    language: 'typescript',
    before: "onMounted(() => { window.addEventListener('resize', f); });",
    code: "onMounted(() => window.addEventListener('resize', f)); onUnmounted(() => window.removeEventListener('resize', f));",
    note: 'Pair each mount resource with unmount cleanup.',
  },
  'webhook-missing-idempotency-check': {
    language: 'typescript',
    before: "app.post('/webhooks/stripe', async (req, res) => { await Payment.create({ eventId: req.body.id }); });",
    code: "app.post('/webhooks/stripe', async (req, res) => { await ProcessedEvent.create({ eventId: req.body.id }); /* unique index rejects redelivery */ });",
    note: 'Record the event id under a unique constraint before applying the effect.',
  },
  'whole-payload-in-memory': {
    language: 'javascript',
    before: 'const body = Buffer.from(await response.arrayBuffer());\nawait writeFile(path, body);',
    code: 'await pipeline(Readable.fromWeb(response.body), createWriteStream(path));',
    note: 'Streaming keeps memory flat however large the payload is.',
  },
};

export { standaloneExamples };
