import type { ImpactLevel } from '../shared/types.js';

// Rules about code that crashes, loses data or silently misbehaves at runtime: unhandled async failures, error
// handling, races and integrity, external-call resilience, migration lock and outage risks, and breaking API changes.
// The source rules are reported by the shared TypeScript pass; migrations and contracts by their own subcommands.
const sourceRules = [
  'pg-transaction-on-pool',
  'prisma-transaction-client-escape',
  'prisma-read-modify-write',
  'prisma-dependent-writes',
  'drizzle-unfiltered-write',
  'http-call-without-timeout',
  'upload-without-size-limit',
  'mongoose-aggregate-uncast-id',
  'typeorm-transaction-client-escape',
  'redis-incr-then-expire',
  'floating-promise',
  'discarded-error-result',
  'promise-return-escapes-catch',
  'return-in-finally',
  'return-newline',
  'drizzle-write-preflight',
  'find-then-create-race',
  'retry-without-backoff',
  'async-route-unhandled-rejection',
  'async-callback-unhandled-rejection',
  'stream-pipe-unhandled-error',
  'json-parse-unguarded',
  'request-number-unvalidated',
  'check-then-update-race',
  'payment-missing-idempotency-key',
  'webhook-missing-idempotency-check',
  'unbounded-promise-all',
  'swallowed-error',
  'sql-insert-truncated-at-semicolon',
  'unguarded-boundary-access',
  'assignment-in-condition',
  'nan-comparison',
  'invalid-typeof-comparison',
  'unreachable-code',
  'loop-index-past-length',
  'file-handle-not-closed',
  'query-runner-not-released',
  'browser-not-closed',
  'interval-not-cleared',
  'child-process-without-error-listener',
  'error-rethrown-without-cause',
  'throw-non-error',
  'error-logged-without-stack',
  'react-effect-sets-state-every-render',
  'react-async-effect-callback',
  'react-state-mutated-in-place',
  'react-list-missing-key',
  'next-server-env-in-client',
];

const migrationRules = [
  'migration-index-not-concurrent',
  'migration-concurrent-in-transaction',
  'migration-not-null-without-default',
  'migration-volatile-default',
  'migration-column-type-rewrite',
  'migration-set-not-null-scan',
  'migration-constraint-not-valid',
  'migration-constraint-without-index',
  'migration-breaking-drop',
  'migration-breaking-rename',
  'migration-missing-lock-timeout',
  'migration-table-rewrite-command',
  'migration-unparsed',
  'migration-mysql-table-copy',
  'migration-mysql-lock-unspecified',
];

const contractRules = [
  'api-removed-operation',
  'api-removed-field',
  'api-required-input',
  'api-type-changed',
  'api-enum-value-removed',
];

// Rules the ast-grep polyglot scan reports from polyglot/reliability.
const polyglotRules = [
  'csharp-async-void',
  'csharp-disposable-without-using',
  'python-bare-except',
  'python-swallowed-exception',
  'go-error-discarded',
  'go-defer-before-error-check',
  'java-resource-without-try',
  'rust-unwrap-in-production',
];

// One --ignore list is shared by every command, so a CI script can pass the same flags to each of them.
const knownRules = new Set([...sourceRules, ...migrationRules, ...contractRules]);

