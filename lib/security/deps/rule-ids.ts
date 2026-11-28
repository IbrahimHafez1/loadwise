// Rule id -> { needs }: the weakest recognition the rule accepts ('syntax', 'import' or 'types';
// see bindings.cjs). This rule reads the lockfile, not source, and is reported by `loadwise sec
// deps`, so no source recognition applies.
// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
export default {
  'dependency-known-vulnerability': { needs: 'syntax' },
};
