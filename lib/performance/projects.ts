import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { analyzeFile } from './analyze.js';
import { analyzeFile as analyzeReliabilityFile } from '../reliability/analyze.js';
import { repositoryRoot, standaloneFindings } from '../reliability/standalone-sources.js';
import { analyzeFile as analyzeAccessibilityFile } from '../accessibility/analyze.js';
import { sourcePillarOf } from '../shared/rule-registry.js';
import { withoutEmitOptions } from './emit-options.js';
import { enableSchemaTooling } from './schema-tooling.js';
import {
  collectUninstalledDependencies,
  collectUnresolvedPackages,
  formatMissingPackagesNote,
  formatUninstalledDependencyNote,
} from './missing-packages.js';
import {
  compareFindings,
  isInScope,
  isSourceInput,
  mergeFinding,
  scanEntries,
  relativeToWorkingDirectory,
  resolveConfig,
} from './source-inputs.js';
import { recordSkippedFile } from './scan-outcome.js';
import { missingPackageBase, workspacePackagesAround, workspaceSourceEntry } from '../shared/workspaces.js';
import type {
  CompilerHost,
  CompilerOptions,
  Diagnostic,
  DocumentRegistry,
  IScriptSnapshot,
  ParsedCommandLine,
  Program,
  SourceFile,
} from 'typescript';
import type { Finding, ProgramAdapter, ScanResult, SkippedFile } from '../shared/types.js';
import type { PerformancePolicy } from './types/performance-policy.js';
import type { ProgramScanOptions } from './types/program-scan.js';
import type { SourceAnalyzer } from './types/source-analyzer.js';
import { unscannedJavaScript, type LeftOutScope } from './unscanned-javascript.js';

// The file-system probes a scan caches; they replace the compiler host's own.
interface HostProbes {
  fileExists(filename: string): boolean;
  directoryExists(directory: string): boolean;
  readFile(filename: string): string | undefined;
}

// The parsed lib.*.d.ts files that several programs of one run share.
interface SharedLibs {
  registry: DocumentRegistry;
  snapshots: Map<string, IScriptSnapshot>;
}

type WorkspaceEntryFinder = (directory: string, subpath: string) => string | undefined;

// What a caller passes: one config or several, or explicit files; `onlyFiles` keeps just the
// changed ones.
interface SourceScanOptions {
  project?: string | string[];
  files: string[];
  policy?: PerformancePolicy;
  onlyFiles?: (filename: string) => boolean;
  analyzers?: SourceAnalyzer[];
  preRead?: ReadonlyMap<string, string | undefined>;
}
import { fileURLToPath } from 'node:url';
const compilerLibDirectory = path.dirname(fileURLToPath(import.meta.resolve('typescript')));
const bundledLibPattern = /^lib(?:\.[\w.-]+)?\.d\.ts$/;
const docMode = ts.JSDocParsingMode.ParseForTypeErrors;
const canonicalFileName = ts.createCompilerHost({}).getCanonicalFileName;
const noInputsCode = 18003;

// Limit filesystem probe reuse to a single one-shot run. Watch uses TypeScript's live host.
function cachePathTest(test: (filename: string) => boolean) {
  const results = new Map<string, boolean>();
  return (filename: string): boolean => {
    let exists = results.get(filename);
    if (exists === undefined) {
      exists = test(filename);
      results.set(filename, exists);
    }
    return exists;
  };
}

// Up to this many characters of file text stay cached, so a very large monorepo cannot exhaust the
// heap through it.
const maximumCachedCharacters = 64 * 1024 * 1024;

// Every config of a monorepo loads the shared packages again, so a one-shot run reads each file
// once. Files beyond the budget are read again on demand, which only costs time.
function cacheFileText(
  read: (filename: string) => string | undefined,
  preRead?: ReadonlyMap<string, string | undefined>,
) {
  const texts = new Map<string, string | undefined>();
  let cachedCharacters = 0;
  return (filename: string): string | undefined => {
    if (texts.has(filename)) return texts.get(filename);
    if (preRead) {
      const canonical = canonicalFileName(path.resolve(filename));
      if (preRead.has(canonical)) {
        const preReadText = preRead.get(canonical);
        texts.set(filename, preReadText);
        return preReadText;
      }
    }
    const text = read(filename);
    if (text !== undefined && cachedCharacters + text.length > maximumCachedCharacters) return text;
    texts.set(filename, text);
    cachedCharacters += text?.length ?? 0;
    return text;
  };
}

