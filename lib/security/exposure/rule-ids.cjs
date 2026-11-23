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
  'password-hash-in-response': { needs: 'types' },
  'storage-object-public-acl': { needs: 'syntax' },
  'secret-in-url-query': { needs: 'syntax' },
  'graphql-query-depth-unbounded': { needs: 'syntax' },
  'database-error-in-response': { needs: 'syntax' },
  'dom-xss-sink': { needs: 'syntax' },
  'react-dangerously-set-inner-html': { needs: 'syntax' },
  'angular-bypass-security-trust': { needs: 'types' },
  'vue-v-html-unsanitized': { needs: 'syntax' },
  'frontend-storage-secret-token': { needs: 'syntax' },
  'postmessage-missing-origin-check': { needs: 'syntax' },
  'express-missing-helmet': { needs: 'types' },
};
