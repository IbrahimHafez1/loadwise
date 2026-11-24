import assert from 'node:assert/strict';
import test from 'node:test';
import lock from '../../package-lock.json';

// The members of a lockfile entry the dependency checks read.
interface LockedPackage {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [field: string]: unknown;
}

const lockedPackages: Record<string, LockedPackage> = lock.packages;

test('the released dependency graph is independent of ESLint and the referenced performance plugins', () => {
  const excluded = new Set([
    'eslint',
    'eslint-plugin-parallelize',
    'eslint-plugin-unicorn',
    'eslint-plugin-perf-fiscal',
  ]);
  for (const [location, entry] of Object.entries(lockedPackages)) {
    const installedAs = location.split('node_modules/').at(-1) ?? location;
    assert.ok(!excluded.has(installedAs) && !excluded.has(entry.name ?? ''), location);
    for (const dependency of Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...entry.peerDependencies,
    })) {
      assert.ok(!excluded.has(dependency), location + ' declares ' + dependency);
    }
  }
});

test('the package ships no database driver; db uses the project’s own', () => {
  const drivers = new Set(['pg', 'mysql2', 'mysql', 'mongodb', 'mongoose', 'pg-pool']);
  for (const [location, entry] of Object.entries(lockedPackages)) {
    const installedAs = location.split('node_modules/').at(-1) ?? location;
    assert.ok(!drivers.has(installedAs) && !drivers.has(entry.name ?? ''), location);
    for (const dependency of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      assert.ok(!drivers.has(dependency), location + ' declares ' + dependency);
    }
  }
});
