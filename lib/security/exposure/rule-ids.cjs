'use strict';

// Rule id -> { needs }: the weakest recognition the rule accepts ('syntax', 'import' or 'types'; see bindings.cjs).
module.exports = {
  'cookie-missing-security-flags': { needs: 'import' },
  'cors-credentials-any-origin': { needs: 'import' },
  'cors-origin-regex-unanchored': { needs: 'import' },
  'error-stack-in-response': { needs: 'syntax' },
  'graphql-introspection-enabled': { needs: 'syntax' },
  'mass-assignment': { needs: 'types' },
  'nest-validation-without-whitelist': { needs: 'import' },
  'prototype-pollution': { needs: 'import' },
  'reflected-xss-response': { needs: 'syntax' },
  'secret-in-log': { needs: 'syntax' },
  'template-autoescape-disabled': { needs: 'import' },
  'xml-external-entities': { needs: 'import' },
};
