'use strict';

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
        if (wanted === everything) {
          if (reexport.pairs) for (const pair of reexport.pairs) pending.push([reexport.to, pair.local]);
          else pending.push([reexport.to, everything]);
        } else if (reexport.pairs) {
          for (const pair of reexport.pairs) if (pair.exported === wanted) pending.push([reexport.to, pair.local]);
        } else if (reexport.namespace === wanted) pending.push([reexport.to, everything]);
        else if (reexport.star && wanted !== 'default') pending.push([reexport.to, wanted]);
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
function checkUnusedModules({ files, usages, declarations = [], isEntryPoint, isToolingFile, workspacePackages }) {
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
    if (isEntryPoint(file)) index.markEverything(file);
    markImports(usages[position]);
    for (const reexport of usages[position].reexports) referenced.add(reexport.to);
  });
  // A declaration file's re-exports are consumed by whoever reads the declarations, so they use the whole module.
  for (const usage of declarations) {
    markImports(usage);
    for (const { to } of usage.reexports) markImports({ imports: [{ to, names: 'all' }], unresolved: [] });
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
    if (isEntryPoint(file) || usages[position].exportEquals) return;
    const contextualReason = contextFor(file);
    const context = contextualReason ? { contextualReason } : {};
    if (!referenced.has(file)) {
      findings.push({
        file,
        line: 1,
        column: 1,
        ruleId: 'unreferenced-file',
        message:
          'No file in the project imports this module and it is not a recognised entry point. A file nothing loads is dead weight that still has to be read and maintained. Delete it, or if a tool or a path-based loader runs it, list it as an entry point in package.json or nest-cli.json.',
        ...context,
      });
      return;
    }
    const reported = new Set();
    for (const exported of usages[position].exports) {
      if (reported.has(exported.name) || index.isUsed(file, exported.name)) continue;
      reported.add(exported.name);
      findings.push({
        file,
        line: exported.line,
        column: exported.column,
        ruleId: 'unused-export',
        message: `\`${exported.name}\` is exported but no file in the project imports it. An unused export widens the module's public surface and keeps dead code alive. Remove the \`export\` keyword, and the declaration too when nothing in this file uses it.`,
        ...context,
      });
    }
  });
  return findings;
}

module.exports = { checkUnusedModules };