// Impact levels (see lib/shared/impact-levels.ts) for every rule id a reliability finding can carry. README criteria:
// critical is data loss, an outage or a lock risk in production; high a crash, lost failure or race that a normal
// request can hit; medium a failure that needs an unusual input or condition; low a hygiene issue.
const impactByRule: Readonly<Record<string, ImpactLevel>> = {
  'pg-transaction-on-pool': 'critical',
  'prisma-transaction-client-escape': 'critical',
  'typeorm-transaction-client-escape': 'critical',
  'prisma-read-modify-write': 'critical',
  'drizzle-unfiltered-write': 'critical',
  'migration-index-not-concurrent': 'critical',
  'migration-breaking-drop': 'critical',
  'migration-column-type-rewrite': 'critical',
  'migration-table-rewrite-command': 'critical',
  'migration-mysql-table-copy': 'critical',
  'api-removed-operation': 'critical',
  'prisma-dependent-writes': 'high',
  'find-then-create-race': 'high',
  'floating-promise': 'high',
  'discarded-error-result': 'high',
  'promise-return-escapes-catch': 'high',
  'return-in-finally': 'high',
  'return-newline': 'high',
  'drizzle-write-preflight': 'medium',
  'http-call-without-timeout': 'high',
  'upload-without-size-limit': 'high',
  'mongoose-aggregate-uncast-id': 'high',
  'check-then-update-race': 'high',
  'payment-missing-idempotency-key': 'high',
  'webhook-missing-idempotency-check': 'medium',
  'redis-incr-then-expire': 'medium',
  'retry-without-backoff': 'medium',
  'async-route-unhandled-rejection': 'high',
  'async-callback-unhandled-rejection': 'high',
  'stream-pipe-unhandled-error': 'high',
  'json-parse-unguarded': 'medium',
  'request-number-unvalidated': 'medium',
  'migration-concurrent-in-transaction': 'high',
  'migration-not-null-without-default': 'high',
  'migration-volatile-default': 'high',
  'migration-set-not-null-scan': 'high',
  'migration-constraint-not-valid': 'high',
  'migration-constraint-without-index': 'high',
  'migration-breaking-rename': 'high',
  'migration-missing-lock-timeout': 'high',
  'migration-mysql-lock-unspecified': 'high',
  'api-removed-field': 'high',
  'api-required-input': 'high',
  'api-type-changed': 'high',
  'api-enum-value-removed': 'high',
  'migration-unparsed': 'low',
  'unbounded-promise-all': 'high',
  'csharp-async-void': 'high',
  'sql-insert-truncated-at-semicolon': 'high',
  'swallowed-error': 'medium',
  'unguarded-boundary-access': 'medium',
  'assignment-in-condition': 'high',
  'nan-comparison': 'high',
  'invalid-typeof-comparison': 'high',
  'unreachable-code': 'medium',
  'loop-index-past-length': 'high',
  'file-handle-not-closed': 'high',
  'query-runner-not-released': 'critical',
  'browser-not-closed': 'high',
  'interval-not-cleared': 'medium',
  'child-process-without-error-listener': 'high',
  'error-rethrown-without-cause': 'low',
  'throw-non-error': 'medium',
  'error-logged-without-stack': 'low',
  'react-effect-sets-state-every-render': 'high',
  'react-async-effect-callback': 'medium',
  'react-state-mutated-in-place': 'high',
  'react-list-missing-key': 'medium',
  'next-server-env-in-client': 'high',
  'csharp-disposable-without-using': 'medium',
  'python-bare-except': 'medium',
  'python-swallowed-exception': 'medium',
  'go-error-discarded': 'high',
  'go-defer-before-error-check': 'high',
  'java-resource-without-try': 'high',
  'rust-unwrap-in-production': 'medium',
};

