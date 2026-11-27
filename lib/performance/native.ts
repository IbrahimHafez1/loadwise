import fs from 'node:fs';
import path from 'node:path';
import {
  compareFindings,
  isInScope,
  isSourceInput,
  mergeFinding,
  scanEntries,
  relativeToWorkingDirectory,
  resolveConfig,
} from './source-inputs.js';
import { withoutEmitOptions } from './emit-options.js';
import { selectNativeSyntax } from './compiler.js';
import { requireNative, executable } from './native-runtime.js';
import { withWorkspaceSources } from './native-workspaces.js';
import { recordSkippedFile } from './scan-outcome.js';
import type { CompilerOptions, SourceFile } from 'typescript';
import type { Finding, RulePolicy, ScanResult, SkippedFile } from '../shared/types.js';
import type { NativeApi, NativeBinding, NativeDiagnostic, NativeProgram } from './types/native-typescript.js';
import type { SourceAnalyzer } from './types/source-analyzer.js';
import type { ProgramAdapter } from '../shared/types.js';
import { unscannedJavaScript, type LeftOutScope } from './unscanned-javascript.js';
import nativeSyntax from './native-syntax.js';
import * as nativeChecker from './native-checker.js';
import * as performanceAnalyze from './analyze.js';
import { sourcePillarOf } from '../shared/rule-registry.js';
import { repositoryRoot, standaloneFindings } from '../reliability/standalone-sources.js';
import * as schemaTooling from './schema-tooling.js';

// What a caller passes: one config or several, or explicit files; `onlyFiles` keeps just the
// changed ones.
const noInputsCode = 18003;

interface NativeAnalysisOptions {
  project?: string | string[];
  files?: string[];
  /** Sources of workspace packages without a config, checked with the standalone defaults beside the configs. */
  standaloneFiles?: readonly string[];
  policy?: RulePolicy;
  fallback?: boolean;
  onlyFiles?: (filename: string) => boolean;
  analyzers?: SourceAnalyzer[];
}

// With fallback, an unavailable compiler or a rejected config asks the caller to run the JS engine
// instead.
interface NativeFallback {
  fallback: true;
  reason?: string;
}

type NativeOutcome = (ScanResult & { fallback?: undefined }) | NativeFallback;

// One config's roots, its options, and which of the roots to report on.
type ScanProject = [roots: string[], options: CompilerOptions, analyzes: (filename: string) => boolean];

function openCompiler(): { api: NativeApi; binding: NativeBinding } {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('--native requires Node.js 22.13 or newer.');
  const tsserverPath = executable();
  const binding = requireNative('typescript/sync');
  return { api: new binding.API({ tsserverPath }), binding };
}

// Raised only in fallback mode, while the process can still switch to the JS compiler.
class IncompatibleProject extends Error {}

// TypeScript's "Cannot find type definition file for '{0}'." diagnostic.
const missingTypeLibraryCode = 2688;
// TypeScript's "File '{0}' not found." diagnostic.
const missingFileCode = 6053;

// The package a missing `extends` names; relative and absolute paths are the project's own
// mistakes.
function missingPackageBase(diagnostic: NativeDiagnostic): string | undefined {
  if (diagnostic.code !== missingFileCode) return undefined;
  const missing = /'([^']+)'/.exec(diagnostic.text)?.[1];
  return missing !== undefined && !/^(?:\.|\/|[a-z]:)/i.test(missing) ? missing : undefined;
}

// TypeScript 7 removed `baseUrl`, so its mapping moves into `paths`, as in the TypeScript 7
// migration. The parser has already resolved `baseUrl` against the config that declared it, even
// through `extends`, and earlier compilers resolve every `paths` target against it; absolute
// targets keep that meaning wherever `paths` was declared. Bare imports that match no pattern still
// looked in `baseUrl`, which a catch-all pattern keeps, since the longest matching pattern wins.
// The config on disk is left untouched.
function withoutBaseUrl(options: CompilerOptions): CompilerOptions {
  if (options.baseUrl === undefined) return options;
  const { baseUrl, ...rest } = options;
  const fromBaseUrl = (target: string) => path.resolve(String(baseUrl), target).replaceAll('\\', '/');
  const paths: Record<string, string[]> = { '*': [fromBaseUrl('*')] };
  for (const [pattern, targets] of Object.entries(options.paths ?? {})) paths[pattern] = targets.map(fromBaseUrl);
  return { ...rest, paths };
}