const preReadConcurrency = 32;

// Reads the project's source files concurrently before synchronous TypeScript program creation so
// disk IO does not serialize across thousands of files.
async function preReadSources({
  project,
  files = [],
}: {
  project?: string | string[];
  files?: readonly string[];
}): Promise<Map<string, string | undefined>> {
  const candidates = new Map<string, string>();
  const addCandidate = (filename: string) => {
    const resolved = path.resolve(filename);
    const canonical = canonicalFileName(resolved);
    if (!candidates.has(canonical)) candidates.set(canonical, resolved);
  };
  if (files.length) {
    for (const file of files) if (isSourceInput(file)) addCandidate(file);
  } else {
    try {
      for (const { config } of scanEntries(project)) {
        const parsed = ts.getParsedCommandLineOfConfigFile(
          config,
          {},
          { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} },
        );
        for (const file of parsed?.fileNames ?? []) if (isSourceInput(file)) addCandidate(file);
      }
    } catch {
      // Invalid or missing configs are surfaced by analyzeSources with its full error context.
    }
  }
  const entries = [...candidates.entries()];
  const result = new Map<string, string | undefined>();
  let totalCharacters = 0;
  let index = 0;
  const worker = async () => {
    while (index < entries.length) {
      const [canonical, resolved] = entries[index++];
      if (totalCharacters >= maximumCachedCharacters) break;
      try {
        const text = await fs.promises.readFile(resolved, 'utf8');
        if (totalCharacters + text.length <= maximumCachedCharacters) {
          totalCharacters += text.length;
          result.set(canonical, text);
        }
      } catch {
        // Unreadable files fall back to synchronous ts.sys.readFile.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(preReadConcurrency, entries.length) }, worker));
  return result;
}

// A workspace entry is looked up for every unresolved import of the package, and each lookup probes
// many candidate files.
function cacheWorkspaceEntries(): WorkspaceEntryFinder {
  const entries = new Map<string, string | undefined>();
  return (directory: string, subpath: string) => {
    const key = `${directory}\0${subpath}`;
    if (!entries.has(key)) entries.set(key, workspaceSourceEntry(directory, subpath));
    return entries.get(key);
  };
}

function packageNameOf(specifier: string) {
  const [first, second] = specifier.split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

// Imports of a sibling workspace package whose built entry is missing (or that is not linked into
// node_modules) fall back to its source, so rules still see the types it exports. Packages outside
// the repository are never guessed.
function resolveWorkspaceSources(
  host: CompilerHost,
  settings: CompilerOptions,
  workspacePackages: ReadonlyMap<string, string>,
  findWorkspaceEntry: WorkspaceEntryFinder,
) {
  const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), host.getCanonicalFileName, settings);
  host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, options, containingSource) =>
    literals.map((literal) => {
      const mode = ts.getModeForUsageLocation(containingSource, literal, options);
      const resolution = ts.resolveModuleName(
        literal.text,
        containingFile,
        options,
        host,
        cache,
        redirectedReference,
        mode,
      );
      if (resolution.resolvedModule || /^[./]/.test(literal.text) || path.isAbsolute(literal.text)) return resolution;
      const name = packageNameOf(literal.text);
      const directory = workspacePackages.get(name);
      const resolvedFileName = directory && findWorkspaceEntry(directory, literal.text.slice(name.length + 1));
      if (!resolvedFileName) return resolution;
      return {
        resolvedModule: {
          resolvedFileName,
          extension: ts.extensionFromPath(resolvedFileName),
          isExternalLibraryImport: false,
        },
      };
    });
}

