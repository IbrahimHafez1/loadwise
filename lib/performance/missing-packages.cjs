'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Packages whose rules identify clients through resolved types; unresolved, those rules cannot fire.
const typeResolvedPackages = new Set([
  '@prisma/client',
  'typeorm',
  '@n8n/typeorm',
  'drizzle-orm',
  'pg',
  'mysql2',
  'ioredis',
  'redis',
  'knex',
  'kysely',
  'mongoose',
  'sequelize',
  'sequelize-typescript',
]);

function isTypeResolvedPackage(packageName) {
  return typeResolvedPackages.has(packageName) || packageName.startsWith('@mikro-orm/');
}

function packageNameOf(specifier) {
  const [first, second] = specifier.split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

// Adds the supported packages that `source` imports but the program could not resolve.
function collectUnresolvedPackages(program, source, unresolved) {
  const options = program.getCompilerOptions();
  for (const importNode of source.imports ?? []) {
    const packageName = packageNameOf(importNode.text);
    if (!isTypeResolvedPackage(packageName) || unresolved.has(packageName)) continue;
    const mode = ts.getModeForUsageLocation(source, importNode, options);
    if (!program.getResolvedModule(source, importNode.text, mode)?.resolvedModule) unresolved.add(packageName);
  }
}

function readManifest(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function isInstalled(packageName, directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'node_modules', packageName, 'package.json'))) return true;
    if (path.dirname(current) === current) return false;
  }
}

// Adds the supported packages that the package around `directory` depends on, directly or through a workspace
// package of the same repository (a wrapper such as `@org/prisma`), but that are not installed. Such a client often
// reaches the scanned code only through the wrapper, so no import of it is seen.
function collectUninstalledDependencies(directory, workspacePackages, uninstalled) {
  let packageDirectory = path.resolve(directory);
  while (!fs.existsSync(path.join(packageDirectory, 'package.json'))) {
    const parent = path.dirname(packageDirectory);
    if (parent === packageDirectory) return;
    packageDirectory = parent;
  }
  const visited = new Set();
  const pending = [packageDirectory];
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const manifest = readManifest(current);
    const names = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) =>
      Object.keys(manifest?.[field] ?? {}),
    );
    for (const name of names) {
      const workspaceDirectory = workspacePackages?.get(name);
      if (workspaceDirectory) pending.push(workspaceDirectory);
      else if (isTypeResolvedPackage(name) && !isInstalled(name, current)) uninstalled.add(name);
    }
  }
}

// TypeORM receivers are also recognised from their declarations (`Repository<T>`), so its checks still run.
const declarationRecognisedPackages = new Set(['typeorm', '@n8n/typeorm']);

// Prisma delegates are still recognised from schema.prisma model names and the client's variable name.
const PRISMA_OUTCOME =
  'its checks run with reduced precision from schema.prisma model names until `npm install` and `prisma generate`';

function missingOutcome(packageName) {
  if (packageName === '@prisma/client') return PRISMA_OUTCOME;
  return declarationRecognisedPackages.has(packageName)
    ? 'its checks run with reduced precision from declarations until `npm install`'
    : 'its checks need `npm install` and were skipped';
}

function formatMissingPackagesNote(packageName) {
  if (packageName === '@prisma/client') {
    return `Note: ${packageName} is imported but not installed or its client is not generated; ${PRISMA_OUTCOME}.`;
  }
  return `Note: ${packageName} is imported but not installed; ${missingOutcome(packageName)}.`;
}

function formatUninstalledDependencyNote(packageName) {
  return `Note: ${packageName} is a dependency but not installed; ${missingOutcome(packageName)}.`;
}

module.exports = {
  collectUninstalledDependencies,
  collectUnresolvedPackages,
  formatMissingPackagesNote,
  formatUninstalledDependencyNote,
};
