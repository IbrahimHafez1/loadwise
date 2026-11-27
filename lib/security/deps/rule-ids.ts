// Rule id -> { needs }: the weakest recognition the rule accepts ('syntax', 'import' or 'types';
// see bindings.cjs). This rule reads the lockfile, not source, and is reported by `loadwise sec
// deps`, so no source recognition applies.
export default {
  'dependency-known-vulnerability': { needs: 'syntax' },
};
