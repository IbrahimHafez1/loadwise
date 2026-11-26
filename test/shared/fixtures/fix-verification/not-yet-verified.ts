// Rule ids with a registered fix builder that no verification sample covers yet. This list is the
// to-do for
// `fix-verification-coverage.test.cjs`: write a sample, add it to a case table, then remove the id
// here.
const liveDatabaseReason = 'a live-database finding with no source file, so verifyFix has nothing to scan';

const reviewVerificationReason = 'requires review-level verification sample; unit-tested in fix-coverage-v2.test.ts';

const reasonsByRule = {
  'migration-breaking-rename':
    'the fix keeps the rename and adds a view under the old name, so the finding stays by design and verifyFix, which requires it to disappear, cannot pass',
  'db-unindexed-foreign-key': liveDatabaseReason,
  'db-missing-index': liveDatabaseReason,
  'db-slow-query-plan': liveDatabaseReason,
  'db-unused-index': liveDatabaseReason,
  'db-duplicate-index': liveDatabaseReason,
  'upload-client-filename': reviewVerificationReason,
  'path-traversal': reviewVerificationReason,
  'open-redirect': reviewVerificationReason,
  'regex-from-input': reviewVerificationReason,

  'mysql-dynamic-query-text': reviewVerificationReason,
  'prisma-raw-unsafe-dynamic': reviewVerificationReason,
  'cors-credentials-any-origin': reviewVerificationReason,
  'storage-object-public-acl': reviewVerificationReason,
  'secret-in-log': reviewVerificationReason,
  'xml-external-entities': reviewVerificationReason,
  'insecure-cipher': reviewVerificationReason,
  'jwt-decode-for-auth': reviewVerificationReason,
  'react-dangerously-set-inner-html': reviewVerificationReason,
  'dockerfile-runs-as-root': reviewVerificationReason,
  'dockerfile-add-remote-url': reviewVerificationReason,
  'react-fetch-in-effect-no-abort': reviewVerificationReason,
  'dom-listener-without-cleanup': reviewVerificationReason,
  'angular-subscribe-without-cleanup': reviewVerificationReason,
  'frontend-barrel-heavy-import': reviewVerificationReason,
  'express-missing-compression': reviewVerificationReason,
  'mongoose-hydrate-for-to-object': reviewVerificationReason,
  'unused-export': reviewVerificationReason,
};

export { reasonsByRule as notYetVerified };