function createHost(
  settings: CompilerOptions,
  sharedLibs: SharedLibs | undefined,
  probes: HostProbes,
  workspacePackages: ReadonlyMap<string, string> | undefined,
  findWorkspaceEntry: WorkspaceEntryFinder,
) {
  const host = ts.createCompilerHost(settings);
  Object.assign(host, probes);
  host.jsDocParsingMode = docMode;
  if (workspacePackages?.size) resolveWorkspaceSources(host, settings, workspacePackages, findWorkspaceEntry);
  if (!sharedLibs) return host;
  const loadSource = host.getSourceFile;
  host.getSourceFile = (filename, languageOptions, onError, forceNew) => {
    const isBundledLib =
      bundledLibPattern.test(path.basename(filename)) && path.dirname(path.resolve(filename)) === compilerLibDirectory;
    const isPackageDeclaration =
      filename.endsWith('.d.ts') && (filename.includes('/node_modules/') || filename.includes('\\node_modules\\'));
    if (!forceNew && (isBundledLib || isPackageDeclaration)) {
      let snapshot = sharedLibs.snapshots.get(filename);
      if (!snapshot) {
        const contents = host.readFile(filename);
        if (contents !== undefined) {
          snapshot = ts.ScriptSnapshot.fromString(contents);
          sharedLibs.snapshots.set(filename, snapshot);
        }
      }
      if (snapshot) {
        // The registry separates ASTs by compiler settings and module format. Only this
        // installation's bundled declarations are immutable for the duration of a scan.
        return sharedLibs.registry.acquireDocument(
          filename,
          settings,
          snapshot,
          ts.version,
          ts.ScriptKind.TS,
          languageOptions,
        );
      }
    }
    return loadSource(filename, languageOptions, onError, forceNew);
  };
  return host;
}

function diagnosticText(diagnostic: Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file || diagnostic.start === undefined) return message;
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return diagnostic.file.fileName + '(' + (line + 1) + ',' + (character + 1) + ') ' + message;
}

// Projects written for TypeScript 5 keep options the bundled compiler deprecates; analysis is
// unaffected.
const analysisOptions: CompilerOptions = { noEmit: true, ignoreDeprecations: '6.0' };

// A `types` entry that is not installed leaves only those globals unresolved; any other option
// error is fatal.
const missingTypeLibraryCode = 2688;

function reportMissingTypeLibraries(diagnostics: readonly Diagnostic[]) {
  const names = diagnostics.map((diagnostic) => /'([^']+)'/.exec(diagnosticText(diagnostic))?.[1]);
  console.error(
    `Note: type libraries not installed (${names.filter(Boolean).join(', ')}); analysis continued without them.`,
  );
}

function uninstalledBaseConfigs(parsed: ParsedCommandLine): Diagnostic[] {
  return parsed.errors.filter((diagnostic) => missingPackageBase(diagnostic) !== undefined);
}

// Each analyzer is { pillar, analyzeFile(program, sourceFile, policy, forEachSourceCandidate) }.
// With more than one, every finding is stamped with its pillar (see sourcePillarOf) so the caller can
// split the report. A lone analyzer leaves the split to each finding's rule id.
const performanceAnalyzers: SourceAnalyzer[] = [{ pillar: 'performance', analyzeFile }];
const reliabilityAnalyzer: SourceAnalyzer = { pillar: 'reliability', analyzeFile: analyzeReliabilityFile };
// Reliability needs the performance analyzer too, for the reliability rules it still finds.
const reliabilityAnalyzers: SourceAnalyzer[] = [...performanceAnalyzers, reliabilityAnalyzer];
// Nothing of accessibility lives in the performance analyzer, so `loadwise a11y` runs this one alone.
const accessibilityAnalyzer: SourceAnalyzer = { pillar: 'accessibility', analyzeFile: analyzeAccessibilityFile };

interface AnalyzerRun {
  readonly program: Program;
  readonly source: SourceFile;
  readonly file: string;
  readonly policy?: PerformancePolicy;
  readonly forEachSourceCandidate?: ProgramAdapter['forEachSourceCandidate'];
  readonly skippedFiles?: SkippedFile[];
  readonly analyzers: SourceAnalyzer[];
}

