'use strict';

const path = require('node:path');
const everything = Symbol('every export');

function createUsageIndex(files, usages) {
  const reexportsByFile = new Map(files.map((file, index) => [file, usages[index].reexports]));
  const used = new Map();
  const pending = [];

  function mark(file, name) {
    pending.push([file, name]);
    while (pending.length) {
      const [target, wanted] = pending.pop();
      const names = used.get(target) ?? new Set();
      used.set(target, names);
      if (names.has(everything) || names.has(wanted)) continue;
      names.add(wanted);
      for (const reexport of reexportsByFile.get(target) ?? []) {
        queueReexportDependencies(wanted, reexport, pending);
      }
    }
  }
  return {
    markImport({ to, names }) {
      if (names === 'all') mark(to, everything);
      else for (const name of names) mark(to, name);
    },
    markEverything: (file) => mark(file, everything),
    isUsed(file, name) {
      const names = used.get(file);
      return Boolean(names) && (names.has(everything) || names.has(name));
    },
  };
}

function queueReexportDependencies(wanted, reexport, pending) {
  if (wanted === everything) {
    if (reexport.pairs) for (const pair of reexport.pairs) pending.push([reexport.to, pair.local]);
    else pending.push([reexport.to, everything]);
  } else if (reexport.pairs) {
    for (const pair of reexport.pairs) if (pair.exported === wanted) pending.push([reexport.to, pair.local]);
  } else if (reexport.namespace === wanted) pending.push([reexport.to, everything]);
  else if (reexport.star && wanted !== 'default') pending.push([reexport.to, wanted]);
}

const sourceSuffixes = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

// Finds the project file a workspace package name points at when TypeScript could not (dependencies not installed).
// Packages that are named but not found are collected, because usage inside them is then incomplete.
function createWorkspaceResolver(fileSet, workspacePackages) {
  const incompleteDirectories = new Set();
  function resolveSpecifier(specifier) {
    for (const [name, directory] of workspacePackages) {
      if (specifier !== name && !specifier.startsWith(name + '/')) continue;
      const subpath = specifier.slice(name.length + 1).replace(/\.[cm]?js$/, '');
      const bases = subpath
        ? [`${directory}/${subpath}`, `${directory}/src/${subpath}`]
        : [`${directory}/src/index`, `${directory}/index`];
      for (const base of bases) {
        const found = sourceSuffixes.map((suffix) => base + suffix).find((candidate) => fileSet.has(candidate));
        if (found) return found;
      }
      incompleteDirectories.add(directory);
      return;
    }
  }
  return { resolveSpecifier, incompleteDirectories };
}

