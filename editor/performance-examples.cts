import { standaloneExamples } from './standalone-performance-examples.cjs';
import type { FixExample } from './types/fix-example.cjs';

/** [code, note, language]: the note and the snippet language are optional. */
type ExampleEntry = readonly string[];

// Examples are illustrative fragments. The scanner knows the site, but cannot choose a
// business-preserving rewrite.
const examples: Record<string, ExampleEntry> = {
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
  'prisma-count-for-existence': [
    'const hasOrder = (await prisma.order.findFirst({ where, select: { id: true } })) !== null;',
    'Keep the original filter and select a small field from the actual model when you only need to know whether a row exists.',
  ],
  'typeorm-unused-count': [
    'const orders = await orderRepository.find({ where, order, skip, take });',
    'When only the rows are used, keep the original filters, ordering and pagination and choose the equivalent method that returns rows alone.',
  ],
  'drizzle-write-preflight': [
    'const [result] = await db.delete(items).where(eq(items.id, id));\nif (result.affectedRows === 0) throw new NotFoundError();',
    'For MySQL deletes, preserve the original scope and error contract. For inserts, check for a matching unique constraint and translate only its duplicate-key error.',
  ],
  'drizzle-last-insert-id': [
    'const [result] = await db.insert(orders).values(order);\nconst id = result.insertId;',
    'For one row with an auto-increment key, verify that the mysql2 result has the ID type expected by the caller.',
  ],
  'repeated-workbook-decode': [
    'const workbook = new Workbook();\nawait workbook.xlsx.load(bytes);\nconst rows = readRows(workbook);\nconst images = readImages(workbook);',
    'Share a workbook only when both readers can use the same decoded data and preserve each other’s view of the sheets.',
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
  'unbounded-promise-all': [
    "import pLimit from 'p-limit';\nconst limit = pLimit(10);\nawait Promise.all(items.map((item) => limit(() => processItem(item))));",
    'Cap concurrency with p-limit, p-map, PromisePool, or chunked batches.',
  ],
  'mongoose-missing-lean': [
    'const users = await UserModel.find({ active: true }).lean();',
    'Add .lean() on read-only queries when Document methods (.save, .markModified) are not needed.',
  ],
  'graphql-n-plus-one-resolver': [
    'const resolvers = {\n  Order: {\n    items: (order, _args, ctx) => ctx.itemsLoader.load(order.id),\n  },\n};',
    'Batch per-parent field queries through a request-scoped DataLoader.',
  ],
  'react-context-value-recreated': [
    'const value = useMemo(() => ({ user, logout }), [user, logout]);\nreturn <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;',
    'Memoize Context.Provider values so consumers do not re-render on every parent render.',
  ],
  'node-event-listener-leak': [
    "useEffect(() => {\n  window.addEventListener('resize', onResize);\n  return () => window.removeEventListener('resize', onResize);\n}, []);",
    'Remove listeners on cleanup, or use .once() / { once: true } / AbortSignal.',
  ],
  'json-stringify-in-loop': [
    'const serialized = JSON.stringify(items);\nlogger.info(serialized);',
    'Serialize once outside the loop or stream NDJSON instead of stringifying per iteration.',
  ],
};

const polyglot: Record<string, ExampleEntry> = {
  'python-copy-growing-list': [
    'python',
    'items = []\nfor value in values:\n    items.append(value)',
    'For a list with no observers depending on intermediate copies.',
  ],
  'python-sync-requests-in-async': [
    'python',
    'async def fetch(client, url):\n    return await client.get(url)',
    'For an httpx.AsyncClient or aiohttp session.',
  ],
  'python-blocking-sleep-in-async': [
    'python',
    'async def wait():\n    await asyncio.sleep(1)',
    'For code running on the asyncio event loop.',
  ],
  'python-fixed-regex-in-loop': [
    'python',
    'pattern = re.compile(r"^[0-9]+$")\nfor value in values:\n    pattern.match(value)',
    'For a constant pattern; hoist the compile out of the loop.',
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

const ormBatchReads: Record<string, string> = {
  TypeORM:
    "const { In } = require('typeorm');\nconst rows = await repository.findBy({ organizationId: authorizedOrganizationId, id: In(ids) });",
  Sequelize: 'const rows = await User.findAll({ where: { [Op.and]: [scope, { id: { [Op.in]: ids } }] } });',
  Mongoose: 'const rows = await User.find({ $and: [scope, { _id: { $in: ids } }] }).exec();',
  Knex: "const rows = await db('users').select('id', 'name').where(scope).whereIn('id', ids);",
  Kysely:
    "const rows = ids.length\n  ? await db.selectFrom('users').select(['id', 'name']).where(scope).where('id', 'in', ids).execute()\n  : [];",
};

const prismaWrites: Record<string, ExampleEntry> = {
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

function fileSystemExample(message: string): ExampleEntry | undefined {
  const method = message.match(/\bfs\.([a-zA-Z]+)Sync\b/)?.[1];
  if (!method) return;
  if (method === 'readFile') return examples['node-sync-fs-in-async'];
  if (method === 'exists')
    return [
      "const { access } = require('node:fs/promises');\ntry {\n  await access(filename);\n} catch (error) {\n  if (error.code !== 'ENOENT') throw error;\n  handleMissingFile();\n}",
      'If checking before a read or write, attempt the actual operation and handle its errors to avoid a check/use race.',
    ];
  const commonArgs: Record<string, string> = {
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
  // Descriptor-based fs methods have callback equivalents even where fs/promises requires a
  // FileHandle.
  return [
    `const { promisify } = require('node:util');\nconst ${method}Async = promisify(require('node:fs').${method});\nconst result = await ${method}Async(...originalArguments);`,
    'Preserve arguments, error handling and descriptor cleanup. Some callback APIs return multiple values via promisify.',
  ];
}

function ormExample(ruleId: string, message: string): ExampleEntry {
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

function poolExample(message: string, language: string): FixExample | undefined {
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

function specializedExample(ruleId: string, message: string, language: string): FixExample | undefined {
  switch (ruleId) {
    case 'typeorm-existence-materialization': {
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
    case 'typeorm-wide-projection': {
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
    case 'typeorm-transaction-in-loop': {
      return {
        language,
        code: 'for (const batch of batches) {\n  await dataSource.transaction(manager => writeBatch(manager, batch));\n}',
        review:
          'Consider bounded batch writes only if ordering, per-row failures and rollback behavior can be preserved.',
      };
    }
    case 'node-sync-fs-in-async':
    case 'prisma-query-in-loop': {
      const operation = message.match(/\bPrisma (create|update|delete|upsert)\(\)/)?.[1];
      const specialized: ExampleEntry | undefined =
        ruleId === 'node-sync-fs-in-async'
          ? fileSystemExample(message)
          : operation === undefined
            ? undefined
            : prismaWrites[operation];
      if (specialized) return { language, code: specialized[0], note: specialized[1] };
      return;
    }
    case 'numeric-sort-for-extreme': {
      const operator = message.includes('maximum') ? '>' : '<';
      return {
        language,
        code: `let extreme = values[0];\nfor (const value of values) {\n  if (extreme === undefined || value ${operator} extreme) extreme = value;\n}`,
        note: 'For dense finite numbers. Empty input yields undefined. If signed-zero ties matter, preserve which tied element the original sort selected.',
      };
    }
    case 'promise-combinator-serial-await': {
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
    case 'rebuild-lookup-in-loop': {
      const map = message.includes('this Map');
      return {
        language,
        code: map
          ? 'const byId = new Map(entries);\nfor (const id of ids) consume(byId.get(id));'
          : 'const allowed = new Set(allowedIds);\nfor (const id of ids) {\n  if (allowed.has(id)) consume(id);\n}',
        note: 'Reuse this lookup only while the source entries stay stable.',
      };
    }
    case 'pool-created-per-request-or-item':
      return poolExample(message, language);
  }
}

// A Mongoose finding's message names a `schema.index(...)` fix; the SQL example would point at the
// wrong database.
const mongooseIndexExamples: Record<string, FixExample> = {
  'index-missing-filter': {
    language: 'javascript',
    before: "await Order.find({ status: 'open' });",
    code: "orderSchema.index({ status: 1 }, { name: 'orders_status_idx' });",
    note: 'Skip it for a field with very few distinct values unless the query also filters further.',
  },
  'index-missing-order': {
    language: 'javascript',
    before: 'await Order.find({ customerId }).sort({ createdAt: -1 }).limit(20);',
    code: "orderSchema.index({ customerId: 1, createdAt: -1 }, { name: 'orders_customer_created_idx' });",
    note: 'Equality fields first, then the sort field, so the index returns documents already ordered.',
  },
};

function exampleFor(ruleId: string, languageId: string, message = ''): FixExample | undefined {
  if (Object.hasOwn(mongooseIndexExamples, ruleId) && message.includes('.index({'))
    return { ...mongooseIndexExamples[ruleId] };
  if (Object.hasOwn(standaloneExamples, ruleId)) return { ...standaloneExamples[ruleId] };
  if (Object.hasOwn(polyglot, ruleId)) {
    const [language, code, note] = polyglot[ruleId];
    return languageId === language ? { language, code, note } : undefined;
  }
  if (!['javascript', 'javascriptreact', 'typescript', 'typescriptreact'].includes(languageId)) return;
  const language = languageId.startsWith('typescript') ? 'typescript' : 'javascript';
  const specialized = specializedExample(ruleId, message, language);
  if (specialized) return specialized;
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

export { exampleFor };