// TypeScript 7 rejects these options only to force their removal; dropping a value that is off, or
// that only shaped emit, leaves the types the rules read unchanged. `esModuleInterop` and
// `allowSyntheticDefaultImports` off only turn default imports of CommonJS modules from errors into
// the module type, which TypeScript 7 always does.
const removedWhenOff: (keyof CompilerOptions)[] = ['esModuleInterop', 'allowSyntheticDefaultImports', 'alwaysStrict'];
const removedWhenSet: (keyof CompilerOptions)[] = ['downlevelIteration', 'outFile'];
// Rejected as unknown options. `keyofStringsOnly` is absent because it changes the type of `keyof`.
const unknownOptionsWithoutEffect = new Set([
  'importsNotUsedAsValues',
  'preserveValueImports',
  'suppressImplicitAnyIndexErrors',
  'suppressExcessPropertyErrors',
  'noStrictGenericChecks',
  'noImplicitUseStrict',
  'charset',
  'out',
]);
const unknownOptionCode = 5023;
// TypeScript's ES5 target, which the TypeScript 7 enum no longer lists.
const es5Target = 1;
const es2015Target = 2;

function isIgnorableUnknownOption(diagnostic: NativeDiagnostic): boolean {
  if (diagnostic.code !== unknownOptionCode) return false;
  const option = /'([^']+)'/.exec(diagnostic.text)?.[1];
  return option !== undefined && unknownOptionsWithoutEffect.has(option);
}

// `node10` ignores package `exports`, as do the other choices TypeScript 7 offers except `bundler`,
// which keeps node10's extensionless and directory-index imports and accepts `module` commonjs,
// preserve and es2015+, so a commonjs project keeps its `module`. `nodenext` would also demand
// `module: nodenext` and import extensions.
// AMD, UMD and System are swapped for ESNext only beside an explicit node10, whose resolution they do not change;
// without it they implied `classic`, which stays rejected. ES5 only moves to ES2015 when `lib` is
// explicit, because the target otherwise picks the default libraries that the rules' types come
// from.
function withoutRemovedOptions(
  options: CompilerOptions,
  { ModuleKind, ModuleResolutionKind }: Pick<NativeBinding, 'ModuleKind' | 'ModuleResolutionKind'>,
): CompilerOptions {
  const result = { ...options };
  for (const name of removedWhenOff) if (result[name] === false) delete result[name];
  for (const name of removedWhenSet) delete result[name];
  if (result.moduleResolution === ModuleResolutionKind.Node10) {
    result.moduleResolution = ModuleResolutionKind.Bundler;
    const needsModernModule =
      result.module !== undefined && [ModuleKind.AMD, ModuleKind.UMD, ModuleKind.System].includes(result.module);
    if (needsModernModule) result.module = ModuleKind.ESNext;
  }
  if (result.target === es5Target && result.lib !== undefined) result.target = es2015Target;
  return result;
}

