'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const lock = require('../package-lock.json');

test('the released dependency graph is independent of ESLint and the referenced performance plugins', () => {
  const excluded = new Set(['eslint', 'eslint-plugin-parallelize', 'eslint-plugin-unicorn', 'eslint-plugin-perf-fiscal']);
  for (const [location, entry] of Object.entries(lock.packages)) {
    const installedAs = location.split('node_modules/').at(-1);
    assert.ok(!excluded.has(installedAs) && !excluded.has(entry.name), location);
    for (const dependency of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies })) {
      assert.ok(!excluded.has(dependency), location + ' declares ' + dependency);
    }
  }
});
