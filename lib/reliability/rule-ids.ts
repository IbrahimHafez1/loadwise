import type { ImpactLevel } from '../shared/types.js';

// Rules about code that crashes, loses data or silently misbehaves at runtime: unhandled async failures, error
// handling, races and integrity, external-call resilience, migration lock and outage risks, and breaking API changes.
// The source rules are reported by the shared TypeScript pass; migrations and contracts by their own subcommands.
// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const sourceRules = [
  'assignment-in-condition',
  'async-callback-unhandled-rejection',
  'async-route-unhandled-rejection',
  'browser-not-closed',
  'check-then-update-race',
  'child-process-without-error-listener',
  'discarded-error-result',
  'drizzle-unfiltered-write',
  'drizzle-write-preflight',
  'error-logged-without-stack',
  'error-rethrown-without-cause',
  'file-handle-not-closed',
  'find-then-create-race',
  'floating-promise',
  'http-call-without-timeout',
  'interval-not-cleared',
  'invalid-typeof-comparison',
  'json-parse-unguarded',
  'loop-index-past-length',
  'mongoose-aggregate-uncast-id',
  'nan-comparison',
  'next-server-env-in-client',
  'payment-missing-idempotency-key',
  'pg-transaction-on-pool',
  'pool-without-connection-timeout',
  'prisma-dependent-writes',
  'prisma-read-modify-write',
  'prisma-transaction-client-escape',
  'promise-return-escapes-catch',
  'query-runner-not-released',
  'react-async-effect-callback',
  'react-effect-sets-state-every-render',
  'react-list-missing-key',
  'react-state-mutated-in-place',
  'redis-incr-then-expire',
  'request-number-unvalidated',
  'retry-without-backoff',
  'return-in-finally',
  'return-newline',
  'sql-insert-truncated-at-semicolon',
  'stream-pipe-unhandled-error',
  'swallowed-error',
  'switch-not-exhaustive',
  'throw-non-error',
  'typeorm-transaction-client-escape',
  'unbounded-promise-all',
  'uncaught-exception-continues',
  'unguarded-boundary-access',
  'unreachable-code',
  'upload-without-size-limit',
  'webhook-missing-idempotency-check',
];

// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const migrationRules = [
  'migration-breaking-drop',
  'migration-breaking-rename',
  'migration-column-type-rewrite',
  'migration-concurrent-in-transaction',
  'migration-constraint-not-valid',
  'migration-constraint-without-index',
  'migration-index-not-concurrent',
  'migration-missing-lock-timeout',
  'migration-mysql-lock-unspecified',
  'migration-mysql-table-copy',
  'migration-not-null-without-default',
  'migration-set-not-null-scan',
  'migration-table-rewrite-command',
  'migration-unparsed',
  'migration-volatile-default',
];

// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const contractRules = [
  'api-enum-value-removed',
  'api-removed-field',
  'api-removed-operation',
  'api-required-input',
  'api-type-changed',
];

// Rules the ast-grep polyglot scan reports from polyglot/reliability.
// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const polyglotRules = [
  'csharp-async-void',
  'csharp-disposable-without-using',
  'go-defer-before-error-check',
  'go-error-discarded',
  'java-resource-without-try',
  'python-bare-except',
  'python-swallowed-exception',
  'rust-unwrap-in-production',
];

// One --ignore list is shared by every command, so a CI script can pass the same flags to each of them.
const knownRules = new Set([...sourceRules, ...migrationRules, ...contractRules]);