function runAnalyzers({
  program,
  source,
  file,
  policy,
  forEachSourceCandidate,
  skippedFiles,
  analyzers,
}: AnalyzerRun): Finding[] {
  const findings: Finding[] = [];
  for (const analyzer of analyzers) {
    // One failing analyzer must not hide the findings of the other files or analyzers.
    let analyzerFindings: Finding[];
    try {
      analyzerFindings = analyzer.analyzeFile(program, source, policy, forEachSourceCandidate);
    } catch (error) {
      if (!skippedFiles) throw error;
      const failure = error instanceof Error ? error.message : String(error);
      recordSkippedFile(
        skippedFiles,
        { file, reason: failure },
        `The ${analyzer.pillar} analysis of ${file} failed (${failure}). Skipped that file for that analyzer.`,
      );
      continue;
    }
    for (const finding of analyzerFindings) {
      finding.file = relativeToWorkingDirectory(finding.file ?? source.fileName);
      if (analyzers.length > 1) finding.pillar = sourcePillarOf(finding.ruleId, analyzer.pillar);
      findings.push(finding);
    }
  }
  return findings;
}

function analyzeProgram({
  program,
  inputs = program.getRootFileNames(),
  scanned = new Set<string>(),
  policy,
  forEachSourceCandidate,
  unresolvedPackages = new Set<string>(),
  analyzers = performanceAnalyzers,
  skippedFiles,
}: ProgramScanOptions): ScanResult {
  const optionErrors = program.getOptionsDiagnostics();
  const missingLibraries = optionErrors.filter((diagnostic) => diagnostic.code === missingTypeLibraryCode);
  const fatalErrors = optionErrors.filter((diagnostic) => diagnostic.code !== missingTypeLibraryCode);
  if (fatalErrors.length) throw new Error(fatalErrors.map(diagnosticText).join('\n'));
  if (missingLibraries.length) reportMissingTypeLibraries(missingLibraries);
  const findings: Finding[] = [];
  const localFiles = new Set<SourceFile>();
  const directory = program.getCurrentDirectory();
  for (const filename of inputs.filter(isSourceInput)) {
    const source = program.getSourceFile(filename);
    if (!source) throw new Error('Unable to load source: ' + filename);
    if (localFiles.has(source)) continue;
    const syntaxErrors = program.getSyntacticDiagnostics(source);
    const file = relativeToWorkingDirectory(source.fileName);
    // Without a list to record skips in (watch mode), invalid input still surfaces as an error.
    if (syntaxErrors.length) {
      if (!skippedFiles) throw new Error(syntaxErrors.map(diagnosticText).join('\n'));
      const reason = diagnosticText(syntaxErrors[0]);
      recordSkippedFile(skippedFiles, { file, reason }, `${reason} Skipped that file, which does not parse.`);
      continue;
    }
    collectUnresolvedPackages(program, source, unresolvedPackages);
    findings.push(...runAnalyzers({ program, source, file, policy, forEachSourceCandidate, skippedFiles, analyzers }));
    // Symlinked entry paths can resolve their relative imports differently.
    scanned.add(canonicalFileName(path.resolve(directory, source.fileName)));
    localFiles.add(source);
  }
  return { scannedFiles: scanned.size, findings: findings.sort(compareFindings) };
}

// Reliability rules that need no types also run on source files outside every analyzed program.
function standaloneReliabilityFindings(
  roots: ReadonlySet<string>,
  scanned: ReadonlySet<string>,
  analyzers: SourceScanOptions['analyzers'],
): Finding[] {
  if (!analyzers?.includes(reliabilityAnalyzer)) return [];
  const findings = standaloneFindings(roots, (file) => scanned.has(canonicalFileName(file)));
  for (const finding of findings) {
    finding.file = relativeToWorkingDirectory(finding.file ?? '');
    if (analyzers.length > 1) finding.pillar = sourcePillarOf(finding.ruleId, reliabilityAnalyzer.pillar);
  }
  return findings;
}

