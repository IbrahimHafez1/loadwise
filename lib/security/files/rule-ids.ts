// Rule id -> { needs }: these rules read project files, not TypeScript syntax, so they need nothing
// from the compiler.
// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
export default {
  'committed-secret': { needs: 'syntax' },
  'compose-hardcoded-secret': { needs: 'syntax' },
  'dockerfile-add-remote-url': { needs: 'syntax' },
  'dockerfile-runs-as-root': { needs: 'syntax' },
  'dockerfile-secret-in-build': { needs: 'syntax' },
  'dockerfile-unpinned-base-image': { needs: 'syntax' },
};
