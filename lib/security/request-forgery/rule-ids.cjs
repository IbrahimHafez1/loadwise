'use strict';

// Rule id -> { needs }: the weakest recognition the rule accepts ('syntax', 'import' or 'types'; see bindings.cjs).
module.exports = {
  'open-redirect': { needs: 'import' },
  'path-traversal': { needs: 'import' },
  'ssrf-request-url': { needs: 'import' },
  'zip-slip-extraction': { needs: 'import' },
};
