import path from 'node:path';
import type * as TypeScript from 'typescript';
import type { SourceFile } from 'typescript';
import type { CheckerAdapter } from '../shared/types.cjs';

// The CLI selects its compiler once, before loading the shared source rules.
let syntax: typeof TypeScript | undefined;
function selectNativeSyntax(nativeSyntax: typeof TypeScript): void {
  if (syntax && syntax !== nativeSyntax) throw new Error('Run --native in a fresh process.');
  syntax = nativeSyntax;
}

// TypeScript 6 dropped the no-default-lib marker from its lib files, so they are recognized by
// location.
let defaultLibraryFolder: string | undefined;
function isBundledLibrary(fileName: string) {
  defaultLibraryFolder ??= path.dirname(loadSyntax().getDefaultLibFilePath({})).replaceAll('\\', '/') + '/';
  const normalized = fileName.replaceAll('\\', '/');
  return (
    normalized.startsWith(defaultLibraryFolder) &&
    /^lib\.[^/]*\.d\.ts$/.test(normalized.slice(defaultLibraryFolder.length))
  );
}

function isDefaultLibrary(checker: CheckerAdapter, sourceFile: SourceFile) {
  if (checker.isDefaultLibrary) return checker.isDefaultLibrary(sourceFile);
  return sourceFile.hasNoDefaultLib || isBundledLibrary(sourceFile.fileName);
}

// Loads `modulePath` and the lib modules it requires as private copies that see `chosenSyntax`, so
// code that works on another compiler's nodes (site fixes parse with the bundled TypeScript) can
// reuse rule helpers.
function requireWithSyntax<Module = Record<string, unknown>>(
  modulePath: string,
  chosenSyntax: typeof TypeScript,
): Module {
  if (loadSyntax() === chosenSyntax) return require(modulePath);
  // lib/shared holds rule helpers that read the selected syntax too, so they get private copies as
  // well.
  const libraryFolders = [__dirname, path.join(__dirname, '..', 'shared')].map((folder) => folder + path.sep);
  const isPrivate = (key: string) => key !== __filename && libraryFolders.some((folder) => key.startsWith(folder));
  const shared = Object.keys(require.cache).filter(isPrivate);
  const saved = shared.map((key): [string, NodeJS.Module | undefined] => [key, require.cache[key]]);
  shared.forEach((key) => delete require.cache[key]);
  const selected = syntax;
  syntax = chosenSyntax;
  try {
    return require(modulePath);
  } finally {
    syntax = selected;
    Object.keys(require.cache)
      .filter(isPrivate)
      .forEach((key) => delete require.cache[key]);
    for (const [key, cached] of saved) require.cache[key] = cached;
  }
}

// Rule modules call this once at load time and keep the result, so private copies made by
// requireWithSyntax keep the compiler that was selected while they loaded.
function loadSyntax(): typeof TypeScript {
  const loaded: typeof TypeScript = syntax ?? require('typescript');
  syntax = loaded;
  return loaded;
}

export { loadSyntax, isDefaultLibrary, selectNativeSyntax, requireWithSyntax };
