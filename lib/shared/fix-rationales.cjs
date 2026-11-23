// @ts-check
'use strict';

// Why an auto-fix changed the code, per rule, written about the code as it is after the fix: the comment above the
// fixed statement and the report's Why line say this, not the rule's problem text, which no longer holds there.
// A rule without an entry falls back to the first sentence of its description. A fix that removes code names what
// went and why that is safe, since nothing is left to read at that spot.
const fixRationaleByRule = {
  // Synchronous calls in async code
  'node-sync-fs-in-async': 'The async fs call lets the event loop serve other requests while the file operation runs.',
  'node-sync-compression-in-async': 'The async zlib call runs the compression off the event loop.',
  'node-sync-crypto-in-async': 'The async crypto call runs the work off the event loop.',
  'node-sync-process-in-async': 'The async child_process call does not block the event loop while the process runs.',
  'password-hash-sync-in-async':
    'The async bcrypt call hashes off the event loop, so other requests keep being served.',
  'password-hash-pure-js': 'Native bcrypt hashes off the main thread, which the pure JavaScript bcryptjs cannot.',

  // Collections
  'array-repeated-membership':
    'A Set answers each membership test in constant time, where includes scanned the whole array.',
  'array-repeated-find': 'A Map answers each lookup in constant time, where find scanned the whole array.',
  'filter-for-existence': 'some() stops at the first match and builds no filtered array.',
  'numeric-sort-for-extreme': 'A single pass finds the extreme value without sorting the whole array.',
  'reduce-copy-accumulator':
    'The accumulator is updated in place, so each step no longer copies everything gathered so far.',
  'loop-copy-accumulator':
    'The result is updated in place, so each iteration no longer copies everything gathered so far.',
  'rebuild-lookup-in-loop':
    'The lookup is built once before the loop, since its data does not change between iterations.',
  'promise-combinator-serial-await': 'The calls are passed to Promise.all unawaited, so they run concurrently.',
  'known-reads-awaited-serially':
    'Promise.all runs the independent reads concurrently, so the wait is the slowest read, not their sum.',
  'serial-awaits-in-literal':
    'Promise.all runs the independent awaits concurrently, so the wait is the slowest one, not their sum.',

  // Queries in loops and shapes
  'prisma-query-in-loop': 'One query for all the items replaces one query per loop iteration.',
  'orm-query-in-loop': 'One batched operation for all the items replaces one operation per loop iteration.',
  'pg-query-in-loop': 'One query for all the items replaces one query per loop iteration.',
  'drizzle-query-in-loop': 'One batched statement for all the items replaces one statement per loop iteration.',
  'redis-command-in-loop': 'The commands are sent together, so the loop costs one round trip instead of one per key.',
  'notification-send-in-loop': 'The messages go out in one batch call instead of one request per loop iteration.',
  'queue-add-in-loop': 'The jobs are added together, so the loop makes one queue call instead of one per item.',
  'service-query-in-loop':
    'The query runs once for all the items through a batch sibling of the helper, or the calls run a few at a time.',
  'prisma-count-materialization':
    'count() makes the database count the rows instead of loading them all to take the length.',
  'prisma-first-materialization': 'The query reads only the first row instead of loading every match.',
  'prisma-filter-materialization': 'The equality filter runs in the database, so only matching rows are loaded.',
  'prisma-top-k-materialization': 'The database sorts and returns only the top rows, so the rest are never loaded.',
  'pg-first-materialization': 'LIMIT 1 returns only the first row instead of every match.',
  'pg-count-materialization':
    'COUNT(*) makes the database count the rows instead of sending them all to be counted here.',
  'prisma-count-for-existence':
    'An existence check can stop at the first matching row, which counting every match cannot.',
  'typeorm-unused-count': 'The query skips the COUNT whose total this code never used.',
  'typeorm-existence-materialization':
    'An existence query returns a boolean, so no entity is loaded just to be tested.',
  'typeorm-wide-projection': 'The query selects only the columns that are used, so unused wide columns are not loaded.',
  'orm-count-materialization':
    'count() makes the database count the rows instead of loading them all to take the length.',
  'orm-cartesian-include':
    'Each one-to-many relation loads in its own query, so rows are not multiplied by a joined product.',
  'count-then-page-serial':
    'Promise.all runs the count and the page query concurrently, since neither needs the other result.',
  'prisma-distinct-in-memory': 'groupBy de-duplicates in the database, so only the distinct rows are returned.',
  'prisma-relation-count-in-list':
    'The counts are read only for the rows on the page, not computed over the whole related table.',
  'drizzle-last-insert-id': 'The insert result already carries the generated id, so the extra query for it is gone.',
  'drizzle-write-preflight':
    'The write reports whether it changed a row, so the separate existence check, which could race, is gone.',
  'repeated-workbook-decode': 'The workbook is decoded once and shared, instead of once per use.',
  'guard-query-per-request':
    'A cache with a TTL answers repeat lookups, so the guard no longer queries the database on every request.',

  // Indexes
  'index-missing-filter': 'The index leads with the filtered column, so the query can seek instead of scanning.',
  'index-missing-order': 'The index covers the order, so the database reads rows already sorted.',
  'index-unusable-pattern': 'The index matches the predicate as written, so the query can use it.',
  'index-unusable-expression': 'The index covers the expression, so the query can use it.',
  'index-missing-foreign-key':
    'The foreign key column is indexed, so joins and cascading deletes do not scan the table.',
  'index-redundant-prefix':
    'Removed an index whose columns are the start of a longer index, which still serves the same reads and costs one write less.',

  // Writes, transactions and connections
  'prisma-read-modify-write':
    'The database applies the change as an atomic increment, so concurrent writers add up instead of overwriting each other.',
  'prisma-dependent-writes': 'The writes run in one transaction, so they commit or roll back together.',
  'pg-dynamic-query-text': 'Values are bound as parameters, so they cannot change the SQL text.',
  'external-call-in-transaction':
    'The external call runs outside the transaction, so no connection or lock is held while it waits.',
  'pg-unreleased-checkout':
    'pool.query() checks out a connection for the one statement and releases it afterwards, so it cannot leak.',
  'pg-transaction-on-pool':
    'The transaction statements share one checked-out client, so they run on the same connection.',
  'pool-created-per-request-or-item':
    'The client or pool is created once at module scope and reused, not rebuilt per request or item.',
  'prisma-transaction-client-escape':
    'The call uses the transaction client, so it commits or rolls back with the transaction.',
  'typeorm-transaction-client-escape':
    'The write goes through the transaction manager, so it commits or rolls back with the transaction.',
  'typeorm-load-then-save': 'update() changes only the given fields in one query, without loading the entity first.',
  'prisma-scope-unverified':
    'The query is filtered by the required scope, so it reaches only rows the caller may access.',
  'drizzle-scope-unverified':
    'The query is filtered by the required scope, so it reaches only rows the caller may access.',
  'drizzle-unfiltered-write':
    'The where clause skips rows that already hold the value, so the write no longer rewrites every row.',

  // Async and error handling
  'async-route-unhandled-rejection':
    'Errors are caught and passed to next(error), so a rejection reaches the error middleware.',
  'async-callback-unhandled-rejection': 'Errors are caught and logged, so a rejection is no longer unhandled.',
  'stream-pipe-unhandled-error': 'pipeline() handles errors and cleans up both streams, which pipe() does not.',
  'promise-return-escapes-catch': 'await keeps the rejection inside the try, so its catch runs.',
  'floating-promise': 'The call is awaited, so its failure reaches the caller instead of going unseen.',
  'await-before-early-exit': 'The call now runs after the guard, so it is skipped when the guard returns or throws.',
  'json-parse-unguarded': 'Malformed input is caught and answered with 400, instead of throwing out of the handler.',
  'request-number-unvalidated':
    'The guard answers 400 for a NaN or out-of-range number before it reaches a query or calculation.',
  'json-roundtrip-clone': 'structuredClone copies the value without serializing it to text and parsing it back.',
  'return-newline': 'The value is on the return line, so return no longer ends before it.',

  // Network, limits and Redis
  'http-call-without-timeout': 'A timeout makes a stalled call fail instead of waiting indefinitely.',
  'retry-without-backoff': 'The delay between attempts gives the failing service time to recover.',
  'upload-without-size-limit': 'The size limit rejects oversized uploads before they are fully read.',
  'sequential-http-in-loop': 'Independent requests overlap instead of waiting for each other.',
  'dom-unthrottled-scroll-resize':
    'A passive or throttled listener keeps scrolling and input responsive on the main thread.',
  'angular-default-change-detection':
    'OnPush re-checks the component only when its inputs or events change, not on every event.',
  'redis-keys-command': 'SCAN walks the keyspace in small steps, so the server is not blocked the way KEYS blocks it.',
  'redis-incr-then-expire':
    'The increment and its expiry go out together in one round trip, so the key cannot be left without a TTL.',

  // Migrations
  'migration-index-not-concurrent': 'CONCURRENTLY builds the index without blocking writes to the table.',
  'migration-concurrent-in-transaction':
    'The CONCURRENTLY statement runs outside a transaction, where PostgreSQL accepts it.',
  'migration-not-null-without-default':
    'The column is added without NOT NULL (or with a default for existing rows), so the ALTER succeeds on a table that already has rows.',
  'migration-volatile-default':
    'The column is added without a volatile default and filled separately, so the table is not rewritten.',
  'migration-column-type-rewrite':
    'The change adds a new column of the new type instead of altering in place, so the table is not rewritten while it holds a lock.',
  'migration-set-not-null-scan':
    'A NOT VALID check constraint is added without scanning the table, so a later SET NOT NULL can skip its full scan once the constraint is validated.',
  'migration-constraint-not-valid':
    'NOT VALID adds the constraint without scanning the table; validation follows separately.',
  'migration-constraint-without-index':
    'The index is built first without blocking writes, and the constraint reuses it.',
  'migration-breaking-drop': 'The drop is deferred, since running code may still use what it removes.',
  'migration-breaking-rename': 'The rename is deferred, since running code may still use the old name.',
  'migration-missing-lock-timeout':
    'lock_timeout makes the migration give up instead of queueing behind long transactions and blocking others.',
  'migration-table-rewrite-command': 'REINDEX CONCURRENTLY rebuilds the index without blocking writes to the table.',
  'migration-mysql-table-copy':
    'The ALTER states ALGORITHM=INPLACE and LOCK=NONE, so MySQL refuses it instead of copying the whole table.',
  'migration-mysql-lock-unspecified':
    'The ALTER states its ALGORITHM and LOCK, so MySQL fails instead of silently taking a stronger lock or copying the table.',
  'db-unindexed-foreign-key': 'The migration indexes the foreign key columns.',
  'db-missing-index': 'The migration adds an index on the columns the query filters or sorts by.',
  'db-slow-query-plan':
    'The migration adds an index meant to let the slow statement seek instead of scanning the table.',
  'db-unused-index': 'The migration drops an index that has not been scanned, saving its write cost.',
  'db-duplicate-index': 'The migration drops an index that another index on the table covers.',

  // Security
  'nosql-operator-injection': 'The value is wrapped in $eq, so it matches literally and cannot add query operators.',
  'tls-verification-disabled': 'Certificate and hostname verification are left on, so the connection is authenticated.',
  'bcrypt-low-cost': 'The work factor is raised to the recommended minimum, making each guess costlier to attack.',
  'insecure-random-for-secret': 'A cryptographic random source makes the secret unpredictable.',
  'jwt-verify-without-algorithms': 'Listing the accepted algorithms stops a token from choosing its own.',
  'jwt-none-algorithm': 'Removed the none algorithm from the accepted list, so an unsigned token is rejected.',
  'jwt-sign-without-expiry': 'An expiry limits how long a leaked token stays valid.',
  'secret-compared-non-constant-time': 'A constant-time comparison takes the same time whatever the secret contains.',
  'cookie-missing-security-flags': 'httpOnly keeps the cookie away from browser scripts.',
  'cors-origin-regex-unanchored': 'The anchored pattern matches only the intended origins, not look-alike hosts.',
  'graphql-introspection-enabled':
    'Introspection is off in production, so the schema is not published to every client.',
  'nest-validation-without-whitelist': 'whitelist drops properties that are not in the DTO.',
  'error-stack-in-response': 'The response carries a generic message, with the stack or error object left out.',
  'database-error-in-response': 'The response carries a generic message, with the raw database error left out.',
  'template-autoescape-disabled': 'Autoescape is on, so rendered values are HTML-escaped.',

  // Maintainability
  'large-module': 'A self-contained record moved to its own module, so this file is shorter.',
  'deep-control-flow': 'The nested branch is lifted or extracted, so the control structure is shallower.',
  'high-branch-complexity': 'The branches are simplified, so the function has a lower branch complexity score.',
  'long-parameter-list': 'The parameters are grouped, so call sites name each value.',
  'duplicate-implementation': 'The duplicates share one implementation, so a change is made once.',
  'dependency-cycle': 'The shared piece moved out of the cycle, so the modules no longer import each other.',
};

module.exports = { fixRationaleByRule };
