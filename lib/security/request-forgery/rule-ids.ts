// Rule id -> { needs }: the weakest recognition the rule accepts ('syntax', 'import' or 'types';
// see bindings.cjs).
// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
export default {
  'open-redirect': { needs: 'import' },
  'path-traversal': { needs: 'import' },
  'ssrf-request-url': { needs: 'import' },
  'upload-client-filename': { needs: 'import' },
  'zip-slip-extraction': { needs: 'import' },
};