// Cross-file rules: an export nothing imports, and a source file nothing imports that is not an entry point.
function checkUnusedModules({
  files,
  usages,
  declarations = [],
  isEntryPoint,
  isToolingFile,
  workspacePackages,
  isPrivateApplication,
  operatorScripts,
}) {
  const index = createUsageIndex(files, usages);
  const workspace = createWorkspaceResolver(new Set(files), workspacePackages);
  const referenced = new Set();
  function markImports({ imports, unresolved }) {
    for (const item of imports) {
      referenced.add(item.to);
      index.markImport(item);
    }
    for (const { specifier, names } of unresolved) {
      const to = workspace.resolveSpecifier(specifier);
      if (!to) continue;
      referenced.add(to);
      index.markImport({ to, names });
    }
  }
  files.forEach((file, position) => {
    if (
      operatorScripts?.commands.has(file) ||
      (usages[position].reportsCliFailure && operatorScripts?.mentions.has(file))
    )
      referenced.add(file);
    if (isEntryPoint(file) || usages[position].executable) index.markEverything(file);
    markImports(usages[position]);
    for (const reexport of usages[position].reexports) referenced.add(reexport.to);
  });
  // A declaration file's re-exports are consumed by whoever reads the declarations, so they use the whole module.
  for (const usage of declarations) {
    markImports(usage);
    for (const { to } of usage.reexports) markImports({ imports: [{ to, names: 'all' }], unresolved: [] });
  }
  // A barrel is a consumer even if no local file imports the name from that barrel.
  const exposed = createUsageIndex(files, usages);
  const uncertainNames = new Set();
  const missingRuntimeFiles = new Set();
  for (const usage of [...usages, ...declarations]) {
    for (const specifier of usage.uncertainRuntimeImports ?? []) {
      const to = workspace.resolveSpecifier(specifier);
      if (to) exposed.markEverything(to);
      else if (specifier.startsWith('.')) {
        // A missing build output such as dist/main.js might be this project's src/main.ts.
        // A relative literal can also refer to a directory's index. Keep both names public.
        const basename = path.posix.basename(specifier.replace(/\.[cm]?[jt]sx?$/, ''));
        missingRuntimeFiles.add(basename);
        missingRuntimeFiles.add(basename + '/index');
      } else missingRuntimeFiles.add(everything);
    }
    for (const item of usage.reexports) {
      exposed.markImport({ to: item.to, names: item.pairs ? item.pairs.map(({ local }) => local) : 'all' });
    }
    markPotentialTypeConsumers(usage, workspace, exposed, uncertainNames);
  }

  const dynamicSites = files.flatMap((file, position) =>
    isToolingFile(file) ? [] : usages[position].dynamicUnresolved.map((site) => ({ file, site })),
  );
  const anywhereSite = dynamicSites.find(({ site }) => !site.directory);

  function contextFor(file) {
    const reaching =
      anywhereSite ?? dynamicSites.find(({ site }) => site.directory === '.' || file.startsWith(site.directory + '/'));
    if (reaching) {
      return `A non-literal import or require (${reaching.file}:${reaching.site.line}) can load files here, so this may be loaded dynamically.`;
    }
    for (const directory of workspace.incompleteDirectories) {
      if (file.startsWith(directory + '/'))
        return 'Other packages import this package by a name or path that could not be resolved, so usage may be missing.';
    }
  }

  const findings = [];
  files.forEach((file, position) => {
    if (isEntryPoint(file) || usages[position].executable || usages[position].exportEquals) return;
    const contextualReason = contextFor(file);
    const context = contextualReason ? { contextualReason } : {};
    const runtimeName = file.replace(/\.[cm]?[jt]sx?$/, '');
    const unknownRuntimeConsumer =
      missingRuntimeFiles.has(everything) ||
      missingRuntimeFiles.has(path.posix.basename(runtimeName)) ||
      missingRuntimeFiles.has(runtimeName.split('/').slice(-2).join('/'));
    if (!referenced.has(file)) {
      findings.push({
        file,
        line: 1,
        column: 1,
        ruleId: 'unreferenced-file',
        message:
          'No scanned file imports this module. Check deployment commands, framework discovery and manual scripts before removing it. For a tool entry point, check its package.json or nest-cli.json configuration.',
        ...context,
      });
      return;
    }
    const reported = new Set();
    for (const exported of usages[position].exports) {
      if (reported.has(exported.name) || index.isUsed(file, exported.name)) continue;
      reported.add(exported.name);
      const fix =
        exported.makePrivate &&
        !contextualReason &&
        !(exported.runtime && unknownRuntimeConsumer) &&
        isPrivateApplication?.(file) &&
        !exposed.isUsed(file, exported.name) &&
        !uncertainNames.has(everything) &&
        !uncertainNames.has(exported.name)
          ? {
              changes: [exported.makePrivate],
              requiresReview: true,
              note: exported.forwardsImportedType
                ? 'Removes the re-export and the type-only import that only it used. Check external TypeScript consumers before removing it.'
                : 'This declaration has local callers. Check external TypeScript consumers, runtime module lookups and test mocks before removing its export.',
            }
          : undefined;
      findings.push({
        file,
        line: exported.line,
        column: exported.column,
        ruleId: 'unused-export',
        message: `No scanned file imports the export \`${exported.name}\`. Check external callers and public types before making it private. Keep the declaration if the module uses it or its initialization has side effects.`,
        ...(fix &&
          (exported.needsCompiler
            ? { suggestedRecipe: 'verified-private-types', exportName: exported.name }
            : { fix })),
        ...context,
      });
    }
  });
  return findings;
}

function markPotentialTypeConsumers(usage, workspace, exposed, uncertainNames) {
  for (const item of usage.uncertainTypeImports ?? []) {
    const to = workspace.resolveSpecifier(item.specifier);
    if (to) exposed.markImport({ to, names: item.names });
    else if (item.names === 'all') uncertainNames.add(everything);
    else for (const name of item.names) uncertainNames.add(name);
  }
}

module.exports = { checkUnusedModules };