// Impact levels (see lib/shared/impact-levels.ts) for every rule id a reliability finding can carry. README criteria:
// critical is data loss, an outage or a lock risk in production; high a crash, lost failure or race that a normal
// request can hit; medium a failure that needs an unusual input or condition; low a hygiene issue.
// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const impactByRule: Readonly<Record<string, ImpactLevel>> = {
  'api-enum-value-removed': 'high',
  'api-removed-field': 'high',
  'api-removed-operation': 'critical',
  'api-required-input': 'high',
  'api-type-changed': 'high',
  'assignment-in-condition': 'high',
  'async-callback-unhandled-rejection': 'high',
  'async-route-unhandled-rejection': 'high',
  'browser-not-closed': 'high',
  'check-then-update-race': 'high',
  'child-process-without-error-listener': 'high',
  'csharp-async-void': 'high',
  'csharp-disposable-without-using': 'medium',
  'discarded-error-result': 'high',
  'drizzle-unfiltered-write': 'critical',
  'drizzle-write-preflight': 'medium',
  'error-logged-without-stack': 'low',
  'error-rethrown-without-cause': 'low',
  'file-handle-not-closed': 'high',
  'find-then-create-race': 'high',
  'floating-promise': 'high',
  'go-defer-before-error-check': 'high',
  'go-error-discarded': 'high',
  'http-call-without-timeout': 'high',
  'interval-not-cleared': 'medium',
  'invalid-typeof-comparison': 'high',
  'java-resource-without-try': 'high',
  'json-parse-unguarded': 'medium',
  'loop-index-past-length': 'high',
  'migration-breaking-drop': 'critical',
  'migration-breaking-rename': 'high',
  'migration-column-type-rewrite': 'critical',
  'migration-concurrent-in-transaction': 'high',
  'migration-constraint-not-valid': 'high',
  'migration-constraint-without-index': 'high',
  'migration-index-not-concurrent': 'critical',
  'migration-missing-lock-timeout': 'high',
  'migration-mysql-lock-unspecified': 'high',
  'migration-mysql-table-copy': 'critical',
  'migration-not-null-without-default': 'high',
  'migration-set-not-null-scan': 'high',
  'migration-table-rewrite-command': 'critical',
  'migration-unparsed': 'low',
  'migration-volatile-default': 'high',
  'mongoose-aggregate-uncast-id': 'high',
  'nan-comparison': 'high',
  'next-server-env-in-client': 'high',
  'payment-missing-idempotency-key': 'high',
  'pg-transaction-on-pool': 'critical',
  'pool-without-connection-timeout': 'medium',
  'prisma-dependent-writes': 'high',
  'prisma-read-modify-write': 'critical',
  'prisma-transaction-client-escape': 'critical',
  'promise-return-escapes-catch': 'high',
  'python-bare-except': 'medium',
  'python-swallowed-exception': 'medium',
  'query-runner-not-released': 'critical',
  'react-async-effect-callback': 'medium',
  'react-effect-sets-state-every-render': 'high',
  'react-list-missing-key': 'medium',
  'react-state-mutated-in-place': 'high',
  'redis-incr-then-expire': 'medium',
  'request-number-unvalidated': 'medium',
  'retry-without-backoff': 'medium',
  'return-in-finally': 'high',
  'return-newline': 'high',
  'rust-unwrap-in-production': 'medium',
  'sql-insert-truncated-at-semicolon': 'high',
  'stream-pipe-unhandled-error': 'high',
  'swallowed-error': 'medium',
  'switch-not-exhaustive': 'medium',
  'throw-non-error': 'medium',
  'typeorm-transaction-client-escape': 'critical',
  'unbounded-promise-all': 'high',
  'uncaught-exception-continues': 'high',
  'unguarded-boundary-access': 'medium',
  'unreachable-code': 'medium',
  'upload-without-size-limit': 'high',
  'webhook-missing-idempotency-check': 'medium',
};