// `project` is one config or an array of them. `onlyFiles` limits the roots of each config to the changed files;
// imports still resolve through the config.
function analyzeSources({ project, files, policy, onlyFiles, analyzers, preRead }: SourceScanOptions): ScanResult {
  const findings: Finding[] = [];
  const scanned = new Set<string>();
  const configs = new Set<string>();
  const notedBases = new Set<string>();
  // Folders scanned with a config that leaves JavaScript out.
  const scopesWithoutJs = new Map<string, LeftOutScope>();
  // Folders whose files no program may have analyzed, listed once the programs are done.
  const standaloneRoots = new Set<string>();
  const referenceFindings = new Map<string, Finding>();
  const unresolvedPackages = new Set<string>();
  const skippedFiles: SkippedFile[] = [];
  const probes: HostProbes = {
    fileExists: cachePathTest(ts.sys.fileExists),
    directoryExists: cachePathTest(ts.sys.directoryExists),
    readFile: cacheFileText(ts.sys.readFile, preRead),
  };
  const findWorkspaceEntry = cacheWorkspaceEntries();
  let sharedLibs: SharedLibs | undefined;
  // Findings merge and schema tooling follow project references, not mere lib sharing.
  let usesReferences = false;
  const entries = files.length ? [] : scanEntries(project);
  const workspacePackages = entries.length ? workspacePackagesAround(path.dirname(entries[0].config)) : undefined;
  // Several configs can include the same file, which must report once.
  const sharesFilesAcrossConfigs = [project].flat().length > 1;
  const mergesFindings = sharesFilesAcrossConfigs || entries.some(({ companion }) => companion);

  function createSharedLibs(): SharedLibs {
    return {
      registry: ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, ts.sys.getCurrentDirectory(), docMode),
      snapshots: new Map<string, IScriptSnapshot>(),
    };
  }
  // Every program re-parses the lib.*.d.ts files unless several configs share them.
  if (entries.length > 1 || sharesFilesAcrossConfigs) sharedLibs = createSharedLibs();

  // `analyzes` picks the roots to report on; the others still load for types.
  function scan(roots: string[], options: CompilerOptions, analyzes: (filename: string) => boolean = () => true) {
    const inputs = roots.filter((filename: string) => isSourceInput(filename) && analyzes(filename));
    if (!inputs.length) return;
    const settings = { ...withoutEmitOptions(options), ...analysisOptions };
    const program = ts.createProgram(
      roots,
      settings,
      createHost(settings, sharedLibs, probes, workspacePackages, findWorkspaceEntry),
    );
    if (!files.length && !onlyFiles && !usesReferences && !sharesFilesAcrossConfigs) enableSchemaTooling(program);
    const { findings: programFindings } = analyzeProgram({
      program,
      inputs,
      scanned,
      policy,
      unresolvedPackages,
      analyzers,
      skippedFiles,
    });
    for (const finding of programFindings) {
      if (usesReferences || mergesFindings) {
        const key = `${canonicalFileName(finding.file ?? '')}\0${finding.line}\0${finding.column}\0${finding.ruleId}\0${finding.message}`;
        mergeFinding(referenceFindings, key, finding);
      } else findings.push(finding);
    }
  }

  function visitConfig(filename: string, scope?: string, companion?: boolean, explicit?: boolean): void {
    const canonical = fs.realpathSync(filename);
    if (configs.has(canonical)) return;
    configs.add(canonical);
    const parsed = ts.getParsedCommandLineOfConfigFile(
      filename,
      {},
      {
        ...ts.sys,
        ...probes,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
          throw new Error(diagnosticText(diagnostic));
        },
      },
    );
    if (!parsed) throw new Error('Unable to read project: ' + filename);
    const missingBases = uninstalledBaseConfigs(parsed);
    // `checkJs` turns JavaScript on when `allowJs` is unset. A discovered config that lists no inputs because it
    // leaves the JavaScript out still has that JavaScript checked, so TS18003 waits for the final source count.
    const allowsJs = parsed.options.allowJs ?? parsed.options.checkJs;
    const configErrors = parsed.errors.filter(
      (diagnostic) =>
        !missingBases.includes(diagnostic) && !(diagnostic.code === noInputsCode && !allowsJs && !explicit),
    );
    if (configErrors.length) throw new Error(configErrors.map(diagnosticText).join('\n'));
    for (const diagnostic of missingBases) {
      // Referenced projects usually share their bases, so each missing base is noted once.
      const base = missingPackageBase(diagnostic);
      if (base === undefined || notedBases.has(base)) continue;
      notedBases.add(base);
      console.error(
        `Note: ${diagnosticText(diagnostic)} Checked with this config's own settings until it is installed.`,
      );
    }
    if (parsed.projectReferences?.length) {
      usesReferences = true;
      sharedLibs ??= createSharedLibs();
    }
    for (const reference of parsed.projectReferences ?? []) {
      visitConfig(resolveConfig(ts.resolveProjectReferencePath(reference)), scope, false, explicit);
    }
    if (!allowsJs) {
      const jsScope = scope ?? path.dirname(filename);
      const leftOut = scopesWithoutJs.get(jsScope) ?? { configs: [], checksLeftOut: !explicit };
      leftOut.configs.push(filename);
      scopesWithoutJs.set(jsScope, leftOut);
    }
    standaloneRoots.add(scope ?? repositoryRoot(path.dirname(filename)));
    // The companion jsconfig only adds what the tsconfig left out.
    const isNew = (filename: string) => !companion || !scanned.has(canonicalFileName(path.resolve(filename)));
    scan(
      onlyFiles ? parsed.fileNames.filter(onlyFiles) : parsed.fileNames,
      parsed.options,
      (filename: string) => isInScope(scope, filename) && isNew(filename),
    );
  }

  // Explicit files, and JavaScript a config without `allowJs` leaves out, have no config of their own.
  const standaloneOptions: CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    jsx: ts.JsxEmit.Preserve,
    ...(policy && { strictNullChecks: true }),
  };
  if (files.length) {
    const paths = files.map((filename: string) => {
      if (!ts.sys.fileExists(filename) || !isSourceInput(filename)) {
        throw new Error('Expected an existing JS or TS source file: ' + filename);
      }
      return path.resolve(filename);
    });
    scan(paths, standaloneOptions);
  } else {
    for (const { config, scope, companion, explicit } of entries) visitConfig(config, scope, companion, explicit);
    const leftOut = unscannedJavaScript(
      scopesWithoutJs,
      (filename: string) => scanned.has(canonicalFileName(filename)),
      onlyFiles,
    );
    scan(leftOut.files, standaloneOptions);
    leftOut.note();
  }
  if (!scanned.size && !onlyFiles && !skippedFiles.length)
    throw new Error('No JavaScript or TypeScript source files to check.');
  for (const packageName of unresolvedPackages) console.error(formatMissingPackagesNote(packageName));
  const uninstalled = new Set<string>();
  for (const scope of new Set(entries.map(({ config, scope }) => scope ?? path.dirname(config)))) {
    collectUninstalledDependencies(scope, workspacePackages, uninstalled);
  }
  for (const packageName of uninstalled) {
    if (!unresolvedPackages.has(packageName)) console.error(formatUninstalledDependencyNote(packageName));
  }
  for (const finding of referenceFindings.values()) findings.push(finding);
  if (!files.length && !onlyFiles) findings.push(...standaloneReliabilityFindings(standaloneRoots, scanned, analyzers));
  return {
    scannedFiles: scanned.size,
    findings: findings.sort(compareFindings),
    ...(skippedFiles.length > 0 && { skippedFiles }),
  };
}

export {
  analysisOptions,
  analyzeProgram,
  analyzeSources,
  diagnosticText,
  preReadSources,
  resolveConfig,
  performanceAnalyzers,
  reliabilityAnalyzer,
  reliabilityAnalyzers,
  accessibilityAnalyzer,
};
