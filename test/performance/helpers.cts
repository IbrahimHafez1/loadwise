import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import type { CompilerOptions, SourceFile } from 'typescript';
import type { Finding, PerformanceRuleContext, ProgramAdapter } from '../../lib/shared/types.cjs';
import type { PerformancePolicy } from '../../lib/performance/types/performance-policy.cjs';
import type * as NativeFixture from './native-fixture.cjs';
import type * as PerformanceAnalyze from '../../lib/performance/analyze.cjs';

type FileMap = Readonly<Record<string, string>>;

function withProgram<Result>(
  source: string,
  files: FileMap,
  callback: (program: ProgramAdapter, sourceFile: SourceFile) => Result,
  compilerOptions: CompilerOptions = {},
): Result {
  const root = path.resolve(__dirname, 'virtual-project');
  const mainPath = path.join(root, 'main.ts');
  const options: CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    allowJs: true,
    skipLibCheck: true,
    types: [],
    lib: ['lib.es2022.d.ts'],
    ...compilerOptions,
  };
  const entries = Object.entries({ 'main.ts': source, ...files });
  const normalize = (name: string): string => path.normalize(path.resolve(name));
  const overlay = new Map(entries.map(([name, content]) => [normalize(path.join(root, name)), content]));
  const directories = new Set<string>();
  for (const filename of overlay.keys()) {
    let dir = path.dirname(filename);
    while (!directories.has(dir) && dir !== path.dirname(dir)) {
      directories.add(dir);
      dir = path.dirname(dir);
    }
  }
  const host = ts.createCompilerHost(options, true);
  const original = { ...host };
  const bundledLibs = normalize(path.dirname(ts.getDefaultLibFilePath(options)));
  // Packages must come from the fixture. Real ancestor installs would change an untyped test run.
  const allowPhysical = (name: string): boolean => {
    const absolute = normalize(name);
    return (
      !absolute.split(path.sep).includes('node_modules') ||
      absolute === bundledLibs ||
      absolute.startsWith(bundledLibs + path.sep)
    );
  };
  host.readFile = (name: string) =>
    overlay.get(normalize(name)) ?? (allowPhysical(name) ? original.readFile(name) : undefined);
  host.fileExists = (name: string) =>
    overlay.has(normalize(name)) || (allowPhysical(name) && original.fileExists(name));
  host.directoryExists = (name: string) =>
    directories.has(normalize(name)) || (allowPhysical(name) && original.directoryExists?.(name) === true);
  host.realpath = (name: string) => (overlay.has(normalize(name)) ? name : (original.realpath?.(name) ?? name));
  host.getSourceFile = (name, version, ...args) =>
    overlay.has(normalize(name))
      ? ts.createSourceFile(name, host.readFile(name) ?? '', version, true)
      : original.getSourceFile(name, version, ...args);
  const roots = [...overlay.keys()].filter(
    (name) => !name.includes(path.sep + 'node_modules' + path.sep) && /\.[cm]?[jt]sx?$/.test(name),
  );
  const program = ts.createProgram(roots, options, host);
  const mainSourceFile = program.getSourceFile(mainPath);
  assert.ok(mainSourceFile);
  return callback(program, mainSourceFile);
}

function lint(source: string, files: FileMap = {}, policy?: PerformancePolicy): Finding[] {
  if (process.env.PERF_CHECK_TEST_NATIVE === '1') {
    const nativeFixture: typeof NativeFixture = require('./native-fixture.cjs');
    return nativeFixture.lint(source, files, policy);
  }
  return withProgram(source, files, (program: ProgramAdapter, sourceFile: SourceFile) => {
    const { analyzeFile }: typeof PerformanceAnalyze = require('../../lib/performance/analyze.cjs');
    return analyzeFile(program, sourceFile, policy);
  });
}

// A rule context over `program` whose members default to inert stand-ins; tests override what they
// observe.
function createRuleContext(
  program: ProgramAdapter,
  overrides: Partial<PerformanceRuleContext> = {},
): PerformanceRuleContext {
  return {
    checker: program.getTypeChecker(),
    program,
    strictNullChecks: true,
    verbatimModuleSyntax: false,
    fireAndForgetNames: new Set(),
    isPackageType: () => false,
    isRepeated: () => false,
    report: () => {},
    ...overrides,
  };
}

// The reason a contextual finding carries; fails the test when the finding is firm.
function requireContextualReason(finding: Finding): string {
  assert.ok(finding.contextualReason, `${finding.ruleId} should be contextual`);
  return finding.contextualReason;
}

export { createRuleContext, lint, requireContextualReason, withProgram };