// With fallback, an unavailable compiler or a rejected config returns { fallback: true, reason }
// before the native syntax is selected, so the caller can run the JS engine in this process.
// `project` is one config or an array of them. `onlyFiles` limits the roots of each config to the changed files;
// imports still resolve through the config. `analyzers` defaults to the performance rules; each
// one's
// `analyzeFile` must load its rules lazily, after the native syntax is selected.
function analyzeNative({
  project,
  files = [],
  standaloneFiles = [],
  policy,
  fallback = false,
  onlyFiles,
  analyzers,
}: NativeAnalysisOptions): NativeOutcome {
  let compiler: ReturnType<typeof openCompiler>;
  try {
    compiler = openCompiler();
  } catch (error) {
    if (fallback) return { fallback: true };
    throw error;
  }
  const { api, binding } = compiler;
  let adaptProgram: (program: NativeProgram, options: CompilerOptions) => ProgramAdapter;
  let enableSchemaTooling: (adapter: ProgramAdapter) => void;
  // Chosen once the native syntax is selected, because the default analyzer loads its rules lazily.
  let selectedAnalyzers: SourceAnalyzer[] = [];
  const visitedConfigs = new Set<string>();
  // Folders scanned with a config that leaves JavaScript out.
  const scopesWithoutJs = new Map<string, LeftOutScope>();
  // Folders whose files no program may have analyzed, listed once the programs are done.
  const standaloneRoots = new Set<string>();
  const scanned = new Set<string>();
  const findings = new Map<string, Finding>();
  const skippedFiles: SkippedFile[] = [];
  const canonical = (filename: string) => api.getCanonicalFileName(path.resolve(filename));

  // A `types` entry that is not installed leaves only those globals unresolved, as in the
  // TypeScript engine.
  const reportedTypeLibraries = new Set<string>();
  function withoutMissingTypeLibraries(diagnostics: NativeDiagnostic[] = []): NativeDiagnostic[] {
    const missing = diagnostics.filter((diagnostic) => diagnostic.code === missingTypeLibraryCode);
    const names = missing
      .map((diagnostic) => /'([^']+)'/.exec(diagnostic.text)?.[1])
      .filter((name): name is string => !!name && !reportedTypeLibraries.has(name));
    if (names.length) {
      names.forEach((name) => reportedTypeLibraries.add(name));
      console.error(`Note: type libraries not installed (${names.join(', ')}); analysis continued without them.`);
    }
    return diagnostics.filter((diagnostic) => diagnostic.code !== missingTypeLibraryCode);
  }

  function checkErrors(diagnostics: NativeDiagnostic[]): void {
    diagnostics = withoutMissingTypeLibraries(diagnostics);
    if (diagnostics.length) {
      throw new Error(binding.formatDiagnostics(diagnostics, api).trim());
    }
  }

  // An `extends` naming a package that is not installed leaves the config's own settings, as in the
  // TypeScript engine.
  const notedBases = new Set<string>();
  function withoutMissingPackageBases(diagnostics: NativeDiagnostic[] = []): NativeDiagnostic[] {
    const isMissingBase = (diagnostic: NativeDiagnostic) => missingPackageBase(diagnostic) !== undefined;
    for (const diagnostic of diagnostics.filter(isMissingBase)) {
      // Referenced projects usually share their bases, so each missing base is noted once.
      const base = missingPackageBase(diagnostic);
      if (base === undefined || notedBases.has(base)) continue;
      notedBases.add(base);
      const { line, character } = diagnostic.startPosition;
      const location = `${path.resolve(diagnostic.fileName)}(${line + 1},${character + 1})`;
      console.error(
        `Note: ${location} ${diagnostic.text} Checked with this config's own settings until it is installed.`,
      );
    }
    return diagnostics.filter((diagnostic) => !isMissingBase(diagnostic));
  }

  function checkConfig(diagnostics: NativeDiagnostic[] | undefined): void {
    diagnostics = withoutMissingTypeLibraries(withoutMissingPackageBases(diagnostics));
    if (fallback && diagnostics?.length) {
      throw new IncompatibleProject([...new Set(diagnostics.map((diagnostic) => diagnostic.text))].join(' '));
    }
    checkErrors(diagnostics);
  }

  // `analyzes` picks the roots to report on; the others still load for types.
  function scan(roots: string[], options: CompilerOptions, analyzes: (filename: string) => boolean): void {
    const inputs = roots.filter((filename: string) => isSourceInput(filename) && analyzes(filename));
    if (!inputs.length) return;
    const program = api.createProgram(roots, { ...options, noEmit: true });
    try {
      checkErrors(program.getProgramDiagnostics());
      // The native service accepts an array, saving a round-trip per input.
      const syntaxErrorsByFile = Map.groupBy(program.getSyntacticDiagnostics(inputs), (diagnostic) =>
        canonical(diagnostic.fileName),
      );
      const adapter = adaptProgram(program, options);
      if (!files.length && !onlyFiles && visitedConfigs.size === 1) enableSchemaTooling(adapter);
      const localFiles = new Set<SourceFile>();
      for (const filename of inputs) {
        const source = program.getSourceFile(filename);
        if (!source) throw new Error('Unable to load source: ' + filename);
        if (localFiles.has(source)) continue;
        localFiles.add(source);
        const key = canonical(source.fileName);
        const file = relativeToWorkingDirectory(source.fileName);
        const syntaxErrors = syntaxErrorsByFile.get(key);
        if (syntaxErrors) {
          const reason = binding.formatDiagnostics([syntaxErrors[0]], api).trim();
          recordSkippedFile(skippedFiles, { file, reason }, `${reason} Skipped that file, which does not parse.`);
          continue;
        }
        const fileFindings = analyzeWithEach(adapter, source, file);
        if (!fileFindings) continue;
        scanned.add(key);
        for (const finding of fileFindings) {
          // A rule can report in another file than the scanned one, so that file is part of the key.
          const findingKey = finding.file === undefined ? key : canonical(finding.file);
          if (finding.file !== undefined) finding.file = relativeToWorkingDirectory(finding.file);
          mergeFinding(
            findings,
            `${findingKey}\0${finding.line}\0${finding.column}\0${finding.ruleId}\0${finding.message}`,
            finding,
          );
        }
      }
    } finally {
      program.dispose();
    }
  }

  // One failing analyzer must not hide the others' findings; a file counts as scanned once any
  // analyzer read it.
  function analyzeWithEach(adapter: ProgramAdapter, source: SourceFile, file: string): Finding[] | undefined {
    let fileFindings: Finding[] | undefined;
    for (const analyzer of selectedAnalyzers) {
      try {
        const analyzerFindings = analyzer.analyzeFile(adapter, source, policy);
        if (selectedAnalyzers.length > 1)
          for (const finding of analyzerFindings) finding.pillar = sourcePillarOf(finding.ruleId, analyzer.pillar);
        fileFindings = [...(fileFindings ?? []), ...analyzerFindings];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordSkippedFile(
          skippedFiles,
          { file, reason: message },
          `The ${analyzer.pillar} analysis of ${file} failed (${message}). Skipped that file.`,
        );
      }
    }
    return fileFindings;
  }

  // Collects every config with source inputs, in scan order, after validating its options.
  function visitConfig(
    filename: string,
    projects: ScanProject[],
    scope?: string,
    companion?: boolean,
    explicit?: boolean,
  ): void {
    // realpath resolves the reference even before the native API initializes.
    const key = fs.realpathSync.native(filename);
    // A companion already visited as a reference still sets its folder's JavaScript boundary.
    if (visitedConfigs.has(key)) {
      if (companion) scopesWithoutJs.delete(scope ?? path.dirname(filename));
      return;
    }
    visitedConfigs.add(key);
    const parsed = api.parseConfigFile(filename);
    // `checkJs` turns JavaScript on when `allowJs` is unset. A discovered config that lists no inputs because it
    // leaves the JavaScript out still has that JavaScript checked, so TS18003 waits for the final source count.
    const allowsJs = parsed.options.allowJs ?? parsed.options.checkJs;
    checkConfig(
      parsed.errors?.filter(
        (diagnostic) =>
          !isIgnorableUnknownOption(diagnostic) && !(diagnostic.code === noInputsCode && !allowsJs && !explicit),
      ),
    );
    const options = withWorkspaceSources(
      withoutRemovedOptions(withoutBaseUrl(withoutEmitOptions(parsed.options)), binding),
      path.dirname(filename),
    );
    for (const reference of parsed.projectReferences ?? []) {
      visitConfig(resolveConfig(reference.path), projects, scope, false, explicit);
    }
    // The companion jsconfig names the JavaScript the project checks, so its folder needs no fallback.
    if (companion) scopesWithoutJs.delete(scope ?? path.dirname(filename));
    else if (!allowsJs) {
      const jsScope = scope ?? path.dirname(filename);
      const leftOut = scopesWithoutJs.get(jsScope) ?? { configs: [], checksLeftOut: !explicit };
      leftOut.configs.push(filename);
      scopesWithoutJs.set(jsScope, leftOut);
    }
    standaloneRoots.add(scope ?? repositoryRoot(path.dirname(filename)));
    const rootFiles = onlyFiles ? parsed.fileNames.filter(onlyFiles) : parsed.fileNames;
    if (!rootFiles.some((filename: string) => isSourceInput(filename) && isInScope(scope, filename))) return;
    // Option diagnostics do not depend on root files, so an empty program reports them cheaply.
    const optionsProgram = api.createProgram([], { ...options, noEmit: true });
    try {
      checkConfig(optionsProgram.getProgramDiagnostics());
    } finally {
      optionsProgram.dispose();
    }
    // The companion jsconfig only adds what the tsconfig left out; scans run in visit order.
    const isNew = (filename: string) => !companion || !scanned.has(canonical(filename));
    projects.push([rootFiles, options, (filename: string) => isInScope(scope, filename) && isNew(filename)]);
  }

  function selectSyntax() {
    selectNativeSyntax(nativeSyntax);
    ({ adaptProgram } = nativeChecker);
    selectedAnalyzers = analyzers ?? [{ pillar: 'performance', analyzeFile: performanceAnalyze.analyzeFile }];
    ({ enableSchemaTooling } = schemaTooling);
  }

  try {
    const projects: ScanProject[] = [];
    // Explicit files, and JavaScript a config without `allowJs` leaves out, have no config of their own.
    const { ScriptTarget } = requireNative('typescript/ast');
    const standaloneOptions: CompilerOptions = {
      target: ScriptTarget.ES2022,
      module: binding.ModuleKind.NodeNext,
      allowJs: true,
      checkJs: false,
      skipLibCheck: true,
      jsx: binding.JsxEmit.Preserve,
      ...(policy && { strictNullChecks: true }),
    };
    if (files.length) {
      const roots = files.map((filename) => {
        if (!isSourceInput(filename) || !fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) {
          throw new Error('Expected an existing JS or TS source file: ' + filename);
        }
        return path.resolve(filename);
      });
      projects.push([roots, standaloneOptions, () => true]);
    } else {
      for (const { config, scope, companion, explicit } of scanEntries(project)) {
        visitConfig(config, projects, scope, companion, explicit);
      }
    }
    selectSyntax();
    for (const [roots, options, analyzes] of projects) scan(roots, options, analyzes);
    const isScanned = (filename: string) => scanned.has(canonical(filename));
    const leftOut = unscannedJavaScript(scopesWithoutJs, isScanned, onlyFiles);
    const configless = standaloneFiles.filter(
      (filename) => !isScanned(filename) && (!onlyFiles || onlyFiles(filename)),
    );
    scan([...leftOut.files, ...configless], standaloneOptions, () => true);
    leftOut.note();
    if (!scanned.size && !onlyFiles && !skippedFiles.length)
      throw new Error('No JavaScript or TypeScript source files to check.');
    if (!files.length && !onlyFiles && selectedAnalyzers.some((analyzer) => analyzer.pillar === 'reliability')) {
      for (const finding of standaloneFindings(standaloneRoots, (file) => scanned.has(canonical(file)))) {
        const file = finding.file ?? '';
        finding.file = relativeToWorkingDirectory(file);
        if (selectedAnalyzers.length > 1) finding.pillar = sourcePillarOf(finding.ruleId, 'reliability');
        mergeFinding(
          findings,
          `${canonical(file)}\0${finding.line}\0${finding.column}\0${finding.ruleId}\0${finding.message}`,
          finding,
        );
      }
    }
    return {
      scannedFiles: scanned.size,
      findings: [...findings.values()].sort(compareFindings),
      ...(skippedFiles.length && { skippedFiles }),
    };
  } catch (error) {
    if (error instanceof IncompatibleProject) return { fallback: true, reason: error.message };
    throw error;
  } finally {
    api.close();
  }
}

export { analyzeNative };
