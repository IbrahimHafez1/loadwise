'use strict';

// Rule id -> { needs }: the weakest recognition the rule accepts ('syntax', 'import' or 'types'; see bindings.cjs).
module.exports = {
  'open-redirect': { needs: 'import' },
  'ssrf-request-url': { needs: 'import' },
};
