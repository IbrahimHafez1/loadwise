// Rule ids with a registered fix builder that no verification sample covers yet. This list is the
// to-do for
// `fix-verification-coverage.test.cjs`: write a sample, add it to a case table, then remove the id
// here.
const liveDatabaseReason = 'a live-database finding with no source file, so verifyFix has nothing to scan';

const reasonsByRule = {
  'migration-breaking-rename':
    'the fix keeps the rename and adds a view under the old name, so the finding stays by design and verifyFix, which requires it to disappear, cannot pass',
  'db-unindexed-foreign-key': liveDatabaseReason,
  'db-missing-index': liveDatabaseReason,
  'db-slow-query-plan': liveDatabaseReason,
  'db-unused-index': liveDatabaseReason,
  'db-duplicate-index': liveDatabaseReason,
};

export { reasonsByRule as notYetVerified };
