import path from 'node:path';
import * as bundled from 'typescript';
import type * as TypeScript from 'typescript';
import type { SourceFile } from 'typescript';
import type { CheckerAdapter } from '../shared/types.js';

// The CLI selects its compiler once, before running the shared source rules. ESM live bindings
// let `withSyntax` temporarily swap `ts` (e.g. for site fixes that parse with bundled TypeScript)
// without reloading modules.
let ts: typeof TypeScript = bundled;
let nativeSelected: typeof TypeScript | undefined;

function selectNativeSyntax(nativeSyntax: typeof TypeScript): void {
  if (nativeSelected && nativeSelected !== nativeSyntax) throw new Error('Run --native in a fresh process.');
  nativeSelected = nativeSyntax;
  ts = nativeSyntax;
}

/**
 * Temporarily swaps the live `ts` binding for `fn`. `fn` MUST be synchronous; passing an async
 * function would reset `ts` before the first `await` resumes.
 */
function withSyntax<Result>(chosenSyntax: typeof TypeScript, fn: () => Result): Result {
  const previous = ts;
  ts = chosenSyntax;
  try {
    const result = fn();
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result &&
      typeof result.then === 'function'
    ) {
      throw new TypeError('withSyntax() callback must be synchronous and must not return a Promise/thenable.');
    }
    return result;
  } finally {
    ts = previous;
  }
}

// TypeScript 6 dropped the no-default-lib marker from its lib files, so they are recognized by
// location.
let defaultLibraryFolder: string | undefined;
function isBundledLibrary(fileName: string) {
  defaultLibraryFolder ??= path.dirname(ts.getDefaultLibFilePath({})).replaceAll('\\', '/') + '/';
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

function loadSyntax(): typeof TypeScript {
  return ts;
}

export { ts, loadSyntax, isDefaultLibrary, selectNativeSyntax, withSyntax };
