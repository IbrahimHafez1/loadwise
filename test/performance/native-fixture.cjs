'use strict';

const path = require('node:path');
const { requireNative } = require('../../lib/performance/native-runtime.cjs');
const { API, ModuleKind, ModuleResolutionKind } = requireNative('typescript/sync');
const { ScriptTarget } = requireNative('typescript/ast');
const { createFileSystemWithLib } = requireNative('typescript/fs');
const { requireWithSyntax, selectNativeSyntax } = require('../../lib/performance/compiler.cjs');
const { adaptProgram } = require('../../lib/performance/native-checker.cjs');

const nativeSyntax = require('../../lib/performance/native-syntax.cjs');
const analyzePath = require.resolve('../../lib/performance/analyze.cjs');

// A suite that already loaded the TypeScript 6 rules (to build its own programs) cannot switch the process to the
// native syntax, so the rules are loaded as private copies instead.
function loadAnalyzeFile() {
  try {
    selectNativeSyntax(nativeSyntax);
    return require(analyzePath).analyzeFile;
  } catch {
    return requireWithSyntax(analyzePath, nativeSyntax).analyzeFile;
  }
}
const analyzeFile = loadAnalyzeFile();

function lint(source, files, policy) {
  const root = path.join(__dirname, 'virtual-project');
  const main = path.join(root, 'main.ts');
  const entries = Object.entries({ 'main.ts': source, ...files }).map(([name, contents]) => [
    path.join(root, name),
    contents,
  ]);
  const rootFiles = entries
    .filter(([name]) => !name.includes(path.sep + 'node_modules' + path.sep) && /\.[cm]?[jt]sx?$/.test(name))
    .map(([name]) => name);
  const api = new API();
  try {
    const snapshot = api.createSnapshot({
      fileSystem: createFileSystemWithLib(entries),
      createPrograms: [
        {
          rootFiles,
          compilerOptions: {
            target: ScriptTarget.ES2022,
            module: ModuleKind.NodeNext,
            moduleResolution: ModuleResolutionKind.NodeNext,
            strict: true,
            allowJs: true,
            skipLibCheck: true,
            types: [],
            lib: ['es2022'],
          },
        },
      ],
    });
    try {
      const program = snapshot.operation.createdPrograms[0];
      try {
        return analyzeFile(adaptProgram(program, { strict: true }), program.getSourceFile(main), policy);
      } finally {
        program.dispose();
      }
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

module.exports = { lint };