// One-line summaries of every rule above, used where a rule needs a fixed name (SARIF shortDescription) rather than
// the per-site finding message. The README row for each rule has the full evidence.
// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const descriptionByRule: Readonly<Record<string, string>> = {
  'api-enum-value-removed': 'An enum value or string-literal option that clients could send was removed.',
  'api-removed-field':
    'A response field, GraphQL type, field, argument or union member, or returned DTO property was removed.',
  'api-removed-operation': 'An OpenAPI operation or a GraphQL Query, Mutation or Subscription field was removed.',
  'api-required-input': 'A request field, parameter or GraphQL argument is new and required, or became required.',
  'api-type-changed':
    'A field or parameter changed type, or a GraphQL type changed nullability in a breaking direction.',
  'assignment-in-condition': 'A condition assigns with = where a comparison was probably meant.',
  'async-callback-unhandled-rejection':
    'An async callback given to an event emitter, timer or scheduler has no error handling, so a rejection is unhandled.',
  'async-route-unhandled-rejection':
    'An Express 4 async route handler has no error handling, so a rejection never reaches the error middleware.',
  'browser-not-closed':
    'A Playwright or Puppeteer browser is not closed in a finally block, so an error leaves the process running.',
  'check-then-update-race':
    "A Mongoose or Sequelize document's numeric field is read, changed in JavaScript and saved without a transaction, losing concurrent updates.",
  'child-process-without-error-listener':
    "A spawned child process has no 'error' listener, so a failed spawn crashes the parent process.",
  'csharp-async-void': 'An async void method cannot be awaited and can crash the process on unhandled exceptions.',
  'csharp-disposable-without-using':
    'A C# stream, connection or other IDisposable is created without using, so an exception leaks it.',
  'discarded-error-result': 'A call discards a typed Either or Result that can carry a failure as a value.',
  'drizzle-unfiltered-write': 'A Drizzle update or delete executes without an effective where clause.',
  'drizzle-write-preflight': 'A separate existence check before a Drizzle write can race with another request.',
  'error-logged-without-stack': 'A catch block logs only error.message and carries on, so the stack trace is lost.',
  'error-rethrown-without-cause':
    'A catch block throws a new error without the caught one, so the original message and stack are lost.',
  'file-handle-not-closed':
    'A FileHandle from fs/promises open() is not closed on every path, leaking a file descriptor.',
  'find-then-create-race':
    'A lookup by key is followed by an insert with that key, with no unique constraint to stop duplicates.',
  'floating-promise': 'A promise-returning call is neither awaited, returned nor handled, so its failure goes unseen.',
  'go-defer-before-error-check':
    'A Go defer closes a resource before its error is checked, so a failed open dereferences nil.',
  'go-error-discarded': 'A Go error result is assigned to the blank identifier and never checked.',
  'http-call-without-timeout': 'A fetch or axios call has no timeout or abort signal.',
  'interval-not-cleared': 'A setInterval handle is discarded or never cleared, so the timer outlives its owner.',
  'invalid-typeof-comparison':
    'A typeof result is compared to a string typeof never returns, so the check never matches.',
  'java-resource-without-try':
    'A Java stream, reader or connection is opened outside try-with-resources, so an exception leaks it.',
  'json-parse-unguarded':
    'JSON.parse runs on outside input with no try/catch, so malformed input throws where it is not handled.',
  'loop-index-past-length': 'A loop runs its index up to and including length, so the last pass reads past the end.',
  'migration-breaking-drop': 'A migration drops a column or table that running code may still use.',
  'migration-breaking-rename': 'A migration renames a column or table that running code may still use.',
  'migration-column-type-rewrite': 'A migration changes a column type in a way that rewrites the table.',
  'migration-concurrent-in-transaction':
    'A CONCURRENTLY index statement runs inside a transaction, where PostgreSQL rejects it.',
  'migration-constraint-not-valid': 'A constraint is added and validated in one step instead of NOT VALID first.',
  'migration-constraint-without-index': 'A unique or primary key constraint builds its index while blocking writes.',
  'migration-index-not-concurrent': 'A PostgreSQL index is built without CONCURRENTLY, blocking writes to the table.',
  'migration-missing-lock-timeout': 'A migration statement takes a lock with no lock_timeout set.',
  'migration-mysql-lock-unspecified': 'A MySQL ALTER does not state its LOCK level.',
  'migration-mysql-table-copy': 'A MySQL ALTER copies the whole table.',
  'migration-not-null-without-default': 'A NOT NULL column is added without a default, which fails once rows exist.',
  'migration-set-not-null-scan': 'SET NOT NULL scans the whole table while holding a lock.',
  'migration-table-rewrite-command':
    'A migration runs VACUUM FULL, CLUSTER or REINDEX, which rewrites or locks the table.',
  'migration-unparsed': 'A migration statement could not be parsed and needs a manual review.',
  'migration-volatile-default': 'A column is added with a volatile default, which rewrites the table.',
  'mongoose-aggregate-uncast-id':
    'A Mongoose aggregate $match compares _id to an uncast string instead of an ObjectId.',
  'nan-comparison': 'A value is compared to NaN with an equality operator, which is never true.',
  'next-server-env-in-client':
    "A 'use client' file reads a process.env variable without the NEXT_PUBLIC_ prefix, so it is unavailable in the browser by default.",
  'payment-missing-idempotency-key':
    'A Stripe call that moves money has no idempotency key, so a retry can charge or pay out twice.',
  'pg-transaction-on-pool':
    'A transaction statement is sent to a pool, so its statements can run on different connections.',
  'pool-without-connection-timeout':
    'A pg Pool or Client sets no connectionTimeoutMillis, so its default of 0 waits for a connection forever.',
  'prisma-dependent-writes': 'Adjacent Prisma creates pass a value from the first record into the next write.',
  'prisma-read-modify-write': 'A Prisma read feeds a numeric update of the same row, losing concurrent updates.',
  'prisma-transaction-client-escape':
    'A Prisma call inside an interactive transaction uses the outer client instead of the transaction client.',
  'promise-return-escapes-catch':
    'Returning a promise directly from a protected try block can bypass its catch on rejection.',
  'python-bare-except': 'A bare except also catches SystemExit and KeyboardInterrupt, hiding shutdowns and bugs.',
  'python-swallowed-exception': 'A Python except block only passes, so the failure is dropped silently.',
  'query-runner-not-released':
    'A TypeORM QueryRunner is not released in a finally block, so an error leaks its pooled connection.',
  'react-async-effect-callback':
    'An async function is passed to useEffect, so its promise is treated as the cleanup function and its errors go unhandled.',
  'react-effect-sets-state-every-render':
    'An effect with no dependency array sets state to a new value on every run, so the component re-renders forever.',
  'react-list-missing-key':
    'An element or fragment returned from .map() has no key prop, so React cannot track items when the list changes.',
  'react-state-mutated-in-place':
    'A useState value is mutated in place and passed to its own setter, so React sees the same reference and skips the re-render.',
  'redis-incr-then-expire':
    'A Redis counter increment and its expire on the same key are two round trips and not atomic.',
  'request-number-unvalidated':
    'A number parsed from request input reaches a query or calculation with no NaN or range check.',
  'retry-without-backoff': 'A retry loop calls the network again with no delay between attempts.',
  'return-in-finally': 'Returning from finally can replace a pending return value or suppress a thrown error.',
  'return-newline': 'A line break after return ends the statement before the apparent return value.',
  'rust-unwrap-in-production': 'Rust code outside tests calls unwrap(), turning an Err or None into a panic.',
  'sql-insert-truncated-at-semicolon': 'A SQL dump parser ends INSERT values at a semicolon inside quoted text.',
  'stream-pipe-unhandled-error':
    'A stream is piped with .pipe() and no error handling, so a stream error can crash the process or leak the file.',
  'swallowed-error': 'A catch block drops the error and the code after the try carries on as if it succeeded.',
  'switch-not-exhaustive':
    'A switch over a union or enum has no default and misses members, so the missing value leaves the result undefined.',
  'throw-non-error': 'A string, number or object literal is thrown instead of an Error, so there is no stack trace.',
  'typeorm-transaction-client-escape':
    'A write inside a TypeORM transaction goes through a repository not bound to it.',
  'unbounded-promise-all':
    'Promise.all runs over an unbounded collection without a concurrency limit, risking memory spikes or downstream saturation.',
  'uncaught-exception-continues':
    'An uncaughtException handler neither exits nor rethrows, so the process keeps running in an undefined state.',
  'unguarded-boundary-access':
    'A nested property is read from outside input or a lookup that can be missing, so absent data throws a TypeError.',
  'unreachable-code': 'Statements follow a return, throw, break or continue in the same block and never run.',
  'upload-without-size-limit': 'A multer or Nest upload interceptor has no file size limit.',
  'webhook-missing-idempotency-check':
    'A webhook route inserts rows without first checking whether the event was already processed.',
};

export { sourceRules, migrationRules, contractRules, polyglotRules, knownRules, impactByRule, descriptionByRule };
