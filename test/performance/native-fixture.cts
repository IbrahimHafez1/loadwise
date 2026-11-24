import path from 'node:path';
import { requireNativeSourceFile } from '../types/native-program.cjs';
import { requireNative } from '../../lib/performance/native-runtime.cjs';
import { requireWithSyntax, selectNativeSyntax } from '../../lib/performance/compiler.cjs';
import { adaptProgram } from '../../lib/performance/native-checker.cjs';
import type { FileMap } from '../types/project-files.cjs';
import type { PerformancePolicy } from '../../lib/performance/types/performance-policy.cjs';
import type * as Analyze from '../../lib/performance/analyze.cjs';
const { API, ModuleKind, ModuleResolutionKind } = requireNative('typescript/sync');
const { ScriptTarget } = requireNative('typescript/ast');
const { createFileSystemWithLib } = requireNative('typescript/fs');

import nativeSyntax from '../../lib/performance/native-syntax.cjs';
type AnalyzeModule = typeof Analyze;
const analyzePath = require.resolve('../../lib/performance/analyze.cjs');

// A suite that already loaded the TypeScript 6 rules (to build its own programs) cannot switch the
// process to the native syntax, so the rules are loaded as private copies instead.
function loadAnalyzeFile(): AnalyzeModule['analyzeFile'] {
  try {
    selectNativeSyntax(nativeSyntax);
    const analyzeModule: AnalyzeModule = require(analyzePath);
    return analyzeModule.analyzeFile;
  } catch {
    return requireWithSyntax<AnalyzeModule>(analyzePath, nativeSyntax).analyzeFile;
  }
}
const analyzeFile = loadAnalyzeFile();

function lint(source: string, files: FileMap, policy?: PerformancePolicy) {
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
        const adapted = adaptProgram(program, { strict: true });
        return analyzeFile(adapted, requireNativeSourceFile(program, main), policy);
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

export { lint };