// One-line summaries of every rule above, used where a rule needs a fixed name (SARIF shortDescription) rather than
// the per-site finding message. The README row for each rule has the full evidence.
const descriptionByRule: Readonly<Record<string, string>> = {
  'api-enum-value-removed': 'An enum value or string-literal option that clients could send was removed.',
  'api-removed-field':
    'A response field, GraphQL type, field, argument or union member, or returned DTO property was removed.',
  'api-removed-operation': 'An OpenAPI operation or a GraphQL Query, Mutation or Subscription field was removed.',
  'api-required-input': 'A request field, parameter or GraphQL argument is new and required, or became required.',
  'api-type-changed':
    'A field or parameter changed type, or a GraphQL type changed nullability in a breaking direction.',
  'drizzle-unfiltered-write': 'A Drizzle update or delete executes without an effective where clause.',
  'find-then-create-race':
    'A lookup by key is followed by an insert with that key, with no unique constraint to stop duplicates.',
  'floating-promise': 'A promise-returning call is neither awaited, returned nor handled, so its failure goes unseen.',
  'discarded-error-result': 'A call discards a typed Either or Result that can carry a failure as a value.',
  'promise-return-escapes-catch':
    'Returning a promise directly from a protected try block can bypass its catch on rejection.',
  'return-in-finally': 'Returning from finally can replace a pending return value or suppress a thrown error.',
  'return-newline': 'A line break after return ends the statement before the apparent return value.',
  'drizzle-write-preflight': 'A separate existence check before a Drizzle write can race with another request.',
  'http-call-without-timeout': 'A fetch or axios call has no timeout or abort signal.',
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
  'pg-transaction-on-pool':
    'A transaction statement is sent to a pool, so its statements can run on different connections.',
  'prisma-dependent-writes': 'Adjacent Prisma creates pass a value from the first record into the next write.',
  'prisma-read-modify-write': 'A Prisma read feeds a numeric update of the same row, losing concurrent updates.',
  'prisma-transaction-client-escape':
    'A Prisma call inside an interactive transaction uses the outer client instead of the transaction client.',
  'redis-incr-then-expire':
    'A Redis counter increment and its expire on the same key are two round trips and not atomic.',
  'retry-without-backoff': 'A retry loop calls the network again with no delay between attempts.',
  'async-route-unhandled-rejection':
    'An Express 4 async route handler has no error handling, so a rejection never reaches the error middleware.',
  'async-callback-unhandled-rejection':
    'An async callback given to an event emitter, timer or scheduler has no error handling, so a rejection is unhandled.',
  'stream-pipe-unhandled-error':
    'A stream is piped with .pipe() and no error handling, so a stream error can crash the process or leak the file.',
  'json-parse-unguarded':
    'JSON.parse runs on outside input with no try/catch, so malformed input throws where it is not handled.',
  'request-number-unvalidated':
    'A number parsed from request input reaches a query or calculation with no NaN or range check.',
  'typeorm-transaction-client-escape':
    'A write inside a TypeORM transaction goes through a repository not bound to it.',
  'upload-without-size-limit': 'A multer or Nest upload interceptor has no file size limit.',
  'mongoose-aggregate-uncast-id':
    'A Mongoose aggregate $match compares _id to an uncast string instead of an ObjectId.',
  'check-then-update-race':
    "A Mongoose or Sequelize document's numeric field is read, changed in JavaScript and saved without a transaction, losing concurrent updates.",
  'payment-missing-idempotency-key':
    'A Stripe call that moves money has no idempotency key, so a retry can charge or pay out twice.',
  'webhook-missing-idempotency-check':
    'A webhook route inserts rows without first checking whether the event was already processed.',
  'unbounded-promise-all':
    'Promise.all runs over an unbounded collection without a concurrency limit, risking memory spikes or downstream saturation.',
  'csharp-async-void': 'An async void method cannot be awaited and can crash the process on unhandled exceptions.',
  'sql-insert-truncated-at-semicolon': 'A SQL dump parser ends INSERT values at a semicolon inside quoted text.',
  'swallowed-error': 'A catch block drops the error and the code after the try carries on as if it succeeded.',
  'unguarded-boundary-access':
    'A nested property is read from outside input or a lookup that can be missing, so absent data throws a TypeError.',
  'assignment-in-condition': 'A condition assigns with = where a comparison was probably meant.',
  'nan-comparison': 'A value is compared to NaN with an equality operator, which is never true.',
  'invalid-typeof-comparison':
    'A typeof result is compared to a string typeof never returns, so the check never matches.',
  'unreachable-code': 'Statements follow a return, throw, break or continue in the same block and never run.',
  'loop-index-past-length': 'A loop runs its index up to and including length, so the last pass reads past the end.',
  'file-handle-not-closed':
    'A FileHandle from fs/promises open() is not closed on every path, leaking a file descriptor.',
  'query-runner-not-released':
    'A TypeORM QueryRunner is not released in a finally block, so an error leaks its pooled connection.',
  'browser-not-closed':
    'A Playwright or Puppeteer browser is not closed in a finally block, so an error leaves the process running.',
  'interval-not-cleared': 'A setInterval handle is discarded or never cleared, so the timer outlives its owner.',
  'child-process-without-error-listener':
    "A spawned child process has no 'error' listener, so a failed spawn crashes the parent process.",
  'error-rethrown-without-cause':
    'A catch block throws a new error without the caught one, so the original message and stack are lost.',
  'throw-non-error': 'A string, number or object literal is thrown instead of an Error, so there is no stack trace.',
  'error-logged-without-stack': 'A catch block logs only error.message and carries on, so the stack trace is lost.',
  'react-effect-sets-state-every-render':
    'An effect with no dependency array sets state to a new value on every run, so the component re-renders forever.',
  'react-async-effect-callback':
    'An async function is passed to useEffect, so its promise is treated as the cleanup function and its errors go unhandled.',
  'react-state-mutated-in-place':
    'A useState value is mutated in place and passed to its own setter, so React sees the same reference and skips the re-render.',
  'react-list-missing-key':
    'An element or fragment returned from .map() has no key prop, so React cannot track items when the list changes.',
  'next-server-env-in-client':
    "A 'use client' file reads a process.env variable without the NEXT_PUBLIC_ prefix, so it is undefined in the browser.",
  'csharp-disposable-without-using':
    'A C# stream, connection or other IDisposable is created without using, so an exception leaks it.',
  'python-bare-except': 'A bare except also catches SystemExit and KeyboardInterrupt, hiding shutdowns and bugs.',
  'python-swallowed-exception': 'A Python except block only passes, so the failure is dropped silently.',
  'go-error-discarded': 'A Go error result is assigned to the blank identifier and never checked.',
  'go-defer-before-error-check':
    'A Go defer closes a resource before its error is checked, so a failed open dereferences nil.',
  'java-resource-without-try':
    'A Java stream, reader or connection is opened outside try-with-resources, so an exception leaks it.',
  'rust-unwrap-in-production': 'Rust code outside tests calls unwrap(), turning an Err or None into a panic.',
};

export { sourceRules, migrationRules, contractRules, polyglotRules, knownRules, impactByRule, descriptionByRule };
