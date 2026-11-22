'use strict';

// Rule ids with a registered fix builder that no verification sample covers yet. This list is the to-do for
// `fix-verification-coverage.test.cjs`: write a sample, add it to a case table, then remove the id here.
const schemaFileReason = 'the fix edits a schema or SQL file, which verifyFix does not scan or type-check yet';
const migrationReason = 'the fix edits or creates a migration file, which verifyFix does not scan or type-check yet';
const liveDatabaseReason = 'a live-database finding with no source file, so verifyFix has nothing to scan';
const sampleReason = 'no minimal sample written yet';

const reasonsByRule = {
  'typeorm-wide-projection': sampleReason,
  'typeorm-unused-count': sampleReason,
  'typeorm-load-then-save': sampleReason,
  'known-reads-awaited-serially': 'needs a parallelReads query policy sample',
  'drizzle-query-in-loop': sampleReason,
  'notification-send-in-loop': 'compile-checked only in batch-loops-fixes.test.cjs; no verifyFix sample yet',
  'service-query-in-loop': sampleReason,
  'async-callback-unhandled-rejection': sampleReason,
  'request-number-unvalidated': sampleReason,
  'drizzle-last-insert-id': sampleReason,
  'repeated-workbook-decode': sampleReason,
  'prisma-distinct-in-memory': sampleReason,
  'prisma-relation-count-in-list': sampleReason,
  'external-call-in-transaction': sampleReason,
  'floating-promise': sampleReason,
  'drizzle-write-preflight': sampleReason,
  'guard-query-per-request': sampleReason,
  'drizzle-unfiltered-write': sampleReason,
  'index-redundant-prefix': schemaFileReason,
  'index-missing-filter': schemaFileReason,
  'index-missing-order': schemaFileReason,
  'index-unusable-pattern': schemaFileReason,
  'index-unusable-expression': schemaFileReason,
  'index-missing-foreign-key': schemaFileReason,
  'migration-index-not-concurrent': migrationReason,
  'migration-concurrent-in-transaction': migrationReason,
  'migration-not-null-without-default': migrationReason,
  'migration-volatile-default': migrationReason,
  'migration-column-type-rewrite': migrationReason,
  'migration-set-not-null-scan': migrationReason,
  'migration-constraint-not-valid': migrationReason,
  'migration-constraint-without-index': migrationReason,
  'migration-breaking-drop': migrationReason,
  'migration-breaking-rename': migrationReason,
  'migration-missing-lock-timeout': migrationReason,
  'migration-table-rewrite-command': migrationReason,
  'migration-mysql-table-copy': migrationReason,
  'migration-mysql-lock-unspecified': migrationReason,
  'db-unindexed-foreign-key': liveDatabaseReason,
  'db-missing-index': liveDatabaseReason,
  'db-slow-query-plan': liveDatabaseReason,
  'db-unused-index': liveDatabaseReason,
  'db-duplicate-index': liveDatabaseReason,
};

module.exports = { notYetVerified: reasonsByRule };
