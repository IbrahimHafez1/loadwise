'use strict';

// Rule id -> [code, note]. A dependency finding points at a lockfile or package.json, so the example is the fix command.
module.exports = {
  'dependency-known-vulnerability': [
    '// Direct dependency: npm install lodash@4.17.21\n// Transitive: add "overrides": { "lodash": "4.17.21" } to package.json',
    'Upgrade to the fixed version named in the finding. For a transitive dependency, pin it with overrides (npm), pnpm.overrides or resolutions (yarn), then reinstall.',
  ],
};
