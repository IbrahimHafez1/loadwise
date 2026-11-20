'use strict';

const ts = require('typescript');

// Packages whose rules identify clients through resolved types; unresolved, those rules cannot fire.
const typeResolvedPackages = new Set(['@prisma/client', 'typeorm', 'drizzle-orm', 'pg', 'mysql2', 'ioredis', 'redis']);

function packageNameOf(specifier) {
  const [first, second] = specifier.split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

// Adds the supported packages that `source` imports but the program could not resolve.
function collectUnresolvedPackages(program, source, unresolved) {
  const options = program.getCompilerOptions();
  for (const importNode of source.imports ?? []) {
    const packageName = packageNameOf(importNode.text);
    if (!typeResolvedPackages.has(packageName) || unresolved.has(packageName)) continue;
    const mode = ts.getModeForUsageLocation(source, importNode, options);
    if (!program.getResolvedModule(source, importNode.text, mode)?.resolvedModule) unresolved.add(packageName);
  }
}

function formatMissingPackagesNote(packageName) {
  const missing =
    packageName === '@prisma/client'
      ? 'not installed or its client is not generated; its checks need `npm install` and `prisma generate`'
      : 'not installed; its checks need `npm install`';
  return `Note: ${packageName} is imported but ${missing} and were skipped.`;
}

module.exports = { collectUnresolvedPackages, formatMissingPackagesNote };
