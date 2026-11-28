// Runs the test suite: `npm test` and each CI shard share this one list of test files.
// Usage: node scripts/run-tests.js [node --test options ...], for example --test-shard=1/3. The options go before
// the files because node --test ignores options that follow them.

import { spawnSync } from 'node:child_process';

const testFiles = [
  'test/performance/*.test.js',
  'test/maintainability/*.test.js',
  'test/reliability/*.test.js',
  'test/security/*.test.js',
  'test/accessibility/*.test.js',
  'test/shared/*.test.js',
  'test/plugin/*.test.js',
  'test/editor/*.test.js',
];

const run = spawnSync(
  process.execPath,
  ['--import', './test/manual-session.js', '--test', '--test-concurrency=8', ...process.argv.slice(2), ...testFiles],
  { stdio: 'inherit' },
);
process.exitCode = run.status ?? 1;
