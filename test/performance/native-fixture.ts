import path from 'node:path';
import { requireNativeSourceFile } from '../types/native-program.js';
import { requireNative } from '../../lib/performance/native-runtime.js';
import { withSyntax } from '../../lib/performance/compiler.js';
import { adaptProgram } from '../../lib/performance/native-checker.js';
import { analyzeFile } from '../../lib/performance/analyze.js';
import type { FileMap } from '../types/project-files.js';
import type { PerformancePolicy } from '../../lib/performance/types/performance-policy.js';
const { API, ModuleKind, ModuleResolutionKind } = requireNative('typescript/sync');
const { ScriptTarget } = requireNative('typescript/ast');
const { createFileSystemWithLib } = requireNative('typescript/fs');

import nativeSyntax from '../../lib/performance/native-syntax.js';

function lint(source: string, files: FileMap, policy?: PerformancePolicy) {
  const root = path.join(import.meta.dirname, 'virtual-project');
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
        return withSyntax(nativeSyntax, () => analyzeFile(adapted, requireNativeSourceFile(program, main), policy));
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
