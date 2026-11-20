'use strict';

const path = require('node:path');
const { requireNative } = require('../lib/native-runtime.cjs');
const { API, ModuleKind, ModuleResolutionKind } = requireNative('typescript/sync');
const { ScriptTarget } = requireNative('typescript/ast');
const { createFileSystemWithLib } = requireNative('typescript/fs');
const { selectNativeSyntax } = require('../lib/compiler.cjs');
const { adaptProgram } = require('../lib/native-checker.cjs');

selectNativeSyntax(require('../lib/native-syntax.cjs'));
const { analyzeFile } = require('../lib/analyze.cjs');

function lint(source, files, policy) {
  const root = path.join(__dirname, 'virtual-project');
  const main = path.join(root, 'main.ts');
  const entries = Object.entries({ 'main.ts': source, ...files })
    .map(([name, contents]) => [path.join(root, name), contents]);
  const rootFiles = entries.filter(([name]) =>
    !name.includes(path.sep + 'node_modules' + path.sep) && /\.[cm]?[jt]sx?$/.test(name)).map(([name]) => name);
  const api = new API();
  try {
    const snapshot = api.createSnapshot({
      fileSystem: createFileSystemWithLib(entries),
      createPrograms: [{ rootFiles, compilerOptions: {
        target: ScriptTarget.ES2022, module: ModuleKind.NodeNext, moduleResolution: ModuleResolutionKind.NodeNext,
        strict: true, allowJs: true, skipLibCheck: true, types: [], lib: ['es2022'],
      } }],
    });
    try {
      const program = snapshot.operation.createdPrograms[0];
      try { return analyzeFile(adaptProgram(program, { strict: true }), program.getSourceFile(main), policy); }
      finally { program.dispose(); }
    } finally { snapshot.dispose(); }
  } finally { api.close(); }
}

module.exports = { lint };
