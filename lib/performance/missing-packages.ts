import fs from 'node:fs';
import path from 'node:path';
import { isTempRoot, safeExists } from '../shared/project-root.js';
import ts from 'typescript';
import type { Program, SourceFile } from 'typescript';

// The dependency fields of a package.json that name packages.
interface DependencyManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

// Packages whose rules identify clients through resolved types; unresolved, those rules cannot
// fire.
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

function isTypeResolvedPackage(packageName: string): boolean {
  return typeResolvedPackages.has(packageName) || packageName.startsWith('@mikro-orm/');
}

function packageNameOf(specifier: string): string {
  const [first, second] = specifier.split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

// Adds the supported packages that `source` imports but the program could not resolve.
function collectUnresolvedPackages(program: Program, source: SourceFile, unresolved: Set<string>): void {
  const options = program.getCompilerOptions();
  for (const importNode of source.imports ?? []) {
    const packageName = packageNameOf(importNode.text);
    if (!isTypeResolvedPackage(packageName) || unresolved.has(packageName)) continue;
    const mode = ts.getModeForUsageLocation(source, importNode, options);
    if (!program.getResolvedModule(source, importNode.text, mode)?.resolvedModule) unresolved.add(packageName);
  }
}

function readManifest(directory: string): DependencyManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function isInstalled(packageName: string, directory: string): boolean {
  for (let current = directory; ; current = path.dirname(current)) {
    if (safeExists(path.join(current, 'node_modules', packageName, 'package.json'))) return true;
    const parent = path.dirname(current);
    if (parent === current || isTempRoot(current)) return false;
  }
}

// Adds the supported packages that the package around `directory` depends on, directly or through a
// workspace package of the same repository (a wrapper such as `@org/prisma`), but that are not
// installed. Such a client often reaches the scanned code only through the wrapper, so no import of
// it is seen.
function collectUninstalledDependencies(
  directory: string,
  workspacePackages: ReadonlyMap<string, string> | undefined,
  uninstalled: Set<string>,
): void {
  let packageDirectory = path.resolve(directory);
  while (!safeExists(path.join(packageDirectory, 'package.json'))) {
    const parent = path.dirname(packageDirectory);
    if (parent === packageDirectory || isTempRoot(packageDirectory)) return;
    packageDirectory = parent;
  }
  const visited = new Set<string>();
  const pending = [packageDirectory];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (visited.has(current)) continue;
    visited.add(current);
    const manifest = readManifest(current);
    const names = DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest?.[field] ?? {}));
    for (const name of names) {
      const workspaceDirectory = workspacePackages?.get(name);
      if (workspaceDirectory) pending.push(workspaceDirectory);
      else if (isTypeResolvedPackage(name) && !isInstalled(name, current)) uninstalled.add(name);
    }
  }
}

// Receivers of these ORMs are also recognised from the project's own model declarations (entities,
// Mongoose models, Sequelize models, Drizzle tables), at reduced precision.
const sourceModelPackages = new Set(['mongoose', 'sequelize', 'sequelize-typescript', 'drizzle-orm']);

// TypeORM receivers are also recognised from their declarations (`Repository<T>`), so its checks
// still run.
const declarationRecognisedPackages = new Set(['typeorm', '@n8n/typeorm']);

// Prisma delegates are still recognised from schema.prisma model names and the client's variable
// name.
const PRISMA_OUTCOME =
  'its checks run with reduced precision from schema.prisma model names until `npm install` and `prisma generate`';

function missingOutcome(packageName: string): string {
  if (packageName === '@prisma/client') return PRISMA_OUTCOME;
  if (declarationRecognisedPackages.has(packageName)) {
    return 'its checks run with reduced precision from declarations until `npm install`';
  }
  return sourceModelPackages.has(packageName)
    ? 'its checks run with reduced precision from model definitions in the source until `npm install`'
    : 'its checks need `npm install` and were skipped';
}

function formatMissingPackagesNote(packageName: string): string {
  if (packageName === '@prisma/client') {
    return `Note: ${packageName} is imported but not installed or its client is not generated; ${PRISMA_OUTCOME}.`;
  }
  return `Note: ${packageName} is imported but not installed; ${missingOutcome(packageName)}.`;
}

function formatUninstalledDependencyNote(packageName: string): string {
  return `Note: ${packageName} is a dependency but not installed; ${missingOutcome(packageName)}.`;
}

export {
  collectUninstalledDependencies,
  collectUnresolvedPackages,
  formatMissingPackagesNote,
  formatUninstalledDependencyNote,
};
